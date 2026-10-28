import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createWalletClient, erc20Abi, getAddress, http, maxUint256, parseEventLogs,
  parseUnits, type Abi, type Hex } from "viem";
import { ExchangeClient } from "../src/chain/client";
import { miniDexAbi } from "../src/generated/abis";
import type { Deployment, LiquidityConfirmation, Pool, PoolCreationConfirmation, Token } from "../src/chain/types";
import { createdPoolContinuation } from "../src/logic/poolCreationReceipt";
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
  const environment = await isolatedChain("pool-creation-receipt-public");
  const { directory, artifact, deploy, accounts, read, admin, rpc } = environment;
  let wallet: WalletController | undefined;
  let denyDescriptions = false, denyReceipts = false, denyState = false, denyMetadata = false;
  let deniedDescriptions = 0, deniedReceipts = 0, deniedState = 0, deniedMetadata = 0;
  const stateMethods = ["eth_call", "eth_getBalance", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getCode"];
  const proxy = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const input = JSON.parse(body);
    const calls = Array.isArray(input) ? input : [input];
    const descriptionDenied = denyDescriptions && calls.some(call => call.method === "eth_getTransactionByHash");
    const receiptDenied = denyReceipts && calls.some(call => call.method === "eth_getTransactionReceipt");
    const stateDenied = denyState && request.url === "/receipt-only" && calls.some(call => stateMethods.includes(call.method));
    const metadataDenied = denyMetadata && calls.some(call => call.method === "eth_call" &&
      ["0x06fdde03", "0x95d89b41", "0x313ce567"].some(selector => call.params?.[0]?.data?.startsWith(selector)));
    if (descriptionDenied || receiptDenied || stateDenied || metadataDenied) {
      if (descriptionDenied) deniedDescriptions++;
      if (receiptDenied) deniedReceipts++;
      if (stateDenied) deniedState++;
      if (metadataDenied) deniedMetadata++;
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("Selected RPC method unavailable during pool creation recovery acceptance");
      return;
    }
    const upstream = await fetch(environment.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(await upstream.text());
  });
  await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
  const proxyUrl = "http://127.0.0.1:" + (proxy.address() as { port: number }).port;
  const scenarios: string[] = [], evidence: Record<string, unknown>[] = [];
  let sources: Record<string, string> = {}, failure: unknown;
  try {
    sources = await fingerprints();
    const kernel = sources["frontend/src/generated/dex_logic.js"];
    if (process.env.DEX_EXPECTED_KERNEL_SHA256) assert.equal(kernel, process.env.DEX_EXPECTED_KERNEL_SHA256);
    const tokenArtifact = await artifact("TestToken"), dexArtifact = await artifact("MiniDEX");
    const first = await deploy(tokenArtifact, ["Creation base", "BASE"]);
    const second = await deploy(tokenArtifact, ["Creation other", "OTHER"]);
    const weth = await deploy(await artifact("WrappedEther"));
    const harbor = await deploy(dexArtifact, ["Creation market A"]);
    const summit = await deploy(dexArtifact, ["Creation market B"]);
    const foreign = await deploy(dexArtifact, ["External same ABI"]);
    const arbitrage = await deploy(await artifact("AtomicArbitrage"));
    const precision = (await environment.fixtures("contracts/test/fixtures/PrecisionToken.sol")).PrecisionToken;
    const six = await deploy({ abi: precision.abi, bytecode: `0x${precision.evm.bytecode.object}` as Hex }, ["Creation six", "SIX", 6]);
    const deployment: Deployment = {
      schemaVersion: 1, chainId: 31337, rpcUrl: proxyUrl,
      tokens: [
        { address: first, name: "Creation base", symbol: "BASE", kind: "faucet", decimals: 18 },
        { address: second, name: "Creation other", symbol: "OTHER", kind: "faucet", decimals: 18 },
        { address: weth, name: "Wrapped Ether", symbol: "WETH", kind: "wrapped", decimals: 18 },
      ],
      exchanges: [{ address: harbor, name: "Creation market A" }, { address: summit, name: "Creation market B" }],
      arbitrage, bytecodes: { TestToken: tokenArtifact.bytecode },
    };
    const client = new ExchangeClient(deployment); await client.verifyDeployment();
    const sixToken = await client.importToken(six); assert.equal(sixToken.decimals, 6);
    const tokens: Token[] = [...deployment.tokens, sixToken];
    const owner = accounts[1];
    const sender = createWalletClient({ account: owner, chain: environment.chain, transport: http(environment.rpcUrl) });
    const storage = new PageStorage();
    wallet = new WalletController(client, { storage }); await wallet.start();
    wallet.dispatch({ kind: "select-local", address: owner });
    await until(() => wallet!.session(), session => !!session && same(session.address, owner), "creator selected");
    const perform = async (label: string, action: Parameters<WalletController["perform"]>[0]["perform"]) => {
      const session = wallet!.session(); assert(session);
      await wallet!.perform({ label, session, perform: action });
    };
    const sendAdmin = async (address: string, abi: Abi, functionName: string, args: readonly unknown[] = []) => {
      const hash = await admin.writeContract({ address: getAddress(address), abi, functionName, args });
      const receipt = await read.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, "success"); return receipt;
    };
    for (const address of [harbor, summit]) await sendAdmin(address, dexArtifact.abi, "createPool", [first, second]);
    let secondCreation: PoolCreationConfirmation | undefined;
    await perform("Create second market pool", async writer => { secondCreation = await writer.createPool(summit, first, six); });
    assert(secondCreation);
    const oldSnapshot = await client.snapshot(owner, tokens);
    assert(oldSnapshot.pools.some(pool => same(pool.exchange.address, summit) && pool.id === secondCreation!.poolId));
    denyDescriptions = true;
    let creation: PoolCreationConfirmation | undefined;
    await perform("Create first market pool", async writer => { creation = await writer.createPool(harbor, first, six); });
    assert(creation); assert.equal(creation.poolId, secondCreation.poolId);
    const unknown = await until(() => wallet!.kernel.getSnapshot().journal.find(entry =>
      entry.state === "confirmed" && same(entry.hash, creation!.receipt.transactionHash)), entry => !!entry, "creation confirmed without descriptor");
    assert(unknown && unknown.state === "confirmed"); assert.equal(unknown.descriptor, null); assert(deniedDescriptions > 0);
    assert(transactionResultAvailable(deployment, unknown.descriptor)); denyDescriptions = false;
    const recover = async (target: ExchangeClient, hash: Hex) => {
      const result = await target.poolCreationReceipt(hash); assert(result);
      const unified = await target.transactionResult(hash); assert(unified?.kind === "pool-creation"); assert.deepEqual(unified.details, result);
      const receipt = await read.getTransactionReceipt({ hash }); assert.equal(receipt.status, "success"); assert.deepEqual(result.receipt, receipt);
      assert(same(receipt.from, owner) && receipt.to && same(receipt.to, result.exchange.address));
      const logs = parseEventLogs({ abi: miniDexAbi, eventName: "PoolCreated", logs: receipt.logs, strict: true })
        .filter(log => same(log.address, result.exchange.address));
      assert.equal(logs.length, 1); assert.equal(result.poolId, logs[0].args.poolId);
      assert(same(result.token0, logs[0].args.token0 as string) && same(result.token1, logs[0].args.token1 as string));
      assert([first, six].every(address => same(address, result.token0) || same(address, result.token1)));
      return result;
    };
    const firstRecovered = await recover(client, creation.receipt.transactionHash);
    const continuation = (result: PoolCreationConfirmation, pools: readonly Pool[] | undefined, available: readonly Token[] = tokens) =>
      createdPoolContinuation(result, pools, available, !!wallet!.session(), wallet!.kernel.getSnapshot().pending);
    assert.equal(continuation(firstRecovered, oldSnapshot.pools).kind, "read-state");
    evidence.push({ unknown, deniedDescriptions, oldSnapshot, firstRecovered });
    scenarios.push("A real creation with missing transaction metadata keeps its exact exchange and same-number pool identity instead of selecting another observed market");

    const hashes = [creation.receipt.transactionHash, secondCreation.receipt.transactionHash];
    await writeFile(resolve(directory, "hashes.json"), json(hashes));
    await writeFile(resolve(directory, "storage.json"), json([...storage.values]));
    wallet.stop();
    const restored = new ExchangeClient(deployment);
    wallet = new WalletController(restored, { storage: new PageStorage(new Map(JSON.parse(await readFile(resolve(directory, "storage.json"), "utf8")))) });
    await wallet.start();
    for (const hash of hashes) await until(() => wallet!.kernel.getSnapshot().journal.find(entry => entry.state === "confirmed" && same(entry.hash, hash)), entry => !!entry, "serialized confirmed pool creation restored");
    wallet.dispatch({ kind: "select-local", address: owner });
    await until(() => wallet!.session(), session => !!session && same(session.address, owner), "restored creator selected");
    for (const hash of JSON.parse(await readFile(resolve(directory, "hashes.json"), "utf8")) as Hex[]) await recover(restored, hash);
    scenarios.push("Saved transaction hashes and serialized wallet history restore both mixed-precision creations after rebuilding the public client and controller");

    const receiptOnly = new ExchangeClient({ ...deployment, rpcUrl: proxyUrl + "/receipt-only" });
    denyState = true; denyMetadata = true;
    await assert.rejects(receiptOnly.snapshot(owner, tokens)); assert(deniedState > 0);
    const stateCount = deniedState, metadataCount = deniedMetadata;
    assert.deepEqual(await recover(receiptOnly, hashes[0]), firstRecovered);
    assert.equal(deniedState, stateCount); assert.equal(deniedMetadata, metadataCount);
    await assert.rejects(restored.importToken(six)); assert(deniedMetadata > metadataCount);
    denyState = false;
    const current = await restored.snapshot(owner, tokens);
    assert.equal(continuation(firstRecovered, current.pools, deployment.tokens).kind, "unsupported-assets");
    denyMetadata = false;
    assert.equal((await restored.importToken(six)).decimals, 6);
    const ready = continuation(firstRecovered, current.pools); assert.equal(ready.kind, "ready");
    if (ready.kind !== "ready") throw new Error("fresh creation target is not ready");
    assert.deepEqual(ready.pool, current.pools.find(pool => same(pool.exchange.address, harbor) && pool.id === creation!.poolId));
    assert.equal(ready.pool.totalShares, 0n);
    evidence.push({ deniedState, deniedMetadata, currentTarget: ready.pool });
    scenarios.push("Creation identity survives real state and metadata outages while continuation waits for the actual observed pool and usable asset metadata");

    await perform("Fund creator base", async writer => { await writer.faucet(deployment.tokens[0]); });
    await sendAdmin(six, precision.abi, "mint", [owner, parseUnits("1000", 6)]);
    const value = (token: string, text: string) => parseUnits(text, tokens.find(entry => same(entry.address, token))!.decimals);
    const balances = async (pool: Pool, account: string) => Promise.all([pool.token0, pool.token1].map(token =>
      read.readContract({ address: getAddress(token), abi: erc20Abi, functionName: "balanceOf", args: [getAddress(account)] })));
    const deposit = async (pool: Pool, text: string) => {
      const before = await balances(pool, owner);
      let minted: LiquidityConfirmation | undefined;
      await perform("Continue created pool with liquidity", async writer => { minted = await writer.addLiquidity(pool, value(pool.token0, text), value(pool.token1, text), 50n); });
      assert(minted && minted.kind === "deposit");
      const added = parseEventLogs({ abi: miniDexAbi, eventName: "LiquidityAdded", logs: minted.receipt.logs, strict: true })
        .find(log => same(log.address, pool.exchange.address) && log.args.poolId === pool.id);
      assert(added); assert.equal(minted.positionId, added.args.positionId); assert.equal(minted.shares, added.args.shares);
      assert(same(await read.readContract({ address: getAddress(pool.exchange.address), abi: dexArtifact.abi, functionName: "ownerOf", args: [minted.positionId] }) as string, owner));
      const after = await balances(pool, owner);
      assert.equal(before[0] - after[0], added.args.amount0); assert.equal(before[1] - after[1], added.args.amount1);
      assert.equal(minted.amount0, added.args.amount0); assert.equal(minted.amount1, added.args.amount1);
      return minted;
    };
    const firstMint = await deposit(ready.pool, "20");
    assert.deepEqual(await recover(restored, hashes[0]), firstRecovered);
    evidence.push({ firstMint });
    scenarios.push("Refreshing the exact empty creation target then using the public deposit entry point mints a real creator-owned liquidity NFT with observed token debits");

    await sendAdmin(first, tokenArtifact.abi, "faucet"); await sendAdmin(six, precision.abi, "mint", [accounts[0], parseUnits("1000", 6)]);
    for (const address of [first, six]) await sendAdmin(address, erc20Abi, "approve", [summit, maxUint256]);
    const beforeSeed = (await restored.snapshot(owner, tokens)).pools.find(pool => same(pool.exchange.address, summit) && pool.id === secondCreation!.poolId); assert(beforeSeed);
    await sendAdmin(summit, dexArtifact.abi, "addLiquidity", [beforeSeed.id,
      value(beforeSeed.token0, same(beforeSeed.token0, first) ? "40" : "10"),
      value(beforeSeed.token1, same(beforeSeed.token1, first) ? "40" : "10"), 0n, 0n, (await read.getBlock()).timestamp + 1200n]);
    const secondRecovered = await recover(restored, hashes[1]);
    const seededSnapshot = await restored.snapshot(owner, tokens);
    const seeded = continuation(secondRecovered, seededSnapshot.pools); assert.equal(seeded.kind, "ready");
    if (seeded.kind !== "ready") throw new Error("seeded creation target is not ready");
    assert(same(seeded.pool.exchange.address, summit)); assert(seeded.pool.totalShares > 0n && seeded.pool.reserve0 > 0n && seeded.pool.reserve1 > 0n);
    assert.deepEqual(seeded.pool, seededSnapshot.pools.find(pool => same(pool.exchange.address, summit) && pool.id === secondCreation!.poolId));
    const secondMint = await deposit(seeded.pool, "20");
    assert.equal(value(first, "20"), same(seeded.pool.token0, first) ? secondMint.amount0 : secondMint.amount1);
    assert.equal(value(six, "5"), same(seeded.pool.token0, six) ? secondMint.amount0 : secondMint.amount1);
    assert.deepEqual(await recover(restored, hashes[1]), secondRecovered);
    assert.equal(await restored.poolCreationReceipt(secondMint.receipt.transactionHash), null);
    assert.equal((await restored.transactionResult(secondMint.receipt.transactionHash))?.kind, "liquidity");
    evidence.push({ seeder: accounts[0], seededPool: seeded.pool, secondMint });
    scenarios.push("Another actor can seed the same-number pool before continuation and the creator uses its real nonempty ratio while creation history remains immutable");

    const foreignReceipt = await sendAdmin(foreign, dexArtifact.abi, "createPool", [first, six]);
    assert.equal(await restored.poolCreationReceipt(foreignReceipt.transactionHash), null); assert.equal(await restored.transactionResult(foreignReceipt.transactionHash), null);
    const approved = await sendAdmin(first, erc20Abi, "approve", [harbor, 0n]); assert.equal(await restored.poolCreationReceipt(approved.transactionHash), null);
    let reverted: Hex | undefined; await rpc("evm_setAutomine", [false]);
    try {
      reverted = await sender.writeContract({ address: harbor, abi: dexArtifact.abi, functionName: "createPool", args: [first, six], gas: 400000n });
      await rpc("evm_mine");
    } finally { await rpc("evm_setAutomine", [true]); }
    assert.equal((await read.getTransactionReceipt({ hash: reverted! })).status, "reverted");
    await assert.rejects(restored.poolCreationReceipt(reverted!)); await assert.rejects(restored.transactionResult(reverted!));
    evidence.push({ foreign: foreignReceipt.transactionHash, reverted });
    scenarios.push("Foreign same-ABI pool creation and ordinary approvals are not attributed to this deployment and a real duplicate-pair revert is rejected");

    denyReceipts = true; await assert.rejects(restored.poolCreationReceipt(hashes[0])); await assert.rejects(restored.transactionResult(hashes[0]));
    assert(deniedReceipts > 0); denyReceipts = false;
    assert.deepEqual(await recover(restored, hashes[0]), firstRecovered);
    evidence.push({ deniedReceipts, recoveredHash: hashes[0] });
    scenarios.push("Receipt HTTP failures remain explicit and manual retry restores the original confirmed creation");
    assert.deepEqual(await fingerprints(), sources, "production sources remain frozen during acceptance");
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
