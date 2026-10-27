import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createWalletClient, erc20Abi, getAddress, http, maxUint256, parseAbi,
  parseEventLogs, parseUnits, type Abi, type Hex, type TransactionReceipt } from "viem";
import { ExchangeClient } from "../src/chain/client";
import type { ArbitrageResult, Deployment, Pool, Token } from "../src/chain/types";
import { arbitrageReceiptAvailable } from "../src/logic/arbitrageReceipt";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, root, until } from "./support/chain.mts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) => JSON.stringify(value,
  (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry, 2);
const arbEvents = parseAbi([
  "event ArbitrageExecuted(address indexed trader,address indexed buyDex,address indexed sellDex,address tokenIn,uint256 amountIn,uint256 intermediateAmount,uint256 amountOut,uint256 profit)",
  "event PoolReservesChanged(address indexed exchange,uint256 indexed poolId,uint256 reserve0Before,uint256 reserve1Before,uint256 reserve0After,uint256 reserve1After)",
]);
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
  const environment = await isolatedChain("arbitrage-receipt-public");
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
    const arbitrage = await deploy(arb), outsider = await deploy(arb);
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
    for (const target of [arbitrage, outsider]) {
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
    const opportunity = async (amount = "5") => {
      const pools = await client.pools(Number(await read.getBlockNumber({ cacheTime: 0 })));
      const selected = pools.find(pool => same(pool.exchange.address, first)); assert(selected);
      const opportunities = await client.quoteArbitrage(selected, six, amount, tokens);
      assert(opportunities.length > 0, "actual independent markets offer profitable capital route");
      return opportunities[0];
    };
    const balance = (address: Hex, blockNumber: bigint) => read.readContract({
      address, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber });
    const executeEvent = (receipt: TransactionReceipt, contract = arbitrage) => {
      const events = parseEventLogs({ abi: arbEvents, eventName: "ArbitrageExecuted", logs: receipt.logs })
        .filter(log => same(log.address, contract));
      assert.equal(events.length, 1); return events[0].args;
    };
    const checkRecovered = async (reader: ExchangeClient, hash: Hex) => {
      const recovered = await reader.arbitrageReceipt(hash); assert(recovered);
      const { result } = recovered;
      const receipt = await read.getTransactionReceipt({ hash });
      const event = executeEvent(receipt);
      assert.equal(receipt.status, "success");
      assert.deepEqual(result.receipt, receipt);
      assert(same(result.trader, event.trader));
      assert(same(result.tokenIn, event.tokenIn));
      assert.equal(result.amountIn, event.amountIn);
      assert.equal(result.intermediateAmount, event.intermediateAmount);
      assert.equal(result.amountOut, event.amountOut);
      assert.equal(result.profit, event.profit);
      const snapshots = parseEventLogs({ abi: arbEvents, eventName: "PoolReservesChanged", logs: receipt.logs })
        .filter(log => same(log.address, arbitrage));
      assert.equal(snapshots.length, 2);
      for (const [index, exchange] of [event.buyDex, event.sellDex].entries()) {
        const before = result.before[index], after = result.after[index];
        assert(same(before.exchange.address, exchange));
        assert(same(after.exchange.address, exchange));
        const snapshot = snapshots.find(log => same(log.args.exchange, exchange) && log.args.poolId === before.id);
        assert(snapshot);
        assert.equal(before.reserve0, snapshot.args.reserve0Before);
        assert.equal(before.reserve1, snapshot.args.reserve1Before);
        assert.equal(after.reserve0, snapshot.args.reserve0After);
        assert.equal(after.reserve1, snapshot.args.reserve1After);
        const pool = await read.readContract({ address: getAddress(exchange), abi: dex.abi,
          functionName: "pools", args: [before.id], blockNumber: receipt.blockNumber }) as readonly unknown[];
        assert(same(before.token0, pool[0] as string));
        assert(same(before.token1, pool[1] as string));
        assert(same(after.token0, before.token0) && same(after.token1, before.token1));
      }
      assert.deepEqual(recovered.tokens.map(token => token.address.toLowerCase()),
        [result.before[0].token0.toLowerCase(), result.before[0].token1.toLowerCase()]);
      assert.deepEqual(recovered.tokens.map(token => token.decimals).sort((a, b) => a - b), [6, 18]);
      const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs });
      const baseTransfers = transfers.filter(log => same(log.address, six));
      assert.equal(baseTransfers.find(log => same(log.args.from, owner) && same(log.args.to, arbitrage))?.args.value, result.amountIn);
      assert.equal(baseTransfers.find(log => same(log.args.from, arbitrage) && same(log.args.to, owner))?.args.value, result.amountOut);
      const midTransfers = transfers.filter(log => same(log.address, middle));
      assert.equal(midTransfers.find(log => same(log.args.from, result.before[0].exchange.address) &&
        same(log.args.to, arbitrage))?.args.value, result.intermediateAmount);
      assert.equal(midTransfers.find(log => same(log.args.from, arbitrage) &&
        same(log.args.to, result.before[1].exchange.address))?.args.value, result.intermediateAmount);
      assert.equal(await balance(six, receipt.blockNumber) - await balance(six, receipt.blockNumber - 1n), result.profit);
      assert.equal(await read.getBalance({ address: owner, blockNumber: receipt.blockNumber - 1n }) -
        await read.getBalance({ address: owner, blockNumber: receipt.blockNumber }), result.gasCostWei);
      return recovered;
    };

    denyDescriptions = true;
    let execution: ArbitrageResult | undefined;
    await perform("Execute atomic arbitrage", async writer => {
      execution = await writer.arbitrage(await opportunity(), "0");
    });
    assert(execution);
    const unavailable = await until(() => wallet!.kernel.getSnapshot().journal.find(entry =>
      entry.state === "confirmed" && same(entry.hash, execution!.receipt.transactionHash)), entry => !!entry,
    "confirmation despite unavailable transaction description");
    assert(unavailable && unavailable.state === "confirmed");
    assert.equal(unavailable.descriptor, null);
    assert(deniedDescriptions > 0);
    assert(arbitrageReceiptAvailable(arbitrage, unavailable.descriptor));
    const live = await checkRecovered(client, execution.receipt.transactionHash);
    assert.equal(execution.trader.toLowerCase(), live.result.trader.toLowerCase());
    assert.equal(execution.intermediateAmount, live.result.intermediateAmount);
    evidence.unavailableDescription = { deniedDescriptions, entry: unavailable, recovered: live };
    scenarios.push("A real metadata RPC failure leaves a confirmed unknown-descriptor entry eligible for actual receipt recovery");
    denyDescriptions = false;
    const firstHash = execution.receipt.transactionHash;
    await writeFile(resolve(directory, "hashes.json"), json([firstHash]));
    await writeFile(resolve(directory, "storage.json"), json([...storage.values]));
    wallet.stop(); wallet = undefined;
    const later = await marketWallet.writeContract({ address: first, abi: dex.abi, functionName: "swap",
      args: [1n, middle, parseUnits("2", 18), 0n, mover, (await read.getBlock()).timestamp + 1200n] });
    assert.equal((await read.waitForTransactionReceipt({ hash: later })).status, "success");
    const restored = new ExchangeClient(deployment);
    await restored.verifyDeployment();
    const restoredStorage = new PageStorage(new Map(JSON.parse(await readFile(resolve(directory, "storage.json"), "utf8"))));
    wallet = new WalletController(restored, { storage: restoredStorage });
    await wallet.start();
    const saved = JSON.parse(await readFile(resolve(directory, "hashes.json"), "utf8")) as Hex[];
    for (const hash of saved) {
      await until(() => wallet!.kernel.getSnapshot().journal.find(entry => entry.state === "confirmed" && same(entry.hash, hash)),
        entry => !!entry, "restored confirmed arbitrage history");
      const recovered = await checkRecovered(restored, hash);
      assert.deepEqual(recovered, live);
    }
    evidence.historicalRecovery = { savedHashes: saved, later, recovered: live };
    scenarios.push("Mixed-precision actual execution, profit and fee survive later trading and Storage-backed client/controller reconstruction");
    wallet.dispatch({ kind: "select-local", address: owner });
    await until(() => wallet!.session(), session => !!session && same(session.address, owner), "restored actor selected");

    const route = await opportunity("3");
    const buy = route.buy;
    const deadline = (await read.getBlock()).timestamp + 1200n;
    const beforeIds = new Set(wallet.kernel.getSnapshot().journal.map(entry => entry.id));
    await rpc("evm_setAutomine", [false]);
    let arbOperation: Promise<void> | undefined;
    let preHash: Hex, arbHash: Hex, postHash: Hex;
    try {
      preHash = await marketWallet.writeContract({ address: getAddress(buy.exchange.address), abi: dex.abi,
        functionName: "swap", args: [buy.id, middle, parseUnits("1", 18), 0n, mover, deadline],
        gas: 800000n, maxFeePerGas: 20000000000n, maxPriorityFeePerGas: 5000000000n });
      arbOperation = perform("Execute same-block atomic arbitrage", async writer => {
        execution = await writer.arbitrage(route, "0");
      });
      const pending = await until(() => wallet!.kernel.getSnapshot().journal.find(entry =>
        !beforeIds.has(entry.id) && entry.state === "submitted"), entry => !!entry,
      "published arbitrage while miner is paused");
      assert(pending && pending.state === "submitted"); arbHash = pending.hash as Hex;
      postHash = await marketWallet.writeContract({ address: getAddress(buy.exchange.address), abi: dex.abi,
        functionName: "swap", args: [buy.id, middle, parseUnits("1", 18), 0n, mover, deadline],
        gas: 800000n, maxFeePerGas: 20000000000n, maxPriorityFeePerGas: 0n });
      await rpc("evm_mine");
      await arbOperation;
    } finally {
      await rpc("evm_setAutomine", [true]);
    }
    const receipts = await Promise.all([preHash!, arbHash!, postHash!].map(hash => read.getTransactionReceipt({ hash })));
    for (const receipt of receipts) assert.equal(receipt.status, "success");
    assert.equal(receipts[0].blockNumber, receipts[1].blockNumber);
    assert.equal(receipts[1].blockNumber, receipts[2].blockNumber);
    assert(receipts[0].transactionIndex < receipts[1].transactionIndex);
    assert(receipts[1].transactionIndex < receipts[2].transactionIndex);
    const knownEntry = wallet.kernel.getSnapshot().journal.find(entry =>
      entry.state === "confirmed" && same(entry.hash, arbHash!));
    assert(knownEntry?.descriptor);
    assert(arbitrageReceiptAvailable(arbitrage, knownEntry.descriptor));
    const sameBlock = await checkRecovered(restored, arbHash!);
    const end = await read.readContract({ address: getAddress(buy.exchange.address), abi: dex.abi,
      functionName: "pools", args: [buy.id], blockNumber: receipts[1].blockNumber }) as readonly bigint[];
    assert(end[2] !== sameBlock.result.before[0].reserve0 || end[3] !== sameBlock.result.before[0].reserve1);
    assert(end[2] !== sameBlock.result.after[0].reserve0 || end[3] !== sameBlock.result.after[0].reserve1);
    evidence.sameBlock = { receipts, recovered: sameBlock, blockEndReserves: end.slice(2, 4) };
    scenarios.push("Actual pre-trade, arbitrage and post-trade share a block while recovery preserves this execution's event reserves instead of block-end reserves");

    const foreignRoute = await opportunity("1");
    const foreignHash = await ownerWallet.writeContract({ address: outsider, abi: arb.abi, functionName: "execute",
      args: [foreignRoute.buy.exchange.address, foreignRoute.buy.id, foreignRoute.sell.exchange.address,
        foreignRoute.sell.id, six, foreignRoute.amountIn, 0n, (await read.getBlock()).timestamp + 1200n] });
    const foreign = await read.waitForTransactionReceipt({ hash: foreignHash });
    assert.equal(foreign.status, "success"); executeEvent(foreign, outsider);
    assert.equal(await restored.arbitrageReceipt(foreignHash), null);
    const approval = await ownerWallet.writeContract({ address: six, abi: erc20Abi,
      functionName: "approve", args: [outsider, 0n] });
    assert.equal((await read.waitForTransactionReceipt({ hash: approval })).status, "success");
    assert.equal(await restored.arbitrageReceipt(approval), null);
    evidence.ignoredReceipts = { foreign, approval };
    scenarios.push("A successful same-ABI foreign arbitrage and a normal approval cannot become configured execution results");

    await rpc("evm_setAutomine", [false]);
    let failedHash: Hex;
    try {
      failedHash = await ownerWallet.writeContract({ address: arbitrage, abi: arb.abi, functionName: "execute",
        args: [foreignRoute.buy.exchange.address, foreignRoute.buy.id, foreignRoute.sell.exchange.address,
          foreignRoute.sell.id, six, parseUnits("1", 6), 10n ** 36n, (await read.getBlock()).timestamp + 1200n],
        gas: 2000000n });
      await rpc("evm_mine");
    } finally { await rpc("evm_setAutomine", [true]); }
    const reverted = await read.getTransactionReceipt({ hash: failedHash! });
    assert.equal(reverted.status, "reverted");
    await assert.rejects(restored.arbitrageReceipt(failedHash!), /revert/i);
    evidence.revertedReceipt = reverted;
    scenarios.push("A genuinely reverted execute transaction cannot be restored as successful profit");

    denyReceipts = true;
    await assert.rejects(restored.arbitrageReceipt(firstHash));
    assert(deniedReceipts > 0);
    denyReceipts = false;
    assert.deepEqual(await checkRecovered(restored, firstHash), live);
    evidence.receiptFailure = { deniedReceipts, recoveredHash: firstHash };
    scenarios.push("A real receipt RPC outage fails explicitly and a later manual retry recovers the same immutable result");
    assert.deepEqual(await fingerprints(), sources, "production sources remain frozen throughout acceptance");
  } catch (error) {
    failure = error;
  } finally {
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
