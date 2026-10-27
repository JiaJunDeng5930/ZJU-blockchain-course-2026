import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createWalletClient,
  erc20Abi,
  getAddress,
  http,
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
import { miniDexAbi } from "../src/generated/abis";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, root, until } from "./support/chain.mts";

const same = (left: string, right: string) =>
  getAddress(left) === getAddress(right);
const serialize = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? String(item) : item),
    2,
  );
const environment = await isolatedChain("arbitrage-capital-public");
const { read, deploy, artifact, accounts, directory, rpc } = environment;
const sourceFiles = [
  "frontend/src/generated/dex_logic.js",
  "frontend/src/chain/client.ts",
  "frontend/src/chain/arbitrage.ts",
  "frontend/src/logic/arbitrage.ts",
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
const evidence: Record<string, unknown> = {
  status: "running",
  kernelSha256: sourceFingerprints[sourceFiles[0]],
  sourceFingerprints,
  scenarios: [],
};
if (process.env.DEX_EXPECTED_KERNEL_SHA256)
  assert.equal(evidence.kernelSha256, process.env.DEX_EXPECTED_KERNEL_SHA256);
const scenarios = evidence.scenarios as Record<string, unknown>[];
let controller: WalletController | undefined;
try {
  const tokenArtifact = await artifact("TestToken");
  const cap18 = await deploy(tokenArtifact, ["Explicit capital 18", "CAP18"]);
  const quoteAddress = await deploy(tokenArtifact, ["Quote asset", "QUOTE"]);
  const weth = await deploy(await artifact("WrappedEther"));
  const first = await deploy(await artifact("MiniDEX"), ["Capital DEX A"]);
  const second = await deploy(await artifact("MiniDEX"), ["Capital DEX B"]);
  const arbitrage = await deploy(await artifact("AtomicArbitrage"));
  const fixture = (
    await environment.fixtures("contracts/test/fixtures/PrecisionToken.sol")
  ).PrecisionToken;
  const cap6 = await deploy(
    { abi: fixture.abi, bytecode: `0x${fixture.evm.bytecode.object}` },
    ["Explicit capital 6", "CAP6", 6],
  );
  const deployment: Deployment = {
    schemaVersion: 1,
    chainId: 31337,
    rpcUrl: environment.rpcUrl,
    tokens: [
      {
        address: cap18,
        name: "Explicit capital 18",
        symbol: "CAP18",
        kind: "faucet",
        decimals: 18,
      },
      {
        address: quoteAddress,
        name: "Quote asset",
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
      { address: first, name: "Capital DEX A" },
      { address: second, name: "Capital DEX B" },
    ],
    arbitrage,
    bytecodes: { TestToken: tokenArtifact.bytecode },
  };
  const client = new ExchangeClient(deployment);
  await client.verifyDeployment();
  controller = new WalletController(client, { storage: null });
  await controller.start();
  const owner = accounts[1];
  const select = async (address: string) => {
    controller!.dispatch({ kind: "select-local", address });
    await until(
      () => controller!.session(),
      (session) => !!session && same(session.address, address),
      "explicit-capital account selection",
    );
  };
  const perform = (
    label: string,
    action: Parameters<WalletController["perform"]>[0]["perform"],
  ) => {
    const session = controller!.session();
    assert(session);
    return controller!.perform({ label, session, perform: action });
  };
  await select(owner);
  const capital18 = deployment.tokens[0];
  const quote = deployment.tokens[1];
  const capital6 = await client.importToken(cap6);
  assert.equal(capital6.decimals, 6);
  const tokens = [...deployment.tokens, capital6];
  for (const token of [capital18, quote])
    await perform("Claim fixture asset", (writer) => writer.faucet(token));
  const ownerWallet = createWalletClient({
    account: owner,
    chain: environment.chain,
    transport: http(environment.rpcUrl),
  });
  const mint = await ownerWallet.writeContract({
    address: cap6,
    abi: fixture.abi,
    functionName: "mint",
    args: [owner, parseUnits("10000", 6)],
  });
  assert.equal(
    (await read.waitForTransactionReceipt({ hash: mint })).status,
    "success",
  );
  const currentBlock = async () =>
    BigInt((await rpc("eth_blockNumber")) as string);
  const pools = async () => client.pools(Number(await currentBlock()));
  const poolFor = (entries: Pool[], capital: Token, exchange: string) => {
    const pool = entries.find(
      (entry) =>
        same(entry.exchange.address, exchange) &&
        [entry.token0, entry.token1].some((address) =>
          same(address, capital.address),
        ),
    );
    assert(pool);
    return pool;
  };
  const balance = (token: Token, address: string, blockNumber: bigint) =>
    read.readContract({
      address: getAddress(token.address),
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(address)],
      blockNumber,
    });
  const reserves = (pool: Pool, blockNumber: bigint) =>
    read.readContract({
      address: getAddress(pool.exchange.address),
      abi: miniDexAbi,
      functionName: "pools",
      args: [pool.id],
      blockNumber,
    });
  for (const capital of [capital18, capital6]) {
    for (const [exchange, quoteAmount] of [
      [first, "1000"],
      [second, capital.decimals === 6 ? "2000" : "1000"],
    ] as const) {
      await perform("Create capital pair", (writer) =>
        writer.createPool(exchange, capital.address, quote.address),
      );
      const pool = poolFor(await pools(), capital, exchange);
      const capitalRaw = parseUnits("1000", capital.decimals);
      const quoteRaw = parseUnits(quoteAmount, quote.decimals);
      await perform("Fund capital pair", (writer) =>
        writer.addLiquidity(
          pool,
          same(pool.token0, capital.address) ? capitalRaw : quoteRaw,
          same(pool.token0, capital.address) ? quoteRaw : capitalRaw,
          50n,
        ),
      );
    }
  }
  const selected18 = poolFor(await pools(), capital18, first);
  const equalBlock = await currentBlock();
  assert.deepEqual(
    await client.quoteArbitrage(
      selected18,
      capital18.address,
      "7.123456789012345678",
      tokens,
    ),
    [],
    "equal-price funded markets offer no profitable two-swap route after fees",
  );
  assert.equal(
    await currentBlock(),
    equalBlock,
    "a quote does not mine a transaction",
  );
  scenarios.push({
    name: "Fixed-capital quotes report no route between equal-price funded pools",
    block: equalBlock,
  });

  const selected6 = poolFor(await pools(), capital6, first);
  const automaticRoutes = await client.opportunities(
    selected6,
    await pools(),
    capital6.address,
    tokens,
  );
  assert(
    automaticRoutes.length > 0,
    "automatic simulation scanning remains available separately from exact-capital quoting",
  );
  evidence.automaticRouteCount = automaticRoutes.length;
  const invalidBlock = await currentBlock();
  for (const [capital, selected, values] of [
    [
      capital18,
      selected18,
      ["", "0", "-1", "not an amount", "1e3", "0.0000000000000000001"],
    ],
    [capital6, selected6, ["0.0000001", "7.1234567"]],
  ] as const) {
    for (const value of values)
      await assert.rejects(
        () => client.quoteArbitrage(selected, capital.address, value, tokens),
        `invalid capital ${JSON.stringify(value)} must not fall back to sampled amounts`,
      );
  }
  assert.equal(await currentBlock(), invalidBlock);
  scenarios.push({
    name: "Empty, zero, invalid and over-precision amounts reject without automatic-size fallback",
    rejectedInputs: 8,
    block: invalidBlock,
  });

  const selectedSecond18 = poolFor(await pools(), capital18, second);
  const approve = await ownerWallet.writeContract({
    address: getAddress(quote.address),
    abi: erc20Abi,
    functionName: "approve",
    args: [getAddress(second), parseUnits("200", 18)],
  });
  await read.waitForTransactionReceipt({ hash: approve });
  const timestamp = (await read.getBlock({ blockTag: "latest" })).timestamp;
  const skew = await ownerWallet.writeContract({
    address: getAddress(second),
    abi: miniDexAbi,
    functionName: "swap",
    args: [
      selectedSecond18.id,
      getAddress(quote.address),
      parseUnits("200", 18),
      0n,
      owner,
      timestamp + 1200n,
    ],
  });
  assert.equal(
    (await read.waitForTransactionReceipt({ hash: skew })).status,
    "success",
  );

  const events = parseAbi([
    "event ArbitrageExecuted(address indexed trader,address indexed buyDex,address indexed sellDex,address tokenIn,uint256 amountIn,uint256 intermediateAmount,uint256 amountOut,uint256 profit)",
    "event Swap(uint256 indexed poolId,address indexed sender,address indexed tokenIn,uint256 amountIn,uint256 amountOut,address recipient)",
    "event Approval(address indexed owner,address indexed spender,uint256 value)",
  ]);
  for (const [capital, exactAmount, secondAmount] of [
    [capital18, "7.123456789012345678", "3.25"],
    [capital6, "7.123456", "3.250001"],
  ] as const) {
    const selected = poolFor(await pools(), capital, first);
    const [routes, changedRoutes] = await Promise.all([
      client.quoteArbitrage(selected, capital.address, exactAmount, tokens),
      client.quoteArbitrage(selected, capital.address, secondAmount, tokens),
    ]);
    assert(
      routes.length > 0 && changedRoutes.length > 0,
      "both exact input amounts have a profitable quoted route",
    );
    const exactRaw = parseUnits(exactAmount, capital.decimals);
    assert(
      routes.every((route) => route.amountIn === exactRaw),
      "every candidate uses the requested raw capital",
    );
    assert(
      changedRoutes.every(
        (route) =>
          route.amountIn === parseUnits(secondAmount, capital.decimals),
      ),
      "a changed draft obtains its own exact-capital candidates",
    );
    assert.equal(
      routes[0].amountIn,
      exactRaw,
      "a later quote does not mutate an earlier reviewed opportunity",
    );
    const route = routes[0];
    const unfunded = accounts[2];
    await select(unfunded);
    const unfundedBlock = await currentBlock();
    const unfundedNonce = await read.getTransactionCount({
      address: unfunded,
      blockNumber: unfundedBlock,
    });
    assert.equal(await balance(capital, unfunded, unfundedBlock), 0n);
    await assert.rejects(() =>
      perform("Reject unaffordable capital", (writer) =>
        writer.arbitrage(route, "0"),
      ),
    );
    assert.equal(
      await currentBlock(),
      unfundedBlock,
      "unaffordable capital cannot send approval or execution",
    );
    assert.equal(
      await read.getTransactionCount({ address: unfunded, blockTag: "latest" }),
      unfundedNonce,
    );
    assert.equal(
      await read.readContract({
        address: getAddress(capital.address),
        abi: erc20Abi,
        functionName: "allowance",
        args: [unfunded, getAddress(arbitrage)],
      }),
      0n,
    );
    await select(owner);
    const beforeBlock = await currentBlock();
    const balanceBefore = await balance(capital, owner, beforeBlock);
    const poolsBefore = await Promise.all(
      [route.buy, route.sell].map((pool) => reserves(pool, beforeBlock)),
    );
    let result: ArbitrageResult | undefined;
    await perform("Execute explicit capital", async (writer) => {
      result = await writer.arbitrage(route, "0");
    });
    assert(result);
    const receipt = await read.getTransactionReceipt({
      hash: result.receipt.transactionHash,
    });
    assert.equal(receipt.status, "success");
    const execution = parseEventLogs({
      abi: events,
      eventName: "ArbitrageExecuted",
      logs: receipt.logs,
    }).find((event) => same(event.address, arbitrage));
    assert(execution);
    assert.equal(
      execution.args.amountIn,
      exactRaw,
      "the atomic contract spends precisely the reviewed non-preset capital",
    );
    assert(same(execution.args.trader, owner));
    assert(same(execution.args.tokenIn, capital.address));
    const swaps = parseEventLogs({
      abi: events,
      eventName: "Swap",
      logs: receipt.logs,
    });
    assert.equal(
      swaps.length,
      2,
      "both market operations share this one successful receipt",
    );
    const firstSwap = swaps.find((event) =>
      same(event.address, route.buy.exchange.address),
    );
    const secondSwap = swaps.find((event) =>
      same(event.address, route.sell.exchange.address),
    );
    assert(firstSwap && secondSwap);
    assert.equal(firstSwap.args.amountIn, exactRaw);
    assert.equal(firstSwap.args.amountOut, secondSwap.args.amountIn);
    assert.equal(secondSwap.args.amountOut, execution.args.amountOut);
    assert.equal(execution.args.amountOut - exactRaw, execution.args.profit);
    assert(execution.args.profit > 0n);
    const balanceAfter = await balance(capital, owner, receipt.blockNumber);
    assert.equal(
      balanceAfter - balanceBefore,
      execution.args.profit,
      "the owner receives the actual capital-token profit",
    );
    assert.equal(result.amountIn, exactRaw);
    assert.equal(result.profit, execution.args.profit);
    assert.equal(result.amountOut, execution.args.amountOut);
    const poolsAfter = await Promise.all(
      [route.buy, route.sell].map((pool) =>
        reserves(pool, receipt.blockNumber),
      ),
    );
    assert(
      poolsAfter.every(
        (state, index) =>
          state[2] !== poolsBefore[index][2] &&
          state[3] !== poolsBefore[index][3],
      ),
    );
    const approvals = await read.getLogs({
      address: getAddress(capital.address),
      event: events.find(
        (event) => event.type === "event" && event.name === "Approval",
      )!,
      args: { owner, spender: getAddress(arbitrage) },
      fromBlock: beforeBlock + 1n,
      toBlock: receipt.blockNumber - 1n,
    });
    assert(
      approvals.length > 0,
      "the user approved the real arbitrage spender before its separate execution transaction",
    );
    scenarios.push({
      name: "Non-preset capital is quoted and spent exactly through actual authorization and atomic settlement",
      decimals: capital.decimals,
      exactAmount,
      secondAmount,
      unfundedBlock,
      beforeBlock,
      receipt: receipt.transactionHash,
      execution: execution.args,
      balanceBefore,
      balanceAfter,
      poolsBefore,
      poolsAfter,
    });
  }
  assert.deepEqual(
    await fingerprints(),
    sourceFingerprints,
    "production sources remained frozen during the public acceptance run",
  );
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.error =
    error instanceof Error
      ? { message: error.message, stack: error.stack }
      : String(error);
  throw error;
} finally {
  controller?.stop();
  await writeFile(
    resolve(directory, "result.json"),
    serialize(evidence) + "\n",
  );
  await environment.close();
  console.log(
    serialize({
      status: evidence.status,
      scenarios: scenarios.length,
      result: resolve(directory, "result.json"),
    }),
  );
}
