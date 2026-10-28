import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createWalletClient, erc20Abi, getAddress, http, parseEther,
  parseEventLogs, zeroAddress, type Hex } from "viem";
import { ExchangeClient } from "../src/chain/client";
import type { AssetFundingConfirmation, Deployment, FundingRecoveryContext, Token } from "../src/chain/types";
import { transactionResultAvailable } from "../src/logic/swapReceipt";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, root, until } from "./support/chain.mts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) => JSON.stringify(value,
  (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);

class FileStorage implements Storage {
  private values: Map<string, string>;
  constructor(readonly file: string) {
    this.values = new Map(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);
  }
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  clear() { this.values.clear(); this.save(); }
  removeItem(key: string) { this.values.delete(key); this.save(); }
  setItem(key: string, value: string) { this.values.set(key, value); this.save(); }
  private save() { writeFileSync(this.file, json([...this.values])); }
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
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file,
    createHash("sha256").update(await readFile(resolve(root, file))).digest("hex")])));
}

async function main() {
  const environment = await isolatedChain("funding-receipt-public");
  const { directory, artifact, deploy, fixtures, accounts, read, rpc, chain } = environment;
  let wallet: WalletController | undefined;
  let deniedMethod: string | undefined;
  let denyCurrentState = false;
  let rejected = 0, rejectedCurrentState = 0;
  const proxy = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const decoded = JSON.parse(body);
      const calls = Array.isArray(decoded) ? decoded : [decoded];
      const currentState = denyCurrentState && calls.some(call =>
        ["eth_getBalance", "eth_accounts"].includes(call.method));
      if (currentState || calls.some(call => call.method === deniedMethod)) {
        if (currentState) rejectedCurrentState++; else rejected++;
        response.writeHead(503, { "content-type": "text/plain" });
        response.end("Selected funding RPC method unavailable during acceptance");
        return;
      }
      const upstream = await fetch(environment.rpcUrl, { method: "POST",
        headers: { "content-type": "application/json" }, body });
      response.writeHead(upstream.status, { "content-type": "application/json" });
      response.end(await upstream.text());
    } catch (error) {
      response.writeHead(502, { "content-type": "text/plain" }); response.end(String(error));
    }
  });
  await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
  const address = proxy.address(); assert(address && typeof address !== "string");
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  const scenarios: string[] = [], evidence: Record<string, unknown> = {};
  let failure: unknown;
  let sources: Record<string, string> = {};
  try {
    sources = await fingerprints();
    if (process.env.DEX_EXPECTED_KERNEL_SHA256)
      assert.equal(sources["frontend/src/generated/dex_logic.js"], process.env.DEX_EXPECTED_KERNEL_SHA256);
    const tokenArtifact = await artifact("TestToken"), wrappedArtifact = await artifact("WrappedEther");
    const dexArtifact = await artifact("MiniDEX"), arbArtifact = await artifact("AtomicArbitrage");
    const first = await deploy(tokenArtifact, ["Funding asset", "FUND"]);
    const second = await deploy(tokenArtifact, ["Funding asset", "FUND"]);
    const created = await deploy(tokenArtifact, ["Created funding asset", "NEW"]);
    const weth = await deploy(wrappedArtifact);
    const harbor = await deploy(dexArtifact, ["Funding recovery A"]);
    const summit = await deploy(dexArtifact, ["Funding recovery B"]);
    const arbitrage = await deploy(arbArtifact);
    const foreignArtifact = (await fixtures("frontend/acceptance/support/FundingReceiptFixtures.sol")).ExternalFundingToken;
    const foreign = await deploy({ abi: foreignArtifact.abi, bytecode: `0x${foreignArtifact.evm.bytecode.object}` });
    const deployment: Deployment = {
      schemaVersion: 1, chainId: 31337, rpcUrl: proxyUrl,
      tokens: [
        { address: first, name: "Funding asset", symbol: "FUND", kind: "faucet", decimals: 18 },
        { address: second, name: "Funding asset", symbol: "FUND", kind: "faucet", decimals: 18 },
        { address: weth, name: "Wrapped Ether", symbol: "WETH", kind: "wrapped", decimals: 18 },
      ],
      exchanges: [{ address: harbor, name: "Funding recovery A" }, { address: summit, name: "Funding recovery B" }],
      arbitrage, bytecodes: { TestToken: tokenArtifact.bytecode },
    };
    const client = new ExchangeClient(deployment); await client.verifyDeployment();
    const actor = getAddress(accounts[3]), other = getAddress(accounts[4]);
    const sender = createWalletClient({ account: actor, chain, transport: http(environment.rpcUrl) });
    const emptySender = createWalletClient({ account: getAddress(accounts[9]), chain,
      transport: http(environment.rpcUrl) });
    await rpc("hardhat_setBalance", [actor, "0x0"]);
    const storagePath = resolve(directory, "wallet-storage.json");
    wallet = new WalletController(client, { storage: new FileStorage(storagePath) });
    await wallet.start();
    const select = async (owner: string) => {
      wallet!.dispatch({ kind: "select-local", address: owner });
      await until(() => wallet!.session(), session => !!session && same(session.address, owner), "funding wallet selection");
    };
    const perform = async (label: string, action: Parameters<WalletController["perform"]>[0]["perform"]) => {
      const session = wallet!.session(); assert(session);
      await wallet!.perform({ label, session, perform: action });
    };
    await select(actor);
    let native: AssetFundingConfirmation | undefined, token: AssetFundingConfirmation | undefined;
    let createdToken: AssetFundingConfirmation | undefined, sameBlockToken: AssetFundingConfirmation | undefined;
    await perform("Claim native for historical recovery", async writer => { native = await writer.claimEther(); });
    await perform("Claim base token for historical recovery", async writer => { token = await writer.faucet(deployment.tokens[0]); });
    const newAsset: Token = { address: created, name: "Created funding asset", symbol: "NEW", kind: "faucet", decimals: 18 };
    await perform("Claim created token for historical recovery", async writer => { createdToken = await writer.faucet(newAsset); });
    assert(native?.kind === "native" && token?.kind === "token" && createdToken?.kind === "token");
    const confirmations = [native, token, createdToken];
    const confirmedEntry = async (hash: Hex) => {
      const entry = await until(() => wallet!.kernel.getSnapshot().journal.find(row =>
        row.state === "confirmed" && same(row.hash, hash)), row => !!row, "confirmed funding journal");
      assert(entry?.state === "confirmed"); return entry;
    };
    const nativeEntry = await confirmedEntry(native.receipt.transactionHash);
    assert.equal(nativeEntry.authority, "dev-faucet"); assert(same(nativeEntry.beneficiary, actor));
    const nativeContext: FundingRecoveryContext = { authority: nativeEntry.authority, beneficiary: nativeEntry.beneficiary };
    const checkResult = async (target: ExchangeClient, expected: AssetFundingConfirmation,
      context?: FundingRecoveryContext) => {
      const hash = expected.receipt.transactionHash;
      const result = await target.fundingReceipt(hash, context); assert(result);
      const unified = await target.transactionResult(hash, context); assert(unified?.kind === "funding");
      assert.deepEqual(unified.details, result);
      const receipt = await read.getTransactionReceipt({ hash });
      assert.equal(receipt.status, "success"); assert.deepEqual(result.receipt, receipt);
      assert.equal(result.kind, expected.kind); assert(same(result.recipient, actor));
      assert.equal(result.gasCostWei, receipt.gasUsed * receipt.effectiveGasPrice);
      assert.equal(result.amount, expected.amount);
      if (result.kind === "token") {
        assert(expected.kind === "token"); assert(same(result.token.address, expected.token.address));
        assert.deepEqual(result.token, expected.token);
        const mint = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs, strict: true })
          .filter(log => same(log.address, result.token.address) && same(log.args.from, zeroAddress));
        assert.equal(mint.length, 1); assert(same(mint[0].args.to, result.recipient));
        assert.equal(result.amount, mint[0].args.value);
      } else {
        const transaction = await read.getTransaction({ hash });
        assert(transaction.to && same(transaction.to, result.recipient));
        assert.equal(result.amount, transaction.value); assert(!same(receipt.from, result.recipient));
      }
      return result;
    };
    for (const confirmation of confirmations)
      await checkResult(client, confirmation, confirmation.kind === "native" ? nativeContext : undefined);
    evidence.liveGrants = confirmations;
    scenarios.push("Token and native grants recover actual on-chain principal, recipient, fee payer and receipt fee, including a newly deployed token outside the initial catalog");

    const initialTokenBalance = await read.readContract({ address: first, abi: erc20Abi,
      functionName: "balanceOf", args: [actor] });
    await read.waitForTransactionReceipt({ hash: await sender.writeContract({ address: first,
      abi: erc20Abi, functionName: "transfer", args: [other, initialTokenBalance] }) });
    let sameBlockSpend: Hex | undefined;
    let pendingError: unknown;
    const priorJournalIds = new Set(wallet.kernel.getSnapshot().journal.map(row => row.id));
    await rpc("evm_setAutomine", [false]);
    const pending = perform("Same block token claim", async writer => {
      sameBlockToken = await writer.faucet(deployment.tokens[0]);
    }).catch(error => { pendingError = error; });
    try {
      const submitted = await until(() => {
        if (pendingError) throw pendingError;
        return wallet!.kernel.getSnapshot().journal.find(row =>
          !priorJournalIds.has(row.id) && row.state === "submitted");
      }, row => !!row, "submitted same-block claim");
      assert(submitted?.state === "submitted");
      const nonce = await read.getTransactionCount({ address: actor, blockTag: "pending" });
      sameBlockSpend = await sender.writeContract({ address: first, abi: erc20Abi,
        functionName: "transfer", args: [other, token.amount], nonce, gas: 100_000n });
      await rpc("evm_mine", []);
    } finally { await rpc("evm_setAutomine", [true]); }
    await pending; if (pendingError) throw pendingError;
    assert(sameBlockToken?.kind === "token" && sameBlockSpend);
    const spendReceipt = await read.waitForTransactionReceipt({ hash: sameBlockSpend });
    assert.equal(spendReceipt.status, "success");
    assert.equal(spendReceipt.blockNumber, sameBlockToken.receipt.blockNumber);
    assert(spendReceipt.transactionIndex > sameBlockToken.receipt.transactionIndex);
    assert.equal(await read.readContract({ address: first, abi: erc20Abi, functionName: "balanceOf",
      args: [actor], blockNumber: spendReceipt.blockNumber }), 0n);
    await checkResult(client, sameBlockToken);
    evidence.sameBlockSpend = { grant: sameBlockToken, spendReceipt, blockEndTokenBalance: "0" };
    scenarios.push("A claim followed by spending the entire token grant in the same block restores the receipt amount rather than the block-end zero balance");

    const nativeSpend = await read.waitForTransactionReceipt({ hash: await sender.sendTransaction({ to: other,
      value: native.amount / 2n }) });
    const laterBalance = await read.getBalance({ address: actor }); assert.notEqual(laterBalance, native.amount);
    await select(other);
    wallet.stop(); wallet = undefined;
    const restored = new ExchangeClient(deployment); await restored.verifyDeployment();
    wallet = new WalletController(restored, { storage: new FileStorage(storagePath) }); await wallet.start();
    await select(actor);
    for (const confirmation of [...confirmations, sameBlockToken]) await confirmedEntry(confirmation.receipt.transactionHash);
    const restoredNative = await confirmedEntry(native.receipt.transactionHash);
    assert.equal(restoredNative.authority, "dev-faucet"); assert(same(restoredNative.beneficiary, actor));
    const restoredContext: FundingRecoveryContext = { authority: restoredNative.authority, beneficiary: restoredNative.beneficiary };
    assert(transactionResultAvailable(deployment, restoredNative.descriptor, restoredContext));
    const restoredToken = await confirmedEntry(token.receipt.transactionHash);
    assert(restoredNative.descriptor && restoredToken.descriptor);
    assert(transactionResultAvailable(deployment, restoredToken.descriptor));
    await select(other);
    for (const confirmation of [...confirmations, sameBlockToken])
      await checkResult(restored, confirmation, confirmation.kind === "native" ? restoredContext : undefined);
    await select(actor);
    const archive = wallet; wallet.stop(); wallet = undefined;
    evidence.reconstructedHistory = { storagePath, nativeSpend, laterBalance, native: restoredNative, token: restoredToken };
    scenarios.push("A new client and file-backed wallet recover grants after account switching, later native spending and page reconstruction with the archived funding context");

    denyCurrentState = true;
    await assert.rejects(restored.rpc.getBalance({ address: actor }));
    const accountProbe = await fetch(proxyUrl, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_accounts", params: [] }) });
    assert.equal(accountProbe.status, 503);
    const probes = rejectedCurrentState; assert(probes >= 2);
    for (const confirmation of [...confirmations, sameBlockToken])
      await checkResult(restored, confirmation, confirmation.kind === "native" ? restoredContext : undefined);
    assert.equal(rejectedCurrentState, probes);
    denyCurrentState = false;
    evidence.unavailableCurrentState = { blockedProbes: probes, balanceAndAccountsRequestsDuringRecovery: 0 };
    scenarios.push("Historical recovery does not request current native balances or the currently unlocked account list");

    const ordinaryTransfer = await read.waitForTransactionReceipt({ hash: await sender.writeContract({ address: created,
      abi: erc20Abi, functionName: "transfer", args: [other, 1n] }) });
    const approval = await read.waitForTransactionReceipt({ hash: await sender.writeContract({ address: created,
      abi: erc20Abi, functionName: "approve", args: [harbor, 1n] }) });
    const wrap = await read.waitForTransactionReceipt({ hash: await sender.sendTransaction({ to: weth,
      value: parseEther("0.01"), data: "0x" }) });
    const fake = await read.waitForTransactionReceipt({ hash: await sender.writeContract({ address: foreign,
      abi: foreignArtifact.abi, functionName: "faucet" }) });
    for (const receipt of [ordinaryTransfer, approval, wrap, fake]) {
      assert.equal(receipt.status, "success"); assert.equal(await restored.fundingReceipt(receipt.transactionHash), null);
    }
    for (const context of [undefined, { authority: "wallet" as const, beneficiary: actor },
      { authority: "dev-faucet" as const, beneficiary: other }]) {
      assert.equal(await restored.fundingReceipt(native.receipt.transactionHash, context), null);
      assert.equal(await restored.transactionResult(native.receipt.transactionHash, context), null);
    }
    assert.equal(await restored.fundingReceipt(nativeSpend.transactionHash), null);
    evidence.ignoredReceipts = { ordinaryTransfer, approval, wrap, fake, ordinaryNative: nativeSpend };
    scenarios.push("Ordinary transfers, approvals, wrapped-token minting and an external faucet cannot become token grants, and native recovery requires matching archived dev-faucet context");

    let failedHash: Hex | undefined;
    await rpc("evm_setAutomine", [false]);
    try {
      failedHash = await emptySender.writeContract({ address: first, abi: tokenArtifact.abi,
        functionName: "faucet", gas: 22_000n });
      await rpc("evm_mine", []);
    } finally { await rpc("evm_setAutomine", [true]); }
    assert(failedHash);
    const failedReceipt = await read.waitForTransactionReceipt({ hash: failedHash });
    assert.equal(failedReceipt.status, "reverted");
    await assert.rejects(restored.fundingReceipt(failedHash));
    await assert.rejects(restored.transactionResult(failedHash));
    evidence.failedReceipt = failedReceipt;
    scenarios.push("A genuinely reverted token claim never becomes a successful funding result");

    for (const [method, confirmation, context] of [
      ["eth_getTransactionReceipt", token, undefined],
      ["eth_call", createdToken, undefined],
      ["eth_getTransactionByHash", native, restoredContext],
    ] as const) {
      const interrupted = new ExchangeClient({ ...deployment, rpcUrl: `${proxyUrl}/${method}` });
      await interrupted.verifyDeployment();
      deniedMethod = method;
      const priorRejected = rejected;
      await assert.rejects(interrupted.fundingReceipt(confirmation.receipt.transactionHash, context));
      assert(rejected > priorRejected);
      const entry = archive.kernel.getSnapshot().journal.find(row =>
        row.state === "confirmed" && same(row.hash, confirmation.receipt.transactionHash));
      assert(entry?.state === "confirmed");
      deniedMethod = undefined;
      await checkResult(interrupted, confirmation, context);
      evidence[method] = { hash: confirmation.receipt.transactionHash, rejectedRequests: rejected - priorRejected,
        historicalStatus: entry.state };
      scenarios.push(`${method} HTTP outage is explicit, preserves the confirmed archive and succeeds on an explicit later read`);
    }
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
