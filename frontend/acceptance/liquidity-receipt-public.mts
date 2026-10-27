import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createWalletClient, getAddress, http, maxUint256, parseEventLogs, parseUnits, type Abi,
  type Hex, type TransactionReceipt } from "viem";
import { ExchangeClient } from "../src/chain/client";
import type { Deployment, LiquidityConfirmation, Pool, Token } from "../src/chain/types";
import { positionView } from "../src/logic/liquidity";
import { liquidityReceiptAvailable } from "../src/logic/liquidityReceipt";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, root, until } from "./support/chain.mts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) => JSON.stringify(value,
  (_key, v) => typeof v === "bigint" ? v.toString() : v, 2);

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
  const environment = await isolatedChain("liquidity-receipt-public");
  const { directory, accounts, artifact, deploy, read, admin, rpc } = environment;
  let wallet: WalletController | undefined;
  let denyReceipts = false;
  let deniedRequests = 0;
  let denyDescriptions = false;
  let deniedDescriptions = 0;
  const proxy = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const calls = JSON.parse(body);
    const methods = (Array.isArray(calls) ? calls : [calls]).map(call => call.method);
    const receiptDenied = denyReceipts && methods.includes("eth_getTransactionReceipt");
    const descriptionDenied = denyDescriptions && methods.includes("eth_getTransactionByHash");
    if (receiptDenied || descriptionDenied) {
      if (receiptDenied) deniedRequests++;
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
  try {
    sources = await fingerprints();
    if (process.env.DEX_EXPECTED_KERNEL_SHA256)
      assert.equal(sources["frontend/src/generated/dex_logic.js"], process.env.DEX_EXPECTED_KERNEL_SHA256);
    const base = await artifact("TestToken"), wrapped = await artifact("WrappedEther");
    const dex = await artifact("MiniDEX"), arb = await artifact("AtomicArbitrage");
    const first = await deploy(base, ["Receipt capital", "CAP"]);
    const second = await deploy(base, ["Other capital", "OTHER"]);
    const weth = await deploy(wrapped);
    const harbor = await deploy(dex, ["Receipt market"]);
    const summit = await deploy(dex, ["Second receipt market"]);
    const outsider = await deploy(dex, ["Unconfigured receipt market"]);
    const arbitrage = await deploy(arb);
    const precision = (await environment.fixtures("contracts/test/fixtures/PrecisionToken.sol")).PrecisionToken;
    const six = await deploy({ abi: precision.abi,
      bytecode: ("0x" + precision.evm.bytecode.object) as Hex }, ["Six decimal receipt", "SIX", 6]);
    const deployment: Deployment = {
      schemaVersion: 1, chainId: 31337, rpcUrl: proxyUrl,
      tokens: [
        { address: first, name: "Receipt capital", symbol: "CAP", kind: "faucet", decimals: 18 },
        { address: second, name: "Other capital", symbol: "OTHER", kind: "faucet", decimals: 18 },
        { address: weth, name: "Wrapped Ether", symbol: "WETH", kind: "wrapped", decimals: 18 },
      ],
      exchanges: [{ address: harbor, name: "Receipt market" },
        { address: summit, name: "Second receipt market" }],
      arbitrage, bytecodes: { TestToken: base.bytecode },
    };
    const client = new ExchangeClient(deployment);
    await client.verifyDeployment();
    const imported = await client.importToken(six);
    assert.equal(imported.decimals, 6);
    const tokens: Token[] = [...deployment.tokens, imported];
    const send = async (address: string, abi: Abi, functionName: string, args: readonly unknown[] = []) => {
      const hash = await admin.writeContract({ address: getAddress(address), abi, functionName, args });
      const receipt = await read.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      return receipt;
    };
    const currentPool = async () => {
      const pools = await client.pools(Number(BigInt(await rpc("eth_blockNumber") as string)));
      const pool = pools.find(p => same(p.exchange.address, harbor));
      assert(pool);
      return pool;
    };
    const balances = (pool: Pool, owner: string, blockNumber: bigint) => Promise.all(
      [pool.token0, pool.token1].map(address => read.readContract({ address: getAddress(address),
        abi: base.abi, functionName: "balanceOf", args: [getAddress(owner)], blockNumber }) as Promise<bigint>));
    const event = (receipt: TransactionReceipt, name: string, exchange = harbor) => {
      const log = parseEventLogs({ abi: dex.abi, logs: receipt.logs })
        .find(log => same(log.address, exchange) && log.eventName === name);
      assert(log, name + " is present in the actual receipt");
      return log.args as Record<string, bigint | string>;
    };
    await send(first, base.abi, "faucet");
    await send(six, precision.abi, "mint", [accounts[0], parseUnits("10000", 6)]);
    await send(harbor, dex.abi, "createPool", [first, six]);
    let pool = await currentPool();
    for (const token of [first, six]) await send(token, base.abi, "approve", [harbor, maxUint256]);
    const ordered = (firstAmount: bigint, sixAmount: bigint) => same(pool.token0, first)
      ? [firstAmount, sixAmount] as const : [sixAmount, firstAmount] as const;
    const seedReceipt = await send(harbor, dex.abi, "addLiquidity", [pool.id,
      ...ordered(parseUnits("1000", 18), parseUnits("2000", 6)), 0n, 0n,
      (await read.getBlock()).timestamp + 1200n]);
    const actor = accounts[1], recipient = accounts[2];
    await send(first, base.abi, "transfer", [actor, parseUnits("10", 18)]);
    await send(six, precision.abi, "mint", [actor, parseUnits("20", 6)]);
    const storage = new PageStorage();
    wallet = new WalletController(client, { storage });
    await wallet.start();
    const select = async (owner: string) => {
      wallet!.dispatch({ kind: "select-local", address: owner });
      await until(() => wallet!.session(), session => !!session && same(session.address, owner), "selected NFT owner");
    };
    const perform = async (label: string, action: Parameters<WalletController["perform"]>[0]["perform"]) => {
      const session = wallet!.session(); assert(session);
      await wallet!.perform({ label, session, perform: action });
    };
    const hashes: { kind: LiquidityConfirmation["kind"]; hash: Hex }[] = [];
    await select(actor);
    pool = await currentPool();
    await perform("Mint position NFT", async writer => {
      const result = await writer.addLiquidity(pool,
        ...ordered(parseUnits("2.5", 18), parseUnits("5", 6)), 50n);
      hashes.push({ kind: "deposit", hash: result.receipt.transactionHash });
    });
    const mintReceipt = await read.getTransactionReceipt({ hash: hashes[0].hash });
    const id = event(mintReceipt, "LiquidityAdded").positionId as bigint;
    evidence.marketMovement = await send(harbor, dex.abi, "swap", [pool.id,
      first, parseUnits("25", 18), 0n, accounts[0], (await read.getBlock()).timestamp + 1200n]);
    denyDescriptions = true;
    try {
      await perform("Transfer position", async writer => {
        const result = await writer.transferPosition(pool, id, recipient);
        hashes.push({ kind: "transfer", hash: result.receipt.transactionHash });
      });
    } finally { denyDescriptions = false; }
    const undescribed = await until(() => wallet!.kernel.getSnapshot().journal.find(entry =>
      entry.state === "confirmed" && same(entry.hash, hashes[1].hash)), entry => !!entry,
    "confirmed transfer despite unavailable transaction metadata");
    assert(undescribed && undescribed.state === "confirmed");
    assert(deniedDescriptions > 0);
    assert.equal(undescribed.descriptor, null);
    assert(liquidityReceiptAvailable(deployment.exchanges, undescribed.descriptor));
    const manuallyRead = await client.liquidityReceipt(undescribed.hash as Hex);
    assert(manuallyRead && manuallyRead.confirmation.kind === "transfer");
    assert.equal(manuallyRead.confirmation.receipt.transactionHash, hashes[1].hash);
    evidence.unavailableDescription = { deniedRequests: deniedDescriptions, entry: undescribed, manuallyRead };
    await select(recipient);
    const snapshot = await client.snapshot(recipient, tokens);
    const position = snapshot.positions.find(p => same(p.exchange.address, harbor) && p.id === id);
    assert(position);
    pool = await currentPool();
    await perform("Redeem position", async writer => {
      const result = await writer.removeLiquidity(pool, id, positionView(pool, position).amounts, 50n);
      hashes.push({ kind: "redeem", hash: result.receipt.transactionHash });
    });
    await assert.rejects(read.readContract({ address: harbor, abi: dex.abi, functionName: "ownerOf", args: [id] }));
    await writeFile(resolve(directory, "hashes.json"), json(hashes));
    await writeFile(resolve(directory, "storage.json"), json([...storage.values]));
    wallet.stop();
    const restoredStorage = new PageStorage(new Map(JSON.parse(await readFile(resolve(directory, "storage.json"), "utf8"))));
    const restored = new ExchangeClient(deployment);
    await restored.verifyDeployment();
    wallet = new WalletController(restored, { storage: restoredStorage });
    await wallet.start();
    const saved = JSON.parse(await readFile(resolve(directory, "hashes.json"), "utf8")) as typeof hashes;
    for (const item of saved) {
      await until(() => wallet!.kernel.getSnapshot().journal.find(entry =>
        entry.state === "confirmed" && same(entry.hash, item.hash)), entry => !!entry,
      "restored confirmed " + item.kind + " transaction");
    }
    wallet.stop();
    const recovered: unknown[] = [];
    let deposited: bigint[] | undefined, redeemed: bigint[] | undefined;
    for (const item of saved) {
      const result = await restored.liquidityReceipt(item.hash);
      assert(result);
      const actual = result.confirmation;
      const receipt = await read.getTransactionReceipt({ hash: item.hash });
      assert.equal(actual.kind, item.kind);
      assert.equal(actual.receipt.transactionHash, item.hash);
      assert.equal(actual.receipt.blockNumber, receipt.blockNumber);
      assert(same(actual.pool.exchange.address, harbor));
      assert.equal(actual.positionId, id);
      assert.deepEqual(result.tokens.map(token => token.address.toLowerCase()),
        [pool.token0.toLowerCase(), pool.token1.toLowerCase()]);
      for (const token of result.tokens) {
        const decimals = await read.readContract({ address: getAddress(token.address), abi: base.abi,
          functionName: "decimals", blockNumber: receipt.blockNumber });
        assert.equal(token.decimals, Number(decimals));
      }
      assert.deepEqual(result.tokens.map(token => token.decimals).sort((a, b) => a - b), [6, 18]);
      const [nativeBefore, nativeAfter] = await Promise.all([
        read.getBalance({ address: receipt.from, blockNumber: receipt.blockNumber - 1n }),
        read.getBalance({ address: receipt.from, blockNumber: receipt.blockNumber }),
      ]);
      assert.equal(actual.gasCostWei, nativeBefore - nativeAfter);
      if (actual.kind === "transfer") {
        const transfer = event(receipt, "Transfer");
        assert(same(actual.from, transfer.from as string));
        assert(same(actual.to, transfer.to as string));
        assert(same(actual.from, actor)); assert(same(actual.to, recipient));
      } else {
        const domain = event(receipt, actual.kind === "deposit" ? "LiquidityAdded" : "LiquidityRemoved");
        assert.equal(actual.pool.id, domain.poolId);
        assert.equal(actual.amount0, domain.amount0); assert.equal(actual.amount1, domain.amount1);
        assert.equal(actual.shares, domain.shares);
        assert(same(actual.owner, (actual.kind === "deposit" ? domain.provider : domain.owner) as string));
        const before = await balances(pool, actual.owner, receipt.blockNumber - 1n);
        const after = await balances(pool, actual.owner, receipt.blockNumber);
        const sign = actual.kind === "deposit" ? -1n : 1n;
        assert.deepEqual(after.map((amount, index) => (amount - before[index]) * sign),
          [actual.amount0, actual.amount1]);
        assert(same(actual.owner, actual.kind === "deposit" ? actor : recipient));
        if (actual.kind === "deposit") deposited = [actual.amount0, actual.amount1];
        else redeemed = [actual.amount0, actual.amount1];
      }
      recovered.push(result);
    }
    evidence.recovered = recovered;
    assert(deposited && redeemed);
    assert.notDeepEqual(redeemed, deposited, "The real intervening swap distinguishes the historical deposit from redemption");
    evidence.savedHashes = saved;
    scenarios.push("Restored history recovers mixed-precision mint, transfer and new-owner redemption after NFT burn using saved hashes");
    scenarios.push("Real transaction metadata failure leaves a confirmed transfer reachable through the manual receipt policy and read API");

    const seedId = event(seedReceipt, "LiquidityAdded").positionId as bigint;
    const recipientWallet = createWalletClient({ account: recipient, chain: environment.chain,
      transport: http(environment.rpcUrl) });
    let sameBlockTransfer: Hex, sameBlockRedemption: Hex;
    await rpc("evm_setAutomine", [false]);
    try {
      const pending = await read.getBlock({ blockTag: "pending" });
      assert(pending.baseFeePerGas !== null);
      sameBlockTransfer = await admin.writeContract({ address: harbor, abi: dex.abi,
        functionName: "safeTransferFrom", args: [accounts[0], recipient, seedId],
        gas: 1_000_000n, gasPrice: pending.baseFeePerGas + 2_000_000_000n });
      sameBlockRedemption = await recipientWallet.writeContract({ address: harbor, abi: dex.abi,
        functionName: "removeLiquidity", args: [seedId, 0n, 0n, pending.timestamp + 1200n],
        gas: 1_000_000n, gasPrice: pending.baseFeePerGas + 1_000_000_000n });
      await rpc("evm_mine");
    } finally { await rpc("evm_setAutomine", [true]); }
    const [transferReceipt, redemptionReceipt] = await Promise.all([
      read.getTransactionReceipt({ hash: sameBlockTransfer! }),
      read.getTransactionReceipt({ hash: sameBlockRedemption! }),
    ]);
    assert.equal(transferReceipt.status, "success");
    assert.equal(redemptionReceipt.status, "success");
    assert.equal(transferReceipt.blockNumber, redemptionReceipt.blockNumber);
    assert(transferReceipt.transactionIndex < redemptionReceipt.transactionIndex);
    await assert.rejects(read.readContract({ address: harbor, abi: dex.abi,
      functionName: "ownerOf", args: [seedId], blockNumber: transferReceipt.blockNumber }));
    const restoredTransfer = await restored.liquidityReceipt(transferReceipt.transactionHash);
    assert(restoredTransfer && restoredTransfer.confirmation.kind === "transfer");
    const transferEvent = event(transferReceipt, "Transfer");
    assert.equal(restoredTransfer.confirmation.positionId, transferEvent.tokenId);
    assert.equal(restoredTransfer.confirmation.pool.id, event(seedReceipt, "LiquidityAdded").poolId);
    assert(same(restoredTransfer.confirmation.pool.exchange.address, harbor));
    assert(same(restoredTransfer.confirmation.from, transferEvent.from as string));
    assert(same(restoredTransfer.confirmation.to, transferEvent.to as string));
    assert(same(restoredTransfer.confirmation.from, accounts[0]));
    assert(same(restoredTransfer.confirmation.to, recipient));
    assert.deepEqual(restoredTransfer.tokens.map(token => token.address.toLowerCase()),
      [pool.token0.toLowerCase(), pool.token1.toLowerCase()]);
    assert.deepEqual(restoredTransfer.tokens.map(token => token.decimals).sort((a, b) => a - b), [6, 18]);
    evidence.sameBlockRedemption = { transferReceipt, redemptionReceipt, restoredTransfer };
    scenarios.push("A transfer remains recoverable when its recipient redeems and burns the NFT later in the same block");

    const approval = await send(first, base.abi, "approve", [harbor, 0n]);
    assert.equal(await restored.liquidityReceipt(approval.transactionHash), null);
    await send(outsider, dex.abi, "createPool", [first, six]);
    for (const token of [first, six]) await send(token, base.abi, "approve", [outsider, maxUint256]);
    const foreign = await send(outsider, dex.abi, "addLiquidity", [1n,
      ...ordered(parseUnits("10", 18), parseUnits("20", 6)), 0n, 0n,
      (await read.getBlock()).timestamp + 1200n]);
    event(foreign, "LiquidityAdded", outsider);
    assert.equal(await restored.liquidityReceipt(foreign.transactionHash), null);
    evidence.ignoredReceipts = { approval, foreign };
    scenarios.push("ERC20 approvals and same-ABI liquidity events from an unconfigured DEX do not become configured liquidity results");

    await rpc("evm_setAutomine", [false]);
    let failedHash: Hex;
    try {
      failedHash = await admin.writeContract({ address: harbor, abi: dex.abi,
        functionName: "removeLiquidity", args: [id, 0n, 0n, (await read.getBlock()).timestamp + 1200n],
        gas: 1_000_000n });
      await rpc("evm_mine");
    } finally { await rpc("evm_setAutomine", [true]); }
    const failed = await read.getTransactionReceipt({ hash: failedHash! });
    assert.equal(failed.status, "reverted");
    await assert.rejects(restored.liquidityReceipt(failed.transactionHash));
    evidence.revertedReceipt = failed;
    scenarios.push("An actual reverted transaction is rejected rather than represented as a successful or empty liquidity receipt");

    denyReceipts = true;
    await assert.rejects(restored.liquidityReceipt(saved[0].hash));
    assert(deniedRequests > 0);
    denyReceipts = false;
    const retried = await restored.liquidityReceipt(saved[0].hash);
    assert(retried && retried.confirmation.kind === "deposit");
    assert.equal(retried.confirmation.receipt.transactionHash, saved[0].hash);
    evidence.receiptFailure = { deniedRequests, recoveredHash: saved[0].hash };
    scenarios.push("A real receipt RPC outage is visible and retry recovers the original evidence");
    assert.deepEqual(await fingerprints(), sources, "Accepted public adapters and generated kernel stayed frozen");
    await writeFile(resolve(directory, "result.json"), json({ status: "passed", scenarios,
      kernelSha256: sources["frontend/src/generated/dex_logic.js"], sourceFingerprints: sources, evidence }));
    console.log(json({ status: "passed", scenarios: scenarios.length, result: resolve(directory, "result.json") }));
  } catch (error) {
    await writeFile(resolve(directory, "result.json"), json({ status: "failed", scenarios,
      kernelSha256: sources["frontend/src/generated/dex_logic.js"], sourceFingerprints: sources, evidence,
      error: error instanceof Error ? error.stack : String(error) }));
    throw error;
  } finally {
    wallet?.stop();
    await new Promise<void>((done, reject) => proxy.close(error => error ? reject(error) : done()));
    await environment.close();
  }
}
await main();
