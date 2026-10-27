import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createWalletClient, erc20Abi, getAddress, http, parseEventLogs,
  parseEther, zeroAddress, type Hex } from "viem";
import { ExchangeClient } from "../src/chain/client";
import type { Deployment, WrappingConfirmation } from "../src/chain/types";
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
  const environment = await isolatedChain("wrapping-receipt-public");
  const { directory, artifact, deploy, accounts, read, rpc } = environment;
  let wallet: WalletController | undefined;
  let denyDescriptions = false, denyReceipts = false, denyState = false;
  let deniedDescriptions = 0, deniedReceipts = 0, deniedState = 0;
  const stateMethods = ["eth_call", "eth_getBalance", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash"];
  const proxy = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const input = JSON.parse(body);
    const methods = (Array.isArray(input) ? input : [input]).map(call => call.method);
    const descriptionDenied = denyDescriptions && methods.includes("eth_getTransactionByHash");
    const receiptDenied = denyReceipts && methods.includes("eth_getTransactionReceipt");
    const stateDenied = denyState && request.url === "/receipt-only" &&
      methods.some(method => stateMethods.includes(method));
    if (descriptionDenied || receiptDenied || stateDenied) {
      if (descriptionDenied) deniedDescriptions++;
      if (receiptDenied) deniedReceipts++;
      if (stateDenied) deniedState++;
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("Selected RPC method unavailable during wrapping acceptance");
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
    const tokenArtifact = await artifact("TestToken"), wrappedArtifact = await artifact("WrappedEther");
    const dexArtifact = await artifact("MiniDEX"), arbArtifact = await artifact("AtomicArbitrage");
    const first = await deploy(tokenArtifact, ["Wrapping base", "BASE"]);
    const second = await deploy(tokenArtifact, ["Other token", "OTHER"]);
    const weth = await deploy(wrappedArtifact);
    const foreign = await deploy(wrappedArtifact);
    const harbor = await deploy(dexArtifact, ["Wrapping market A"]);
    const summit = await deploy(dexArtifact, ["Wrapping market B"]);
    const arbitrage = await deploy(arbArtifact);
    const deployment: Deployment = {
      schemaVersion: 1, chainId: 31337, rpcUrl: proxyUrl,
      tokens: [
        { address: first, name: "Wrapping base", symbol: "BASE", kind: "faucet", decimals: 18 },
        { address: second, name: "Other token", symbol: "OTHER", kind: "faucet", decimals: 18 },
        { address: weth, name: "Wrapped Ether", symbol: "WETH", kind: "wrapped", decimals: 18 },
      ],
      exchanges: [{ address: harbor, name: "Wrapping market A" }, { address: summit, name: "Wrapping market B" }],
      arbitrage, bytecodes: { TestToken: tokenArtifact.bytecode },
    };
    const client = new ExchangeClient(deployment);
    await client.verifyDeployment();
    const owner = accounts[1];
    const sender = createWalletClient({ account: owner, chain: environment.chain,
      transport: http(environment.rpcUrl) });
    const storage = new PageStorage();
    wallet = new WalletController(client, { storage });
    await wallet.start(); wallet.dispatch({ kind: "select-local", address: owner });
    await until(() => wallet!.session(), session => !!session && same(session.address, owner), "wrapping actor selected");
    const perform = async (amount: bigint, withdraw: boolean) => {
      const session = wallet!.session(); assert(session);
      let confirmation: WrappingConfirmation | undefined;
      await wallet!.perform({ label: withdraw ? "Unwrap WETH" : "Wrap ETH", session,
        perform: async writer => { confirmation = await writer.wrap(amount, withdraw); } });
      assert(confirmation); return confirmation;
    };
    const balance = (blockNumber: bigint) => read.getBalance({ address: owner, blockNumber });
    const wrappedBalance = (blockNumber: bigint) => read.readContract({ address: weth,
      abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber });
    const recover = async (target: ExchangeClient, hash: Hex) => {
      const result = await target.wrappingReceipt(hash); assert(result);
      const unified = await target.transactionResult(hash); assert(unified?.kind === "wrapping");
      assert.deepEqual(unified.details, result);
      const receipt = await read.getTransactionReceipt({ hash });
      assert.equal(receipt.status, "success"); assert.deepEqual(result.receipt, receipt);
      assert(same(result.token, weth) && same(result.owner, owner) && same(receipt.from, owner));
      assert(receipt.to && same(receipt.to, weth));
      const changes = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs,
        strict: true }).filter(event => same(event.address, weth));
      assert.equal(changes.length, 1);
      const event = changes[0].args;
      assert.equal(result.amount, event.value);
      const withdraw = same(event.to, zeroAddress);
      assert(same(event.from, withdraw ? owner : zeroAddress));
      assert(same(event.to, withdraw ? zeroAddress : owner));
      assert.equal(result.kind, withdraw ? "unwrap" : "wrap");
      return result;
    };
    const checkIndependentBlock = async (result: WrappingConfirmation) => {
      const block = result.receipt.blockNumber;
      const [nativeBefore, nativeAfter, wrappedBefore, wrappedAfter, transaction] = await Promise.all([
        balance(block - 1n), balance(block), wrappedBalance(block - 1n), wrappedBalance(block),
        read.getTransaction({ hash: result.receipt.transactionHash }),
      ]);
      assert.equal(result.nativeChangeWei, nativeAfter - nativeBefore);
      assert.equal(result.wrappedChange, wrappedAfter - wrappedBefore);
      const observedFee = result.kind === "wrap"
        ? nativeBefore - nativeAfter - transaction.value
        : result.amount - (nativeAfter - nativeBefore);
      assert.equal(result.gasCostWei, observedFee); assert(result.gasCostWei > 0n);
      return { nativeBefore, nativeAfter, wrappedBefore, wrappedAfter, transaction };
    };

    denyDescriptions = true;
    const deposited = await perform(parseEther("1"), false);
    const unknown = await until(() => wallet!.kernel.getSnapshot().journal.find(entry =>
      entry.state === "confirmed" && same(entry.hash, deposited.receipt.transactionHash)),
    entry => !!entry, "confirmed wrap without transaction metadata");
    assert(unknown && unknown.state === "confirmed"); assert.equal(unknown.descriptor, null);
    assert(transactionResultAvailable(client.deployment, unknown.descriptor)); assert(deniedDescriptions > 0);
    const initial = await recover(client, deposited.receipt.transactionHash);
    for (const key of ["kind", "amount", "gasCostWei", "nativeChangeWei", "wrappedChange"] as const)
      assert.equal(initial[key], deposited[key]);
    evidence.metadataFailure = { deniedDescriptions, entry: unknown, observed: await checkIndependentBlock(initial) };
    denyDescriptions = false;
    const tiny = await perform(1n, true);
    const recoveredTiny = await recover(client, tiny.receipt.transactionHash);
    for (const key of ["kind", "amount", "gasCostWei", "nativeChangeWei", "wrappedChange"] as const)
      assert.equal(recoveredTiny[key], tiny[key]);
    assert.equal(tiny.amount, 1n); assert(tiny.nativeChangeWei < 0n);
    evidence.tinyUnwrap = { result: tiny, observed: await checkIndependentBlock(tiny) };
    scenarios.push("Real SDK wrap and one-wei unwrap preserve principal, actual gas, signed effects and recovery despite missing transaction metadata");

    const receiveHash = await sender.sendTransaction({ to: weth, value: parseEther("0.2"), data: "0x" });
    const receiveReceipt = await read.waitForTransactionReceipt({ hash: receiveHash });
    assert.equal(receiveReceipt.status, "success");
    const receiveTransaction = await read.getTransaction({ hash: receiveHash });
    assert(transactionResultAvailable(client.deployment, {
      hash: receiveHash, from: receiveTransaction.from, nonce: String(receiveTransaction.nonce),
      to: receiveTransaction.to, input: receiveTransaction.input, value: receiveTransaction.value.toString(),
      observedBlock: receiveReceipt.blockNumber.toString(),
    }));
    const received = await recover(client, receiveHash);
    assert.equal(received.kind, "wrap"); assert.equal(received.amount, parseEther("0.2"));
    evidence.receive = { result: received, observed: await checkIndependentBlock(received) };
    scenarios.push("Empty-calldata native ETH sent to the configured receive function is an actual recoverable wrap");

    const hashes = [deposited.receipt.transactionHash, tiny.receipt.transactionHash, receiveHash];
    await writeFile(resolve(directory, "hashes.json"), json(hashes));
    await writeFile(resolve(directory, "storage.json"), json([...storage.values]));
    wallet.stop(); wallet = undefined;
    const restored = new ExchangeClient(deployment);
    const restoredStorage = new PageStorage(new Map(JSON.parse(await readFile(resolve(directory, "storage.json"), "utf8"))));
    wallet = new WalletController(restored, { storage: restoredStorage }); await wallet.start();
    for (const hash of hashes.slice(0, 2))
      await until(() => wallet!.kernel.getSnapshot().journal.find(entry => entry.state === "confirmed" && same(entry.hash, hash)),
        entry => !!entry, "wrapping history restored from serialized page storage");
    wallet.stop(); wallet = undefined;
    const receiptOnly = new ExchangeClient({ ...deployment, rpcUrl: proxyUrl + "/receipt-only" });
    await receiptOnly.verifyDeployment();
    denyState = true;
    await assert.rejects(receiptOnly.rpc.getBalance({ address: owner }));
    const stateFailureProbe = deniedState;
    assert(stateFailureProbe > 0, "the state endpoint is genuinely unavailable");
    for (const hash of hashes) await recover(receiptOnly, hash);
    assert.equal(deniedState, stateFailureProbe,
      "receipt-only recovery does not request balance, block state or ERC20 metadata");
    denyState = false;
    evidence.storageRecovery = { hashes, deniedState };
    scenarios.push("Page storage and clients can be rebuilt while historical conversion recovery requires only receipts, not later balances or metadata");

    const beforeBlock = await read.getBlockNumber({ cacheTime: 0 });
    const priorWrapped = await wrappedBalance(beforeBlock);
    const addition = parseEther("0.5");
    const nonce = await read.getTransactionCount({ address: owner });
    let wrapHash: Hex, unwrapHash: Hex;
    await rpc("evm_setAutomine", [false]);
    try {
      wrapHash = await sender.writeContract({ address: weth, abi: wrappedArtifact.abi,
        functionName: "deposit", value: addition, gas: 300000n, nonce });
      unwrapHash = await sender.writeContract({ address: weth, abi: wrappedArtifact.abi,
        functionName: "withdraw", args: [priorWrapped + addition], gas: 300000n, nonce: nonce + 1 });
      await rpc("evm_mine");
    } finally { await rpc("evm_setAutomine", [true]); }
    const wrapReceipt = await read.getTransactionReceipt({ hash: wrapHash! });
    const unwrapReceipt = await read.getTransactionReceipt({ hash: unwrapHash! });
    assert.equal(wrapReceipt.status, "success"); assert.equal(unwrapReceipt.status, "success");
    assert.equal(wrapReceipt.blockNumber, unwrapReceipt.blockNumber);
    assert(wrapReceipt.transactionIndex < unwrapReceipt.transactionIndex);
    assert.equal(await wrappedBalance(unwrapReceipt.blockNumber), 0n);
    const sameWrap = await recover(restored, wrapHash!), sameUnwrap = await recover(restored, unwrapHash!);
    const block = unwrapReceipt.blockNumber;
    assert.equal(sameWrap.nativeChangeWei + sameUnwrap.nativeChangeWei, await balance(block) - await balance(block - 1n));
    assert.equal(sameWrap.wrappedChange + sameUnwrap.wrappedChange, -priorWrapped);
    for (const hash of hashes) await recover(restored, hash);
    evidence.sameBlock = { wrap: sameWrap, unwrap: sameUnwrap, endWrapped: 0n };
    scenarios.push("Wrap then full unwrap in one block leaves no WETH while original receipts retain independent effects and their actual combined ETH debit");

    const replenished = await sender.writeContract({ address: weth, abi: wrappedArtifact.abi,
      functionName: "deposit", value: parseEther("0.01") });
    assert.equal((await read.waitForTransactionReceipt({ hash: replenished })).status, "success");
    const transfer = await sender.writeContract({ address: weth, abi: erc20Abi,
      functionName: "transfer", args: [accounts[2], 1n] });
    const approval = await sender.writeContract({ address: weth, abi: erc20Abi,
      functionName: "approve", args: [accounts[2], 1n] });
    const foreignWrap = await sender.writeContract({ address: foreign, abi: wrappedArtifact.abi,
      functionName: "deposit", value: 1n });
    const faucet = await sender.writeContract({ address: first, abi: tokenArtifact.abi, functionName: "faucet" });
    for (const hash of [transfer, approval, foreignWrap, faucet]) {
      assert.equal((await read.waitForTransactionReceipt({ hash })).status, "success");
      assert.equal(await restored.wrappingReceipt(hash), null);
      assert.equal(await restored.transactionResult(hash), null);
    }
    evidence.ignoredReceipts = { transfer, approval, foreignWrap, faucet };
    scenarios.push("Ordinary WETH transfers and approvals, other ERC20 minting and a foreign same-ABI WETH do not become conversion results");

    let failed: Hex;
    await rpc("evm_setAutomine", [false]);
    try {
      failed = await sender.writeContract({ address: weth, abi: wrappedArtifact.abi,
        functionName: "withdraw", args: [parseEther("10000")], gas: 300000n });
      await rpc("evm_mine");
    } finally { await rpc("evm_setAutomine", [true]); }
    assert.equal((await read.getTransactionReceipt({ hash: failed! })).status, "reverted");
    await assert.rejects(restored.wrappingReceipt(failed!)); await assert.rejects(restored.transactionResult(failed!));
    evidence.revertedReceipt = { hash: failed! };
    scenarios.push("A genuinely reverted withdrawal cannot be recovered as a successful conversion");

    denyReceipts = true;
    await assert.rejects(restored.wrappingReceipt(hashes[0])); await assert.rejects(restored.transactionResult(hashes[0]));
    assert(deniedReceipts > 0); denyReceipts = false;
    assert.deepEqual(await recover(restored, hashes[0]), initial);
    evidence.receiptFailure = { deniedReceipts, hash: hashes[0] };
    scenarios.push("A real receipt HTTP outage is explicit and retry restores the original confirmed conversion");
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
