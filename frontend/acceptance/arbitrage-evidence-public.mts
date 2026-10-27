import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createWalletClient,
  erc20Abi,
  getAddress,
  http,
  maxUint256,
  parseAbi,
  parseEventLogs,
  parseUnits,
} from "viem";
import { ExchangeClient } from "../src/chain/client";
import type {
  ArbitrageResult,
  Deployment,
  Pool,
  Token,
} from "../src/chain/types";
import { scanArbitrage } from "../src/logic/arbitrage";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, root, until } from "./support/chain.mts";

const events = parseAbi([
  "event ArbitrageExecuted(address indexed trader,address indexed buyDex,address indexed sellDex,address tokenIn,uint256 amountIn,uint256 intermediateAmount,uint256 amountOut,uint256 profit)",
  "event PoolReservesChanged(address indexed exchange,uint256 indexed poolId,uint256 reserve0Before,uint256 reserve1Before,uint256 reserve0After,uint256 reserve1After)",
  "event Swap(uint256 indexed poolId,address indexed sender,address indexed tokenIn,uint256 amountIn,uint256 amountOut,address recipient)",
]);
const poolsAbi = parseAbi([
  "function pools(uint256) view returns (address token0,address token1,uint256 reserve0,uint256 reserve1,uint256 totalShares,uint256 createdAt)",
]);
const same = (a: string, b: string) => getAddress(a) === getAddress(b);
const serialize = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
const sourceFiles = [
  "frontend/src/generated/dex_logic.js",
  "frontend/src/chain/client.ts",
  "frontend/src/chain/arbitrage.ts",
  "frontend/src/wallet/session.ts",
  "frontend/src/logic/arbitrage.ts",
  "frontend/acceptance/arbitrage-evidence-public.mts",
  "frontend/acceptance/support/chain.mts",
];
const fingerprints = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(resolve(root, path)))
          .digest("hex"),
      ]),
    ),
  );

const sourceFingerprints = await fingerprints();
const kernelSha256 = sourceFingerprints[sourceFiles[0]];
if (process.env.DEX_EXPECTED_KERNEL_SHA256) {
  assert.equal(
    kernelSha256,
    process.env.DEX_EXPECTED_KERNEL_SHA256,
    "frozen production kernel",
  );
}
const environment = await isolatedChain("arbitrage-evidence-public");
const { accounts, read, deploy, artifact, directory } = environment;
const evidence: Record<string, unknown> = {
  status: "running",
  kernelSha256,
  sourceFingerprints,
  scenarios: [],
};
const scenarios = evidence.scenarios as unknown[];
let wallet: WalletController | undefined;
try {
  const tokenArtifact = await artifact("TestToken");
  const baseA = await deploy(tokenArtifact, ["Capital 18", "CAP18"]);
  const baseB = await deploy(tokenArtifact, ["Quote token", "QUOTE"]);
  const weth = await deploy(await artifact("WrappedEther"));
  const first = await deploy(await artifact("MiniDEX"), ["Evidence DEX A"]);
  const second = await deploy(await artifact("MiniDEX"), ["Evidence DEX B"]);
  const arbitrage = await deploy(await artifact("AtomicArbitrage"));
  const fixture = (
    await environment.fixtures("contracts/test/fixtures/PrecisionToken.sol")
  ).PrecisionToken;
  const six = await deploy(
    { abi: fixture.abi, bytecode: `0x${fixture.evm.bytecode.object}` },
    ["Capital 6", "CAP6", 6],
  );
  const deployment: Deployment = {
    schemaVersion: 1,
    chainId: 31337,
    rpcUrl: environment.rpcUrl,
    tokens: [
      {
        address: baseA,
        name: "Capital 18",
        symbol: "CAP18",
        kind: "faucet",
        decimals: 18,
      },
      {
        address: baseB,
        name: "Quote token",
        symbol: "QUOTE",
        kind: "faucet",
        decimals: 18,
      },
      {
        address: weth,
        name: "Wrapped Ether",
        symbol: "WETH",
        kind: "wrapped",
        decimals: 18,
      },
    ],
    exchanges: [
      { address: first, name: "Evidence DEX A" },
      { address: second, name: "Evidence DEX B" },
    ],
    arbitrage,
    bytecodes: { TestToken: tokenArtifact.bytecode },
  };
  const client = new ExchangeClient(deployment);
  await client.verifyDeployment();
  wallet = new WalletController(client, { storage: null });
  await wallet.start();
  const owner = accounts[1];
  wallet.dispatch({ kind: "select-local", address: owner });
  await until(
    () => wallet!.session(),
    (session) => !!session && same(session.address, owner),
    "selected evidence wallet",
  );
  const controller = wallet;
  const perform = (
    label: string,
    action: Parameters<WalletController["perform"]>[0]["perform"],
  ) => {
    const session = controller.session();
    assert(session);
    return controller.perform({ label, session, perform: action });
  };
  const ownerWallet = createWalletClient({
    account: owner,
    chain: environment.chain,
    transport: http(environment.rpcUrl),
  });
  const imported = await client.importToken(six);
  assert.equal(imported.decimals, 6);
  const tokens: Token[] = [...client.deployment.tokens, imported];
  const quote = tokens.find((token) => same(token.address, baseB));
  const capital18 = tokens.find((token) => same(token.address, baseA));
  assert(quote && capital18);
  await perform("Claim capital", (writer) => writer.faucet(capital18));
  await perform("Claim quote asset", (writer) => writer.faucet(quote));
  const mint = await ownerWallet.writeContract({
    address: six,
    abi: fixture.abi,
    functionName: "mint",
    args: [owner, parseUnits("10000", 6)],
  });
  assert.equal(
    (await read.waitForTransactionReceipt({ hash: mint })).status,
    "success",
  );

  const onchainPool = async (pool: Pool, blockNumber: bigint) => {
    const state = await read.readContract({
      address: getAddress(pool.exchange.address),
      abi: poolsAbi,
      functionName: "pools",
      args: [pool.id],
      blockNumber,
    });
    return { reserve0: state[2], reserve1: state[3] };
  };
  const tokenBalance = (token: Token, blockNumber: bigint) =>
    read.readContract({
      address: getAddress(token.address),
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
      blockNumber,
    });
  for (const capital of [capital18, imported]) {
    for (const [exchange, quoteAmount] of [
      [first, "1000"],
      [second, "2000"],
    ] as const) {
      await perform("Create evidence pool", (writer) =>
        writer.createPool(exchange, capital.address, quote.address),
      );
      const block = await read.getBlockNumber({ cacheTime: 0 });
      const pool = (await client.pools(Number(block))).find(
        (entry) =>
          same(entry.exchange.address, exchange) &&
          [entry.token0, entry.token1].some((address) =>
            same(address, capital.address),
          ),
      );
      assert(pool);
      const capitalAmount = parseUnits("1000", capital.decimals);
      const quoteUnits = parseUnits(quoteAmount, quote.decimals);
      await perform("Seed evidence pool", (writer) =>
        writer.addLiquidity(
          pool,
          same(pool.token0, capital.address) ? capitalAmount : quoteUnits,
          same(pool.token0, capital.address) ? quoteUnits : capitalAmount,
          50n,
        ),
      );
    }
    // Approval is a real, separately mined transaction before the fee observation window.
    const approvalHash = await ownerWallet.writeContract({
      address: getAddress(capital.address),
      abi: erc20Abi,
      functionName: "approve",
      args: [arbitrage, maxUint256],
    });
    const approvalReceipt = await read.waitForTransactionReceipt({
      hash: approvalHash,
    });
    assert.equal(approvalReceipt.status, "success");
    const beforeBlock = await read.getBlockNumber({ cacheTime: 0 });
    const beforePools = await client.pools(Number(beforeBlock));
    const selected = beforePools.find(
      (pool) =>
        same(pool.exchange.address, first) &&
        [pool.token0, pool.token1].some((address) =>
          same(address, capital.address),
        ),
    );
    assert(selected);
    const routes = scanArbitrage(
      selected,
      beforePools,
      capital.address,
      Number(beforeBlock),
      tokens,
    );
    assert(
      routes.length > 0,
      "the two real markets offer a capital-denominated opportunity",
    );
    const route = routes[0];
    const pools = [route.buy, route.sell];
    const [nativeBefore, balanceBefore, nonceBefore, reservesBefore] =
      await Promise.all([
        read.getBalance({ address: owner, blockNumber: beforeBlock }),
        tokenBalance(capital, beforeBlock),
        read.getTransactionCount({ address: owner, blockNumber: beforeBlock }),
        Promise.all(pools.map((pool) => onchainPool(pool, beforeBlock))),
      ]);
    let result: ArbitrageResult | undefined;
    await perform("Execute atomic evidence trade", async (writer) => {
      result = await writer.arbitrage(route, "0");
    });
    assert(result);
    assert.equal(typeof result.amountIn, "bigint");
    assert.equal(typeof result.amountOut, "bigint");
    assert.equal(typeof result.gasCostWei, "bigint");
    const receipt = await read.getTransactionReceipt({
      hash: result.receipt.transactionHash,
    });
    assert.equal(receipt.status, "success");
    assert.notEqual(receipt.transactionHash, approvalHash);
    assert(receipt.blockNumber > approvalReceipt.blockNumber);
    assert.deepEqual(result.receipt, receipt);
    const [nativeAfter, balanceAfter, nonceAfter, reservesAfter] =
      await Promise.all([
        read.getBalance({ address: owner, blockNumber: receipt.blockNumber }),
        tokenBalance(capital, receipt.blockNumber),
        read.getTransactionCount({
          address: owner,
          blockNumber: receipt.blockNumber,
        }),
        Promise.all(
          pools.map((pool) => onchainPool(pool, receipt.blockNumber)),
        ),
      ]);
    assert.equal(
      nonceAfter - nonceBefore,
      1,
      "only the atomic execute transaction was sent in the observation window",
    );
    assert.equal(
      result.gasCostWei,
      nativeBefore - nativeAfter,
      "actual ETH cost excludes the separately paid approval",
    );
    assert(result.gasCostWei > 0n);
    assert.equal(
      result.profit,
      balanceAfter - balanceBefore,
      "actual realized profit is in the capital ERC20 units",
    );
    assert(result.profit > 0n);
    const executed = parseEventLogs({
      abi: events,
      eventName: "ArbitrageExecuted",
      logs: receipt.logs,
    }).filter((log) => same(log.address, arbitrage));
    assert.equal(executed.length, 1);
    const event = executed[0].args;
    assert(same(event.trader, owner));
    assert(same(event.tokenIn, capital.address));
    assert(same(result.tokenIn, event.tokenIn));
    assert(same(event.buyDex, route.buy.exchange.address));
    assert(same(event.sellDex, route.sell.exchange.address));
    assert.equal(result.amountIn, event.amountIn);
    assert.equal(result.amountOut, event.amountOut);
    assert.equal(result.profit, event.profit);
    const transfers = parseEventLogs({
      abi: erc20Abi,
      eventName: "Transfer",
      logs: receipt.logs,
    }).filter((log) => same(log.address, capital.address));
    const debits = transfers.filter(
      (log) => same(log.args.from, owner) && same(log.args.to, arbitrage),
    );
    const credits = transfers.filter(
      (log) => same(log.args.from, arbitrage) && same(log.args.to, owner),
    );
    assert.equal(debits.length, 1);
    assert.equal(credits.length, 1);
    assert.equal(result.amountIn, debits[0].args.value);
    assert.equal(result.amountOut, credits[0].args.value);
    const swaps = parseEventLogs({
      abi: events,
      eventName: "Swap",
      logs: receipt.logs,
    });
    assert.equal(
      swaps.length,
      2,
      "both legs belong to the same execute receipt",
    );
    assert(
      swaps.every((log) => log.transactionHash === receipt.transactionHash),
    );
    const reserveEvents = parseEventLogs({
      abi: events,
      eventName: "PoolReservesChanged",
      logs: receipt.logs,
    }).filter((log) => same(log.address, arbitrage));
    assert.equal(reserveEvents.length, 2);
    assert.equal(result.before.length, 2);
    assert.equal(result.after.length, 2);
    for (const [index, pool] of pools.entries()) {
      const change = reserveEvents.find(
        (log) =>
          same(log.args.exchange, pool.exchange.address) &&
          log.args.poolId === pool.id,
      );
      assert(change);
      const swap = swaps.find(
        (log) =>
          same(log.address, pool.exchange.address) &&
          log.args.poolId === pool.id,
      );
      assert(swap);
      assert(same(swap.args.sender, arbitrage));
      assert.deepEqual(
        {
          reserve0: change.args.reserve0Before,
          reserve1: change.args.reserve1Before,
        },
        reservesBefore[index],
      );
      assert.deepEqual(
        {
          reserve0: change.args.reserve0After,
          reserve1: change.args.reserve1After,
        },
        reservesAfter[index],
      );
      const snapshots: [ArbitrageResult["before"], Pick<Pool, "reserve0" | "reserve1">][] = [
        [result.before, reservesBefore[index]],
        [result.after, reservesAfter[index]],
      ];
      for (const [snapshot, actual] of snapshots) {
        const entry = snapshot.find(
          (value) =>
            same(value.exchange.address, pool.exchange.address) &&
            value.id === pool.id,
        );
        assert(entry);
        assert.deepEqual(
          { reserve0: entry.reserve0, reserve1: entry.reserve1 },
          actual,
        );
      }
    }
    scenarios.push({
      decimals: capital.decimals,
      token: capital.address,
      approvalReceipt,
      beforeBlock,
      nativeBefore,
      nativeAfter,
      balanceBefore,
      balanceAfter,
      result,
      reservesBefore,
      reservesAfter,
    });
  }
  assert.deepEqual(
    await fingerprints(),
    sourceFingerprints,
    "loaded production sources stayed frozen throughout acceptance",
  );
  evidence.status = "passed";
  await writeFile(resolve(directory, "result.json"), serialize(evidence));
  console.log(
    JSON.stringify({
      status: "passed",
      scenarios: scenarios.length,
      kernelSha256,
      evidence: resolve(directory, "result.json"),
    }),
  );
} catch (error) {
  evidence.status = "failed";
  evidence.error = error instanceof Error ? error.stack : String(error);
  await writeFile(resolve(directory, "result.json"), serialize(evidence));
  throw error;
} finally {
  wallet?.stop();
  await environment.close();
}
