import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  Contract,
  FetchRequest,
  JsonRpcProvider,
  MaxUint256,
  formatEther,
  parseEther,
  isError,
  type ContractTransactionResponse,
  type InterfaceAbi,
  type JsonRpcSigner,
  type TransactionReceipt,
} from "ethers";

import type {
  MarketSnapshot,
  SimulationAction,
  SimulationArbitrage,
  SimulationMessage,
  SimulationProgress,
  SimulationReport,
  SimulationTransaction,
} from "./simulation-protocol.js";

type Deployment = {
  chainId: number;
  rpcUrl: string;
  tokens: { address: string; symbol: string; name: string }[];
  exchanges: { address: string; name: string }[];
  arbitrage: string;
  abis: Record<string, InterfaceAbi>;
};
type Route = {
  buy: number;
  sell: number;
  token: string;
  amount: bigint;
  expectedProfit: bigint;
};

const deploymentPath = fileURLToPath(
  new URL("../../shared/deployment.json", import.meta.url),
);
const reportPath = fileURLToPath(
  new URL("../../shared/simulation-report.json", import.meta.url),
);
const deployment: Deployment = JSON.parse(
  await readFile(deploymentPath, "utf8"),
);
const rpcRequest = new FetchRequest(
  process.env.LOCAL_RPC_URL ?? deployment.rpcUrl,
);
rpcRequest.timeout = 15_000;
const provider = new JsonRpcProvider(rpcRequest);
provider.pollingInterval = 100;
const rounds = Number(process.env.SIM_ROUNDS ?? 60);
const seed = Number(process.env.SIM_SEED ?? 2026);
const intervalMs = Number(process.env.SIM_INTERVAL_MS ?? 0);
const durationSeconds = Number(process.env.SIM_DURATION_SECONDS ?? 0);
if (
  !Number.isSafeInteger(rounds) ||
  rounds < 20 ||
  !Number.isSafeInteger(seed) ||
  !Number.isFinite(intervalMs) ||
  intervalMs < 0 ||
  !Number.isFinite(durationSeconds) ||
  durationSeconds < 0
) {
  throw new Error(
    "Simulation requires SIM_ROUNDS >= 20, integer SIM_SEED, and nonnegative interval/duration",
  );
}
if (Number((await provider.getNetwork()).chainId) !== deployment.chainId) {
  throw new Error(
    "Simulation chain does not match shared/deployment.json; redeploy to the selected RPC",
  );
}
const signers = (await provider.listAccounts()).slice(0, 20);
if (signers.length !== 20)
  throw new Error("Simulation needs 20 unlocked local RPC accounts");
const addresses = await Promise.all(
  signers.map((signer) => signer.getAddress()),
);
const dex = deployment.exchanges.map(
  (item) => new Contract(item.address, deployment.abis.MiniDEX, provider),
);
if (dex.length < 2)
  throw new Error("Simulation requires two deployed exchanges");
const tokens = deployment.tokens
  .slice(0, 2)
  .map(
    (item) => new Contract(item.address, deployment.abis.TestToken, provider),
  );
const poolIds = await Promise.all(
  dex.map(
    (exchange) =>
      exchange.getPool(
        deployment.tokens[0].address,
        deployment.tokens[1].address,
      ) as Promise<bigint>,
  ),
);
// Check the actual preparation calls before approving or displacing either pool.
const [etherBalances, seedBalance, capitalBalances] = await Promise.all([
  Promise.all(addresses.map((address) => provider.getBalance(address))),
  tokens[0].balanceOf(addresses[1]) as Promise<bigint>,
  Promise.all(tokens.map((token) => token.balanceOf(addresses[19]) as Promise<bigint>)),
]);
const noGas = addresses.filter((_, index) => etherBalances[index] === 0n);
if (noGas.length)
  throw new Error(`Simulation accounts have no ETH for gas: ${noGas.join(", ")}. Claim test ETH in the wallet before starting.`);
if (seedBalance < parseEther("1000"))
  throw new Error(`Account 2 (${addresses[1]}) needs 1000 ${deployment.tokens[0].symbol} for the initial price displacement. Claim test tokens in the wallet before starting.`);
if (capitalBalances.every((balance) => balance < parseEther("1")))
  throw new Error(`Account 20 (${addresses[19]}) needs at least 1 ${deployment.tokens[0].symbol} or ${deployment.tokens[1].symbol}, the smallest scanned arbitrage input. Claim test tokens in the wallet before starting.`);
if (poolIds.some((id) => id === 0n))
  throw new Error("Deploy seeded A/B pools before running the simulation");
const arb = new Contract(
  deployment.arbitrage,
  deployment.abis.AtomicArbitrage,
  provider,
);
const transactions: SimulationTransaction[] = [];
const arbitrages: SimulationArbitrage[] = [];
const positions: { exchange: number; id: bigint }[][] = addresses.map(() => []);
const actionCounts = {
  swap: 0,
  addLiquidity: 0,
  removeLiquidity: 0,
  arbitrage: 0,
};
let state = seed >>> 0;
let stopRequested = false;
let completedRounds = 0;
let phase: SimulationProgress["phase"] = "preparing";
const startedAt = new Date().toISOString();
const started = Date.now();
const marketHistory: MarketSnapshot[][] = [];
process.on("message", (message: unknown) => {
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "stop"
  )
    stopRequested = true;
});
process.on("SIGTERM", () => {
  stopRequested = true;
});
async function publish(message: SimulationMessage): Promise<void> {
  if (!process.connected) return;
  // The IPC write is asynchronous: disconnecting before its callback can drop a complete report.
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
async function publishProgress() {
  if (!process.connected) return;
  const accountOperations: Record<string, number> = Object.fromEntries(
    addresses.map((address) => [address, 0]),
  );
  for (const transaction of transactions) {
    if (transaction.status === 1 && transaction.action !== "approve")
      accountOperations[transaction.account]++;
  }
  const profits = deployment.tokens.slice(0, 2).map((token) => ({
    token: token.address,
    symbol: token.symbol,
    amount: arbitrages
      .filter(
        (item) =>
          item.capitalToken.toLowerCase() === token.address.toLowerCase(),
      )
      .reduce((total, item) => total + BigInt(item.profit), 0n)
      .toString(),
  }));
  const markets = await snapshot();
  const latest = marketHistory.at(-1);
  if (
    !latest ||
    markets.some(
      (market, index) =>
        market.reserve0 !== latest[index].reserve0 ||
        market.reserve1 !== latest[index].reserve1,
    )
  ) {
    marketHistory.push(markets);
    if (marketHistory.length > 120) marketHistory.shift();
  }
  await publish({
    type: "progress",
    progress: {
      startedAt,
      elapsedSeconds: (Date.now() - started) / 1000,
      completedRounds,
      requestedRounds: rounds,
      requestedDurationSeconds: durationSeconds,
      phase,
      accounts: addresses,
      activeAccounts: Object.values(accountOperations).filter(
        (count) => count > 0,
      ).length,
      accountOperations,
      counts: { ...actionCounts },
      transactionCount: transactions.length,
      transactions: transactions.slice(-100),
      markets,
      marketHistory: [...marketHistory],
      arbitrages: arbitrages.slice(-20),
      profits,
    },
  });
}
function random() {
  state = (Math.imul(1664525, state) + 1013904223) >>> 0;
  return state / 0x100000000;
}
async function deadline() {
  // An idle local chain's last mined block can lag the pending execution clock by more than 300s.
  // ethers' mined-block formatter rejects pending blocks whose block number is null.
  const block = (await provider.send("eth_getBlockByNumber", [
    "pending",
    false,
  ])) as { timestamp: string } | null;
  if (!block) throw new Error("Local chain has no pending execution block");
  return BigInt(block.timestamp) + 300n;
}
async function confirmed(
  action: SimulationAction,
  signer: JsonRpcSigner,
  pending: Promise<ContractTransactionResponse>,
) {
  const tx = await pending;
  let receipt: TransactionReceipt | null;
  try {
    receipt = await tx.wait(1, 30_000);
  } catch (error) {
    // DEFENSE: ethers rejects wait() for a mined revert; its actual receipt is still execution evidence.
    if (isError(error, "CALL_EXCEPTION") && error.receipt?.status === 0)
      await recordTransaction(action, await signer.getAddress(), error.receipt);
    throw error;
  }
  if (!receipt || receipt.status !== 1)
    throw new Error(`Simulation transaction did not succeed: ${tx.hash}`);
  await recordTransaction(action, await signer.getAddress(), receipt);
  return receipt;
}
async function recordTransaction(action: SimulationAction, account: string, receipt: TransactionReceipt) {
  const transaction: SimulationTransaction = {
    action,
    account,
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    status: receipt.status!,
  };
  if (receipt.status === 1 && (action === "addLiquidity" || action === "removeLiquidity")) {
    const name = action === "addLiquidity" ? "LiquidityAdded" : "LiquidityRemoved";
    for (const log of receipt.logs) {
      const exchange = deployment.exchanges.findIndex((item) => item.address.toLowerCase() === log.address.toLowerCase());
      if (exchange < 0) continue;
      const event = dex[exchange].interface.parseLog({ topics: [...log.topics], data: log.data });
      if (event?.name === name)
        transaction.liquidity = { exchange: log.address, poolId: event.args.poolId.toString(), positionId: event.args.positionId.toString() };
    }
  }
  transactions.push(transaction);
  // Publish each received confirmation before the worker can start another chain write.
  // KNOWN LIMITATION: a killed process or timed-out receipt wait can leave the final submission absent; this journal is not a chain rescan.
  await publish({ type: "transaction", transaction });
}
async function approve(
  tokenAddress: string,
  spender: string,
  signer: JsonRpcSigner,
  required: bigint,
) {
  const token = new Contract(tokenAddress, deployment.abis.TestToken, signer);
  if ((await token.allowance(await signer.getAddress(), spender)) < required) {
    await confirmed("approve", signer, token.approve(spender, MaxUint256));
  }
}
async function snapshot() {
  return Promise.all(
    dex.map(async (exchange, index) => {
      const pool = await exchange.pools(poolIds[index]);
      return {
        exchange: deployment.exchanges[index].name,
        address: deployment.exchanges[index].address,
        poolId: poolIds[index].toString(),
        token0: pool.token0,
        token1: pool.token1,
        reserve0: pool.reserve0.toString(),
        reserve1: pool.reserve1.toString(),
        reserve0Formatted: formatEther(pool.reserve0),
        reserve1Formatted: formatEther(pool.reserve1),
        priceToken1PerToken0:
          Number(formatEther(pool.reserve1)) /
          Number(formatEther(pool.reserve0)),
      };
    }),
  );
}
async function swap(
  account: number,
  exchange: number,
  tokenIndex: number,
  amount: bigint,
) {
  const signer = signers[account];
  const token = tokens[tokenIndex];
  await approve(
    await token.getAddress(),
    deployment.exchanges[exchange].address,
    signer,
    amount,
  );
  const output = (await dex[exchange].quote(
    poolIds[exchange],
    await token.getAddress(),
    amount,
  )) as bigint;
  await confirmed(
    "swap",
    signer,
    (dex[exchange].connect(signer) as Contract).swap(
      poolIds[exchange],
      await token.getAddress(),
      amount,
      (output * 99n) / 100n,
      addresses[account],
      await deadline(),
    ),
  );
  actionCounts.swap++;
}
async function addLiquidity(account: number, exchange: number) {
  const signer = signers[account];
  const pool = await dex[exchange].pools(poolIds[exchange]);
  const amount0 = parseEther(String(5 + Math.floor(random() * 20)));
  const amount1 = (amount0 * pool.reserve1) / pool.reserve0;
  await approve(
    pool.token0,
    deployment.exchanges[exchange].address,
    signer,
    amount0,
  );
  await approve(
    pool.token1,
    deployment.exchanges[exchange].address,
    signer,
    amount1,
  );
  const receipt = await confirmed(
    "addLiquidity",
    signer,
    (dex[exchange].connect(signer) as Contract).addLiquidity(
      poolIds[exchange],
      amount0,
      amount1,
      (amount0 * 99n) / 100n,
      (amount1 * 99n) / 100n,
      await deadline(),
    ),
  );
  // ERC20 and ERC721 Transfer share a signature but use different indexing; decode only the NFT issuer.
  const mint = receipt.logs
    .filter(
      (log) =>
        log.address.toLowerCase() ===
        deployment.exchanges[exchange].address.toLowerCase(),
    )
    .map((log) =>
      dex[exchange].interface.parseLog({
        topics: [...log.topics],
        data: log.data,
      }),
    )
    .find(
      (event) =>
        event?.name === "Transfer" &&
        event.args[0] === "0x0000000000000000000000000000000000000000",
    );
  if (!mint) throw new Error("addLiquidity did not mint an ERC721 position");
  positions[account].push({ exchange, id: mint.args[2] as bigint });
  actionCounts.addLiquidity++;
}
async function removeLiquidity(account: number) {
  const position = positions[account].pop();
  if (!position)
    throw new Error("Simulation attempted to remove an unowned position");
  const pool = await dex[position.exchange].pools(poolIds[position.exchange]);
  const record = await dex[position.exchange].positions(position.id);
  const min0 =
    (((BigInt(pool.reserve0) * BigInt(record.shares)) /
      BigInt(pool.totalShares)) *
      99n) /
    100n;
  const min1 =
    (((BigInt(pool.reserve1) * BigInt(record.shares)) /
      BigInt(pool.totalShares)) *
      99n) /
    100n;
  await confirmed(
    "removeLiquidity",
    signers[account],
    (
      dex[position.exchange].connect(signers[account]) as Contract
    ).removeLiquidity(position.id, min0, min1, await deadline()),
  );
  actionCounts.removeLiquidity++;
}
async function findArbitrage(): Promise<Route | undefined> {
  let best: Route | undefined;
  const arbitrageur = addresses[19];
  for (const buy of [0, 1]) {
    const sell = 1 - buy;
    const pool = await dex[buy].pools(poolIds[buy]);
    for (const token of [pool.token0 as string, pool.token1 as string]) {
      const balance = (await new Contract(
        token,
        deployment.abis.TestToken,
        provider,
      ).balanceOf(arbitrageur)) as bigint;
      for (const units of [1, 5, 10, 25, 50, 100, 250, 500]) {
        const amount = parseEther(String(units));
        if (amount > balance) continue;
        const intermediate = (await dex[buy].quote(
          poolIds[buy],
          token,
          amount,
        )) as bigint;
        const otherToken =
          token.toLowerCase() === pool.token0.toLowerCase()
            ? pool.token1
            : pool.token0;
        const output = (await dex[sell].quote(
          poolIds[sell],
          otherToken,
          intermediate,
        )) as bigint;
        const expectedProfit = output - amount;
        if (
          expectedProfit > parseEther("0.000001") &&
          (!best || expectedProfit > best.expectedProfit)
        ) {
          best = { buy, sell, token, amount, expectedProfit };
        }
      }
    }
  }
  return best;
}
async function executeArbitrage(route: Route) {
  const signer = signers[19];
  const token = new Contract(route.token, deployment.abis.TestToken, provider);
  await approve(route.token, deployment.arbitrage, signer, route.amount);
  const before = await snapshot();
  const balanceBefore = (await token.balanceOf(addresses[19])) as bigint;
  const minProfit = (route.expectedProfit * 95n) / 100n;
  const receipt = await confirmed(
    "arbitrage",
    signer,
    (arb.connect(signer) as Contract).execute(
      deployment.exchanges[route.buy].address,
      poolIds[route.buy],
      deployment.exchanges[route.sell].address,
      poolIds[route.sell],
      route.token,
      route.amount,
      minProfit,
      await deadline(),
    ),
  );
  const balanceAfter = (await token.balanceOf(addresses[19])) as bigint;
  const profit = balanceAfter - balanceBefore;
  if (profit <= 0n || profit < minProfit)
    throw new Error("Atomic arbitrage failed its external profit requirement");
  arbitrages.push({
    hash: receipt.hash,
    capitalToken: route.token,
    amountIn: route.amount.toString(),
    profit: profit.toString(),
    profitFormatted: formatEther(profit),
    expectedProfit: route.expectedProfit.toString(),
    buyExchange: deployment.exchanges[route.buy].name,
    sellExchange: deployment.exchanges[route.sell].name,
    gasUsed: receipt.gasUsed.toString(),
    gasCostWei: receipt.fee.toString(),
    profitExcludesGas: true,
    before,
    after: await snapshot(),
  });
  actionCounts.arbitrage++;
  console.log(
    `Atomic arbitrage ${receipt.hash}: profit ${formatEther(profit)} tokens (before gas)`,
  );
}
async function verifyRollback() {
  const signer = signers[19];
  const token = deployment.tokens[0].address;
  await approve(token, deployment.arbitrage, signer, parseEther("1"));
  const balances = async () =>
    Promise.all(
      tokens.map(async (item) => ({
        token: await item.getAddress(),
        caller: (await item.balanceOf(addresses[19])).toString(),
        arbitrage: (await item.balanceOf(deployment.arbitrage)).toString(),
      })),
    );
  const before = { pools: await snapshot(), balances: await balances() };
  // An impossible minimum profit intentionally reverts after the two swaps.
  const nonce = (await provider.send("eth_getTransactionCount", [
    addresses[19],
    "pending",
  ])) as string;
  let receipt;
  try {
    const transaction = await (arb.connect(signer) as Contract).execute(
      deployment.exchanges[0].address,
      poolIds[0],
      deployment.exchanges[1].address,
      poolIds[1],
      token,
      parseEther("1"),
      MaxUint256,
      await deadline(),
      { gasLimit: 2_000_000 },
    );
    receipt = await transaction.wait(1, 30_000);
  } catch (error) {
    if (isError(error, "CALL_EXCEPTION") && error.receipt?.status === 0) {
      receipt = error.receipt;
    } else if (
      isError(error, "UNKNOWN_ERROR") &&
      (error.error as Error & { code?: number })?.code === 3 &&
      String(error.error?.message).includes("Arbitrage: insufficient profit")
    ) {
      // DEFENSE: Hardhat mines reverted eth_sendTransaction calls but returns an RPC error without the transaction hash.
      const block = (await provider.send("eth_getBlockByNumber", [
        "latest",
        true,
      ])) as {
        transactions: {
          hash: string;
          from: string;
          to: string;
          nonce: string;
        }[];
      };
      const mined = block.transactions.find(
        (tx) =>
          tx.from.toLowerCase() === addresses[19].toLowerCase() &&
          tx.to.toLowerCase() === deployment.arbitrage.toLowerCase() &&
          BigInt(tx.nonce) === BigInt(nonce),
      );
      if (!mined)
        throw new Error(
          "Expected reverted arbitrage was not found in the latest block",
          { cause: error },
        );
      receipt = await provider.getTransactionReceipt(mined.hash);
    } else {
      throw error;
    }
  }
  if (!receipt || receipt.status !== 0)
    throw new Error("Impossible-profit transaction did not revert");
  const after = { pools: await snapshot(), balances: await balances() };
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("Failed arbitrage changed reserves or token balances");
  await recordTransaction("expectedArbitrageRevert", addresses[19], receipt);
  return {
    hash: receipt.hash,
    status: 0,
    reservesAndTokenBalancesUnchanged: true,
    before,
    after,
  };
}

const initial = await snapshot();
await publishProgress();
console.log(`Simulation seed=${seed}; ${rounds} rounds; 20 funded accounts`);
// Create a reproducible opportunity before the random workload, including on repeat runs.
await swap(1, 0, 0, parseEther("1000"));
const initialRoute = await findArbitrage();
if (!initialRoute)
  throw new Error(
    "Seeded price displacement did not produce an arbitrage opportunity",
  );
await executeArbitrage(initialRoute);
phase = "trading";
while (
  !stopRequested &&
  (completedRounds < rounds ||
    (durationSeconds > 0 && Date.now() - started < durationSeconds * 1000))
) {
  const account = completedRounds % 20;
  const exchange = random() < 0.5 ? 0 : 1;
  const choice = random();
  if (choice < 0.5) {
    await swap(
      account,
      exchange,
      random() < 0.5 ? 0 : 1,
      parseEther(String(1 + Math.floor(random() * 45))),
    );
  } else if (choice < 0.75 || positions[account].length === 0) {
    await addLiquidity(account, exchange);
  } else {
    await removeLiquidity(account);
  }
  completedRounds++;
  if (completedRounds % 10 === 0) {
    const route = await findArbitrage();
    if (route) await executeArbitrage(route);
    console.log(
      `Completed ${completedRounds} rounds; swaps=${actionCounts.swap}, adds=${actionCounts.addLiquidity}, removes=${actionCounts.removeLiquidity}`,
    );
  }
  await publishProgress();
  if (intervalMs > 0 && !stopRequested)
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
phase = "redeeming";
await publishProgress();
// Close every simulated position so redemption and fee participation are exercised even on short runs.
for (let account = 0; account < 20; account++) {
  while (positions[account].length > 0) {
    await removeLiquidity(account);
    await publishProgress();
  }
}
phase = "verifying";
await publishProgress();
const rollback = await verifyRollback();
const activeAccounts = new Set(
  transactions
    .filter((tx) => tx.status === 1 && tx.action !== "approve")
    .map((tx) => tx.account),
);
if (!stopRequested && activeAccounts.size !== 20)
  throw new Error("Not all 20 accounts participated in the workload");
const report: SimulationReport = {
  version: 1,
  status: stopRequested ? "stopped" : "completed",
  chainId: deployment.chainId,
  startedAt,
  finishedAt: new Date().toISOString(),
  elapsedSeconds: (Date.now() - started) / 1000,
  seed,
  requestedRounds: rounds,
  completedRounds,
  requestedDurationSeconds: durationSeconds,
  intervalMs,
  accounts: addresses,
  activeAccounts: activeAccounts.size,
  counts: actionCounts,
  initial,
  final: await snapshot(),
  arbitrages,
  rollback,
  transactions,
  transactionCount: transactions.length,
};
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      reportPath,
      completedRounds,
      activeAccounts: activeAccounts.size,
      counts: actionCounts,
      transactions: transactions.length,
      rollbackVerified: true,
    },
    null,
    2,
  ),
);
await publishProgress();
await publish({ type: "finished", report });
await provider.destroy();
if (process.connected) process.disconnect();
