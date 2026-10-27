import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createWalletClient, erc20Abi, getAddress, http, maxUint256, parseAbi,
  parseEventLogs, parseUnits, type Abi, type Hex, type TransactionReceipt } from "viem";
import { ExchangeClient } from "../src/chain/client";
import type { ArbitrageResult, Deployment, Pool, Token, SwapResult, LiquidityConfirmation, TokenCreationConfirmation } from "../src/chain/types";
import { createRoutedSwapController, type RoutedSwapPlan } from "../src/logic/routing";
import { transactionResultAvailable } from "../src/logic/swapReceipt";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, root, until } from "./support/chain.mts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) => JSON.stringify(value,
  (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry, 2);
class PageStorage implements Storage {
  constructor(readonly values = new Map<string, string>()) {}
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
async function fingerprints() {
  const files: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const path = directory + "/" + entry.name;
      if (entry.isDirectory()) await visit(path);
      else if (/\.(tsx?|js)$/.test(path)) files.push(path);
    }
  }
  await visit("frontend/src");
  return Object.fromEntries(await Promise.all(files.sort().map(async path =>
    [path, createHash("sha256").update(await readFile(resolve(root, path))).digest("hex")])));
}
async function main() {
  const environment = await isolatedChain("swap-receipt-public");
  const { directory, accounts, artifact, deploy, read, admin, rpc } = environment;
  let wallet: WalletController | undefined;
  let denyReceipts = false, denyDescriptions = false;
  let deniedReceipts = 0, deniedDescriptions = 0;
  const proxy = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const calls = JSON.parse(body);
    const methods = (Array.isArray(calls) ? calls : [calls]).map(call => call.method);
    const receiptDenied = denyReceipts && methods.includes("eth_getTransactionReceipt");
    const descriptionDenied = denyDescriptions && methods.includes("eth_getTransactionByHash");
    if (receiptDenied || descriptionDenied) {
      if (receiptDenied) deniedReceipts++;
      if (descriptionDenied) deniedDescriptions++;
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("Selected RPC method unavailable during acceptance");
      return;
    }
    const upstream = await fetch(environment.rpcUrl, { method: "POST",
      headers: { "content-type": "application/json" }, body });
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(await upstream.text());
  });
  await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
  const proxyUrl = "http://127.0.0.1:" + (proxy.address() as { port: number }).port;
  const scenarios: string[] = [];
  const evidence: Record<string, unknown> = {};
  let sources: Record<string, string> = {};
  let failure: unknown;
  try {
    sources = await fingerprints();
    if (process.env.DEX_EXPECTED_KERNEL_SHA256)
      assert.equal(sources["frontend/src/generated/dex_logic.js"], process.env.DEX_EXPECTED_KERNEL_SHA256);
    const base = await artifact("TestToken"), dex = await artifact("MiniDEX");
    const arb = await artifact("AtomicArbitrage");
    const middle = await deploy(base, ["Historical middle", "MID"]);
    const unused = await deploy(base, ["Other token", "OTHER"]);
    const weth = await deploy(await artifact("WrappedEther"));
    const first = await deploy(dex, ["Historical market A"]);
    const second = await deploy(dex, ["Historical market B"]);
    const arbitrage = await deploy(arb);
    const precision = (await environment.fixtures("contracts/test/fixtures/PrecisionToken.sol")).PrecisionToken;
    const six = await deploy({ abi: precision.abi,
      bytecode: ("0x" + precision.evm.bytecode.object) as Hex }, ["Historical capital", "SIX", 6]);
    const deployment: Deployment = {
      schemaVersion: 1, chainId: 31337, rpcUrl: proxyUrl,
      tokens: [
        { address: middle, name: "Historical middle", symbol: "MID", kind: "faucet", decimals: 18 },
        { address: unused, name: "Other token", symbol: "OTHER", kind: "faucet", decimals: 18 },
        { address: weth, name: "Wrapped Ether", symbol: "WETH", kind: "wrapped", decimals: 18 },
      ],
      exchanges: [{ address: first, name: "Historical market A" },
        { address: second, name: "Historical market B" }],
      arbitrage, bytecodes: { TestToken: base.bytecode },
    };
    const client = new ExchangeClient(deployment);
    await client.verifyDeployment();
    const imported = await client.importToken(six);
    assert.equal(imported.decimals, 6);
    const tokens: Token[] = [...deployment.tokens, imported];
    const owner = accounts[1], mover = accounts[2];
    const ownerWallet = createWalletClient({ account: owner, chain: environment.chain,
      transport: http(environment.rpcUrl) });
    const marketWallet = createWalletClient({ account: mover, chain: environment.chain,
      transport: http(environment.rpcUrl) });
    const send = async (address: string, abi: Abi, functionName: string, args: readonly unknown[] = []) => {
      const hash = await admin.writeContract({ address: getAddress(address), abi, functionName, args });
      const receipt = await read.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      return receipt;
    };
    await send(middle, base.abi, "faucet");
    await send(six, precision.abi, "mint", [accounts[0], parseUnits("10000", 6)]);
    for (const address of [owner, mover])
      await send(six, precision.abi, "mint", [address, parseUnits("10000", 6)]);
    const moverFaucet = await marketWallet.writeContract({ address: middle, abi: base.abi,
      functionName: "faucet" });
    assert.equal((await read.waitForTransactionReceipt({ hash: moverFaucet })).status, "success");
    const ordered = (pool: Pool, capital: bigint, mid: bigint) =>
      same(pool.token0, six) ? [capital, mid] as const : [mid, capital] as const;
    for (const [exchange, mid] of [[first, "1000"], [second, "2000"]] as const) {
      await send(exchange, dex.abi, "createPool", [six, middle]);
      for (const token of [six, middle])
        await send(token, erc20Abi, "approve", [exchange, maxUint256]);
      const pool = (await client.pools(Number(await read.getBlockNumber({ cacheTime: 0 })))).find(
        pool => same(pool.exchange.address, exchange));
      assert(pool);
      await send(exchange, dex.abi, "addLiquidity", [pool.id,
        ...ordered(pool, parseUnits("1000", 6), parseUnits(mid, 18)), 0n, 0n,
        (await read.getBlock()).timestamp + 1200n]);
      const approval = await marketWallet.writeContract({ address: middle, abi: erc20Abi,
        functionName: "approve", args: [exchange, maxUint256] });
      assert.equal((await read.waitForTransactionReceipt({ hash: approval })).status, "success");
    }
    for (const target of [arbitrage]) {
      const hash = await ownerWallet.writeContract({ address: six, abi: erc20Abi,
        functionName: "approve", args: [target, maxUint256] });
      assert.equal((await read.waitForTransactionReceipt({ hash })).status, "success");
    }
    const storage = new PageStorage();
    wallet = new WalletController(client, { storage });
    await wallet.start();
    wallet.dispatch({ kind: "select-local", address: owner });
    await until(() => wallet!.session(), session => !!session && same(session.address, owner), "actor selected");
    const perform = (label: string, action: Parameters<WalletController["perform"]>[0]["perform"]) => {
      const session = wallet!.session(); assert(session);
      return wallet!.perform({ label, session, perform: action });
    };
    const activePool = async () => {
      const pools = await client.pools(Number(await read.getBlockNumber({ cacheTime: 0 })));
      const pool = pools.find(pool => same(pool.exchange.address, first)); assert(pool);
      return pool;
    };
    const quote = async (): Promise<RoutedSwapPlan> => {
      const snapshot = await client.snapshot(owner, tokens);
      const pool = snapshot.pools.find(pool => same(pool.exchange.address, first)); assert(pool);
      const context = { tokens, pool, pools: snapshot.pools, exchanges: deployment.exchanges,
        balances: snapshot.balances, connected: true, pending: false, block: snapshot.block };
      const controller = createRoutedSwapController(pool.token0);
      controller.dispatch({ kind: "pay", value: six }, context);
      controller.dispatch({ kind: "amount", value: "2.75" }, context);
      controller.dispatch({ kind: "slippage", value: "2" }, context);
      const effect = controller.dispatch({ kind: "submit" }, context).effect;
      assert(effect?.kind === "swap"); return effect;
    };
    const swapABI = parseAbi([
      "event Swap(uint256 indexed poolId,address indexed sender,address indexed tokenIn,uint256 amountIn,uint256 amountOut,address recipient)",
    ]);
    const tokenBalance = (token: string, holder: Hex, blockNumber: bigint) => read.readContract({
      address: getAddress(token), abi: erc20Abi, functionName: "balanceOf", args: [holder], blockNumber });
    const recovered = async (reader: ExchangeClient, hash: Hex) => {
      const details = await reader.swapReceipt(hash); assert(details);
      const result = details.execution;
      const receipt = await read.getTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      const events = parseEventLogs({ abi: swapABI, eventName: "Swap", logs: receipt.logs })
        .filter(log => same(log.address, receipt.to!));
      assert.equal(events.length, 1);
      const event = events[0].args;
      assert.deepEqual(result.receipt, receipt);
      assert(same(result.pool.exchange.address, receipt.to!));
      assert.equal(result.pool.id, event.poolId);
      assert(same(result.trader, event.sender));
      assert(same(result.recipient, event.recipient));
      assert(same(result.tokenIn, event.tokenIn));
      assert.equal(result.amountIn, event.amountIn); assert.equal(result.amountOut, event.amountOut);
      const identity = await read.readContract({ address: getAddress(receipt.to!), abi: dex.abi,
        functionName: "pools", args: [event.poolId], blockNumber: receipt.blockNumber }) as readonly unknown[];
      assert(same(result.pool.token0, identity[0] as string)); assert(same(result.pool.token1, identity[1] as string));
      const output = same(event.tokenIn, identity[0] as string) ? identity[1] : identity[0];
      assert(same(result.tokenOut, output as string));
      assert.equal(details.tokens.find(token => same(token.address, six))?.decimals, 6);
      assert.equal(details.tokens.find(token => same(token.address, middle))?.decimals, 18);
      assert.equal(await tokenBalance(result.tokenIn, getAddress(result.trader), receipt.blockNumber - 1n) -
        await tokenBalance(result.tokenIn, getAddress(result.trader), receipt.blockNumber), result.amountIn);
      assert.equal(await tokenBalance(result.tokenOut, getAddress(result.recipient), receipt.blockNumber) -
        await tokenBalance(result.tokenOut, getAddress(result.recipient), receipt.blockNumber - 1n), result.amountOut);
      assert.equal(await read.getBalance({ address: getAddress(receipt.from), blockNumber: receipt.blockNumber - 1n }) -
        await read.getBalance({ address: getAddress(receipt.from), blockNumber: receipt.blockNumber }), result.gasCostWei);
      assert(!("quoted" in result) && !("minimum" in result), "historical execution has no fabricated original quote or minimum");
      const unified = await reader.transactionResult(hash); assert(unified?.kind === "swap");
      assert.deepEqual(unified.details, details);
      return details;
    };
    denyDescriptions = true;
    let live: SwapResult | undefined;
    const plan = await quote();
    await perform("Swap historic mixed precision", async writer => { live = await writer.routedSwap(plan); });
    assert(live);
    const unknown = await until(() => wallet!.kernel.getSnapshot().journal.find(entry =>
      entry.state === "confirmed" && same(entry.hash, live!.receipt.transactionHash)), entry => !!entry,
    "confirmed swap despite unavailable description");
    assert(unknown && unknown.state === "confirmed"); assert.equal(unknown.descriptor, null);
    assert(transactionResultAvailable(client.deployment, unknown.descriptor));
    assert(deniedDescriptions > 0);
    const initial = await recovered(client, live.receipt.transactionHash);
    assert.equal(initial.execution.amountIn, live.amountIn); assert.equal(initial.execution.amountOut, live.amountOut);
    assert(same(live.trader, initial.execution.trader)); assert(same(live.recipient, initial.execution.recipient));
    evidence.unavailableDescription = { deniedDescriptions, entry: unknown, execution: initial };
    scenarios.push("A genuine metadata RPC outage preserves a confirmed swap and actual unified result recovery");
    denyDescriptions = false;
    await writeFile(resolve(directory, "hashes.json"), json([live.receipt.transactionHash]));
    await writeFile(resolve(directory, "storage.json"), json([...storage.values]));
    wallet.stop(); wallet = undefined;
    const pool = initial.execution.pool;
    const laterHash = await marketWallet.writeContract({ address: getAddress(pool.exchange.address), abi: dex.abi,
      functionName: "swap", args: [pool.id, middle, parseUnits("2", 18), 0n, mover,
        (await read.getBlock()).timestamp + 1200n] });
    assert.equal((await read.waitForTransactionReceipt({ hash: laterHash })).status, "success");
    const restored = new ExchangeClient(deployment);
    const restoredStorage = new PageStorage(new Map(JSON.parse(await readFile(resolve(directory, "storage.json"), "utf8"))));
    wallet = new WalletController(restored, { storage: restoredStorage }); await wallet.start();
    const saved = JSON.parse(await readFile(resolve(directory, "hashes.json"), "utf8")) as Hex[];
    for (const hash of saved) {
      await until(() => wallet!.kernel.getSnapshot().journal.find(entry => entry.state === "confirmed" && same(entry.hash, hash)),
        entry => !!entry, "confirmed swap restored from serialized page storage");
      assert.deepEqual(await recovered(restored, hash), initial);
    }
    evidence.historicalRecovery = { saved, laterHash, initial };
    scenarios.push("Mixed precision execution, actual rate inputs, accounts and native fee survive later trading and Storage reconstruction");
    wallet.dispatch({ kind: "select-local", address: owner });
    await until(() => wallet!.session(), session => !!session && same(session.address, owner), "restored actor selected");

    const selected = await activePool(), recipient = accounts[3];
    const approval = await ownerWallet.writeContract({ address: six, abi: erc20Abi, functionName: "approve", args: [first, maxUint256] });
    await read.waitForTransactionReceipt({ hash: approval });
    const deadline = (await read.getBlock()).timestamp + 1200n;
    const queued: Hex[] = [];
    await rpc("evm_setAutomine", [false]);
    try {
      const pendingSwap = (signer: typeof ownerWallet, token: Hex, amount: bigint, to: Hex, tip: bigint) =>
        signer.writeContract({ address: first, abi: dex.abi, functionName: "swap",
          args: [selected.id, token, amount, 0n, to, deadline], gas: 800000n,
          maxFeePerGas: 20000000000n, maxPriorityFeePerGas: tip });
      queued.push(await pendingSwap(marketWallet, middle, parseUnits("1", 18), mover, 5000000000n));
      queued.push(await pendingSwap(ownerWallet, six, parseUnits("1", 6), recipient, 3000000000n));
      queued.push(await pendingSwap(marketWallet, middle, parseUnits("2", 18), mover, 1000000000n));
      await rpc("evm_mine");
    } finally { await rpc("evm_setAutomine", [true]); }
    const receipts = await Promise.all(queued.map(hash => read.getTransactionReceipt({ hash })));
    for (const [index, receipt] of receipts.entries()) {
      assert.equal(receipt.status, "success"); assert.equal(receipt.blockNumber, receipts[0].blockNumber);
      assert.equal(receipt.transactionIndex, index);
    }
    const sameBlock = await recovered(restored, queued[1]);
    assert(same(sameBlock.execution.recipient, recipient));
    assert(!same(sameBlock.execution.trader, recipient));
    evidence.sameBlock = { receipts, recovered: sameBlock };
    scenarios.push("Three real same-block trades preserve the middle execution and its distinct token recipient instead of using block-end market state");

    let liquidity: LiquidityConfirmation | undefined;
    const mintPool = await activePool();
    await perform("Add liquidity for unified recovery", async writer => {
      liquidity = await writer.addLiquidity(mintPool,
        ...ordered(mintPool, parseUnits("1", 6), parseUnits("1", 18)), 100n);
    });
    assert(liquidity);
    const nft = await restored.transactionResult(liquidity.receipt.transactionHash); assert(nft?.kind === "liquidity");
    assert.deepEqual(nft.details, await restored.liquidityReceipt(liquidity.receipt.transactionHash));
    const markets = await client.pools(Number(await read.getBlockNumber({ cacheTime: 0 })));
    const anchor = markets.find(item => same(item.exchange.address, first)); assert(anchor);
    const opportunities = await client.quoteArbitrage(anchor, six, "1", tokens); assert(opportunities.length);
    let arbResult: ArbitrageResult | undefined;
    await perform("Execute arbitrage for unified recovery", async writer => { arbResult = await writer.arbitrage(opportunities[0], "0"); });
    assert(arbResult);
    const arbitrageResult = await restored.transactionResult(arbResult.receipt.transactionHash); assert(arbitrageResult?.kind === "arbitrage");
    assert.deepEqual(arbitrageResult.details, await restored.arbitrageReceipt(arbResult.receipt.transactionHash));
    assert.equal(await restored.swapReceipt(arbResult.receipt.transactionHash), null,
      "internal arbitrage swaps are not ordinary single-pool swap results");
    let creation: TokenCreationConfirmation | undefined;
    await perform("Create token for unified recovery", async writer => { creation = await writer.createToken("Recovered asset", "RCP"); });
    assert(creation);
    const deployed = await restored.transactionResult(creation.receipt.transactionHash); assert(deployed?.kind === "creation");
    assert(same(deployed.address, creation.address)); assert.deepEqual(deployed.receipt, creation.receipt);
    evidence.unifiedDispatch = { liquidity: nft, arbitrage: arbitrageResult, creation: deployed };
    scenarios.push("One actual receipt entry recovers real NFT, arbitrage and contract creation evidence without misclassifying internal swaps");

    const foreign = await deploy(dex, ["Unconfigured market"]);
    await send(foreign, dex.abi, "createPool", [six, middle]);
    for (const token of [six, middle]) await send(token, erc20Abi, "approve", [foreign, maxUint256]);
    const foreignIdentity = await read.readContract({ address: foreign, abi: dex.abi,
      functionName: "pools", args: [1n] }) as readonly unknown[];
    const foreignAmounts = same(foreignIdentity[0] as string, six)
      ? [parseUnits("500", 6), parseUnits("500", 18)] : [parseUnits("500", 18), parseUnits("500", 6)];
    await send(foreign, dex.abi, "addLiquidity", [1n, ...foreignAmounts, 0n, 0n, (await read.getBlock()).timestamp + 1200n]);
    const foreignApproval = await ownerWallet.writeContract({ address: six, abi: erc20Abi,
      functionName: "approve", args: [foreign, maxUint256] }); await read.waitForTransactionReceipt({ hash: foreignApproval });
    const foreignHash = await ownerWallet.writeContract({ address: foreign, abi: dex.abi, functionName: "swap",
      args: [1n, six, parseUnits("1", 6), 0n, owner, (await read.getBlock()).timestamp + 1200n] });
    assert.equal((await read.waitForTransactionReceipt({ hash: foreignHash })).status, "success");
    assert.equal(await restored.swapReceipt(foreignHash), null); assert.equal(await restored.transactionResult(foreignHash), null);
    assert.equal(await restored.swapReceipt(foreignApproval), null); assert.equal(await restored.transactionResult(foreignApproval), null);
    evidence.ignoredReceipts = { foreign, foreignHash, foreignApproval };
    scenarios.push("A genuine same-ABI foreign market and a normal approval cannot become configured swap results");

    await rpc("evm_setAutomine", [false]);
    let failed: Hex;
    try {
      failed = await ownerWallet.writeContract({ address: first, abi: dex.abi, functionName: "swap",
        args: [selected.id, six, parseUnits("1", 6), 10n ** 50n, owner, (await read.getBlock()).timestamp + 1200n],
        gas: 800000n });
      await rpc("evm_mine");
    } finally { await rpc("evm_setAutomine", [true]); }
    assert.equal((await read.getTransactionReceipt({ hash: failed })).status, "reverted");
    await assert.rejects(restored.swapReceipt(failed)); await assert.rejects(restored.transactionResult(failed));
    evidence.revertedReceipt = { hash: failed };
    scenarios.push("A truly reverted swap is rejected rather than presented as a recovered successful execution");

    denyReceipts = true;
    await assert.rejects(restored.swapReceipt(saved[0])); await assert.rejects(restored.transactionResult(saved[0]));
    assert(deniedReceipts > 0); denyReceipts = false;
    assert.deepEqual(await recovered(restored, saved[0]), initial);
    evidence.receiptFailure = { deniedReceipts, hash: saved[0] };
    scenarios.push("Real receipt RPC failure is explicit and manual retry recovers the same original result");
    assert.deepEqual(await fingerprints(), sources, "production sources remain frozen throughout acceptance");
  } catch (error) { failure = error; }
  finally {
    wallet?.stop();
    await new Promise<void>((done, reject) => proxy.close(error => error ? reject(error) : done()));
    await environment.close();
  }
  await writeFile(resolve(directory, "result.json"), json({ status: failure ? "failed" : "passed", scenarios,
    kernelSha256: sources["frontend/src/generated/dex_logic.js"], sourceFingerprints: sources, evidence,
    ...(failure ? { error: String(failure), stack: failure instanceof Error ? failure.stack : null } : {}) }));
  console.log(json({ status: failure ? "failed" : "passed", scenarios: scenarios.length, directory }));
  if (failure) throw failure;
}
await main();
