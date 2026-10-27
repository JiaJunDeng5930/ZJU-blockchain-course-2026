import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { getAddress, parseEventLogs, parseEther, parseUnits, erc20Abi } from "viem";
import { ExchangeClient } from "../src/chain/client";
import type { AssetFundingConfirmation, Deployment } from "../src/chain/types";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, root, until } from "./support/chain.mts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) => JSON.stringify(value,
  (_key, v) => typeof v === "bigint" ? v.toString() : v, 2);

async function main() {
  const env = await isolatedChain("funding-confirmation-public");
  const { directory, artifact, deploy, read, accounts, rpc } = env;
  let wallet: WalletController | undefined;
  let armReceiptFor: string | undefined;
  let unavailableReads = false;
  let rejectSendTo: string | undefined;
  let rejectedReads = 0;
  const proxy = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      const items = Array.isArray(input) ? input : [input];
      const rejected = items.find(item =>
        (unavailableReads && ["eth_call", "eth_getBalance"].includes(item.method)) ||
        (rejectSendTo && item.method === "eth_sendTransaction" &&
          item.params[0].to && same(item.params[0].to, rejectSendTo)));
      if (rejected) {
        if (unavailableReads) rejectedReads++;
        response.writeHead(200, { "content-type": "application/json" });
        const error = (item: { id: unknown }) => ({ jsonrpc: "2.0", id: item.id,
          error: { code: unavailableReads ? -32000 : 4001, message: unavailableReads
            ? "Funding balance observation temporarily unavailable"
            : "User rejected the second asset signing request" } });
        response.end(JSON.stringify(Array.isArray(input) ? items.map(error) : error(input)));
        return;
      }
      const upstream = await fetch(env.rpcUrl, { method: "POST",
        headers: { "content-type": "application/json" }, body });
      const output = await upstream.text();
      if (armReceiptFor && items.some(item => item.method === "eth_getTransactionReceipt")) {
        const decoded = JSON.parse(output);
        const responses = Array.isArray(decoded) ? decoded : [decoded];
        if (responses.some(item => item.result?.status === "0x1" && item.result.to &&
          same(item.result.to, armReceiptFor!))) {
          unavailableReads = true;
          armReceiptFor = undefined;
        }
      }
      response.writeHead(upstream.status, { "content-type": "application/json" });
      response.end(output);
    } catch (error) {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(String(error));
    }
  });
  await new Promise<void>(accept => proxy.listen(0, "127.0.0.1", accept));
  const address = proxy.address();
  assert(address && typeof address !== "string");
  const scenarios: string[] = [];
  const evidence: Record<string, unknown> = {};
  const fingerprints = async () => Object.fromEntries(await Promise.all([
    "frontend/src/generated/dex_logic.js", "frontend/src/chain/client.ts",
    "frontend/src/chain/assets.ts", "frontend/src/chain/types.ts",
    "frontend/src/wallet/session.ts", "frontend/src/wallet/kernel.ts",
  ].map(async file => [file, createHash("sha256")
    .update(await readFile(resolve(root, file))).digest("hex")])));
  let sources: Record<string, string> = {};
  try {
    sources = await fingerprints();
    if (process.env.DEX_EXPECTED_KERNEL_SHA256)
      assert.equal(sources["frontend/src/generated/dex_logic.js"], process.env.DEX_EXPECTED_KERNEL_SHA256);
    const tokenArtifact = await artifact("TestToken");
    const wrapped = await artifact("WrappedEther");
    const dex = await artifact("MiniDEX");
    const arb = await artifact("AtomicArbitrage");
    const first = await deploy(tokenArtifact, ["Funding Alpha", "FUND"]);
    const second = await deploy(tokenArtifact, ["Funding Beta", "FUND"]);
    const weth = await deploy(wrapped);
    const harbor = await deploy(dex, ["Funding market"]);
    const summit = await deploy(dex, ["Funding second market"]);
    const arbitrage = await deploy(arb);
    const deployment: Deployment = {
      schemaVersion: 1, chainId: 31337,
      rpcUrl: `http://127.0.0.1:${address.port}`,
      tokens: [
        { address: first, name: "Funding Alpha", symbol: "FUND", kind: "faucet", decimals: 18 },
        { address: second, name: "Funding Beta", symbol: "FUND", kind: "faucet", decimals: 18 },
        { address: weth, name: "Wrapped Ether", symbol: "WETH", kind: "wrapped", decimals: 18 },
      ],
      exchanges: [{ address: harbor, name: "Funding market" },
        { address: summit, name: "Funding second market" }],
      arbitrage, bytecodes: { TestToken: tokenArtifact.bytecode },
    };
    const client = new ExchangeClient(deployment);
    await client.verifyDeployment();
    const actor = accounts[3];
    const other = accounts[4];
    await rpc("hardhat_setBalance", [actor, "0x0"]);
    wallet = new WalletController(client, { storage: null });
    await wallet.start();
    const select = async (owner: string) => {
      wallet!.dispatch({ kind: "select-local", address: owner });
      await until(() => wallet!.session(), s => !!s && same(s.address, owner), "selected funding recipient");
    };
    const perform = async (label: string,
      action: Parameters<WalletController["perform"]>[0]["perform"]) => {
      const session = wallet!.session();
      assert(session);
      await wallet!.perform({ label, session, perform: action });
    };
    const nativeAt = (owner: string, blockNumber: bigint) =>
      read.getBalance({ address: getAddress(owner), blockNumber });
    const tokenAt = (token: string, owner: string, blockNumber: bigint) =>
      read.readContract({ address: getAddress(token), abi: tokenArtifact.abi,
        functionName: "balanceOf", args: [getAddress(owner)], blockNumber }) as Promise<bigint>;
    const journalFee = async (result: AssetFundingConfirmation) => {
      const entry = await until(() => wallet!.kernel.getSnapshot().journal.find(row =>
        row.state === "confirmed" && same(row.hash, result.receipt.transactionHash)),
      row => !!row, "confirmed funding journal entry");
      assert(entry && entry.state === "confirmed");
      assert.equal(BigInt(entry.gas), result.gasCostWei);
      return entry;
    };
    await select(actor);
    const beforeFunding = await client.snapshot(actor, deployment.tokens);
    const capturedWallet = wallet.kernel.getSnapshot().wallet;
    assert.equal(capturedWallet.kind, "ready");
    assert(capturedWallet.kind === "ready");
    const identity = capturedWallet.identity;
    const observation = (snapshot: typeof beforeFunding, observedIdentity = identity) => ({
      identity: observedIdentity, ether: snapshot.ether.toString(),
      tokens: deployment.tokens.map(token => ({ address: token.address,
        kind: token.kind, balance: snapshot.balances[token.address].toString() })),
    });
    const initialPlan = wallet.kernel.fundingPlanAfterConfirmations(
      observation(beforeFunding), String(beforeFunding.block));
    assert(initialPlan.kind === "need-funding" && initialPlan.native);
    assert.deepEqual(initialPlan.tokens.map(a => a.toLowerCase()).sort(),
      [first, second].map(a => a.toLowerCase()).sort());
    let native: AssetFundingConfirmation | undefined;
    armReceiptFor = actor;
    await perform("Confirm native grant independently of later reads", async writer => {
      native = await writer.claimEther();
    });
    assert(native && native.kind === "native");
    assert(same(native.recipient, actor));
    assert(!same(native.receipt.from, actor));
    assert(native.receipt.to && same(native.receipt.to, actor));
    assert.equal(native.amount, parseEther("10"));
    const nb = native.receipt.blockNumber;
    const recipientBefore = await nativeAt(actor, nb - 1n);
    const recipientAfter = await nativeAt(actor, nb);
    const payerBefore = await nativeAt(native.receipt.from, nb - 1n);
    const payerAfter = await nativeAt(native.receipt.from, nb);
    assert.equal(recipientAfter - recipientBefore, native.amount);
    assert.equal(payerBefore - payerAfter - native.amount, native.gasCostWei);
    assert(native.gasCostWei > 0n);
    await journalFee(native);
    wallet.kernel.recordFunding(identity, String(nb));
    assert.equal(wallet.kernel.fundingPlanAfterConfirmations(
      observation(beforeFunding), String(beforeFunding.block)).kind, "awaiting-balances");
    assert.equal(wallet.kernel.fundingPlanAfterConfirmations(null, null).kind, "loading");
    await assert.rejects(() => client.snapshot(actor, deployment.tokens));
    assert(rejectedReads > 0);
    unavailableReads = false;
    scenarios.push("Native funding confirms a real recipient grant while the other local sender pays its fee");
    evidence.native = { result: native, recipientBefore, recipientAfter, payerBefore, payerAfter };

    let claimed: AssetFundingConfirmation | undefined;
    armReceiptFor = first;
    await perform("Confirm ERC20 grant independently of later reads", async writer => {
      claimed = await writer.faucet(deployment.tokens[0]);
    });
    assert(claimed && claimed.kind === "token");
    assert(same(claimed.recipient, actor) && same(claimed.receipt.from, actor));
    assert(same(claimed.token.address, first));
    const mint = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: claimed.receipt.logs, strict: true })
      .find(log => same(log.address, first) && String(log.args.from) === "0x0000000000000000000000000000000000000000" &&
        same(String(log.args.to), actor));
    assert(mint);
    assert.equal(claimed.amount, mint.args.value);
    assert.equal(claimed.amount, parseUnits("10000", 18));
    const cb = claimed.receipt.blockNumber;
    const tokenBefore = await tokenAt(first, actor, cb - 1n);
    const tokenAfter = await tokenAt(first, actor, cb);
    assert.equal(tokenAfter - tokenBefore, claimed.amount);
    assert.equal(await nativeAt(actor, cb - 1n) - await nativeAt(actor, cb), claimed.gasCostWei);
    await journalFee(claimed);
    wallet.kernel.recordFunding(identity, String(cb));
    await assert.rejects(() => client.snapshot(actor, deployment.tokens));
    unavailableReads = false;
    const afterClaims = await until(() => client.snapshot(actor, deployment.tokens),
      snapshot => BigInt(snapshot.block) >= cb, "balance snapshot reaches confirmed grant block");
    scenarios.push("ERC20 funding uses its own mint event and keeps confirmation when balance reads fail");
    evidence.token = { result: claimed, tokenBefore, tokenAfter };

    const confirmedBefore = wallet.kernel.fundingPlanAfterConfirmations(
      observation(beforeFunding), String(beforeFunding.block));
    assert.equal(confirmedBefore.kind, "awaiting-balances");
    const currentPlan = wallet.kernel.fundingPlanAfterConfirmations(
      observation(afterClaims), String(afterClaims.block));
    assert(currentPlan.kind === "need-funding" && !currentPlan.native);
    assert.deepEqual(currentPlan.tokens.map(a => a.toLowerCase()), [second.toLowerCase()]);
    const blockBeforeFailure = BigInt(await rpc("eth_blockNumber") as string);
    rejectSendTo = second;
    await assert.rejects(() => perform("Partially completed asset preparation", async writer => {
      await writer.faucet(deployment.tokens[1]);
    }));
    rejectSendTo = undefined;
    assert.equal(BigInt(await rpc("eth_blockNumber") as string), blockBeforeFailure,
      "A failed second signing request did not mint another token or repeat successful grants");
    assert.equal(wallet.kernel.fundingPlanAfterConfirmations(
      observation(beforeFunding), String(beforeFunding.block)).kind, "awaiting-balances",
      "A later preparation failure does not erase previously confirmed grants");
    assert.deepEqual(wallet.kernel.fundingPlanAfterConfirmations(
      observation(afterClaims), String(afterClaims.block)), currentPlan);
    const journal = wallet.kernel.getSnapshot().journal;
    assert(journal.some(row => row.state === "confirmed" && same(row.hash, native!.receipt.transactionHash)));
    assert(journal.some(row => row.state === "confirmed" && same(row.hash, claimed!.receipt.transactionHash)));
    let retried: AssetFundingConfirmation | undefined;
    await perform("Retry only the missing asset after cancellation", async writer => {
      retried = await writer.faucet(deployment.tokens[1]);
    });
    assert(retried && retried.kind === "token");
    assert(same(retried.token.address, second) && same(retried.recipient, actor));
    assert.equal(retried.receipt.blockNumber, blockBeforeFailure + 1n);
    wallet.kernel.recordFunding(identity, String(retried.receipt.blockNumber));
    const readySnapshot = await until(() => client.snapshot(actor, deployment.tokens),
      snapshot => BigInt(snapshot.block) >= retried!.receipt.blockNumber,
      "recovered balance snapshot reaches the final grant");
    assert.equal(wallet.kernel.fundingPlanAfterConfirmations(
      observation(readySnapshot), String(readySnapshot.block)).kind, "ready");
    assert.equal(readySnapshot.balances[getAddress(first)], tokenAfter,
      "Retrying the missing asset did not repeat the already confirmed mint");
    assert.equal(readySnapshot.balances[getAddress(second)], parseUnits("10000", 18));
    await journalFee(retried);
    scenarios.push("Automatic preparation waits for fresh balances and recovers partial completion without repeating grants");
    evidence.progress = { beforeFunding, afterClaims, readySnapshot, initialPlan, confirmedBefore, currentPlan,
      nativeHash: native.receipt.transactionHash, tokenHash: claimed.receipt.transactionHash, retry: retried };

    await rpc("hardhat_setBalance", [other, "0x0"]);
    await select(other);
    const nextWallet = wallet.kernel.getSnapshot().wallet;
    assert(nextWallet.kind === "ready");
    const nextSnapshot = await client.snapshot(other, deployment.tokens);
    wallet.kernel.recordFunding(identity, String(cb));
    const nextPlan = wallet.kernel.fundingPlanAfterConfirmations(
      observation(nextSnapshot, nextWallet.identity), String(nextSnapshot.block));
    assert(nextPlan.kind === "need-funding" && nextPlan.native);
    assert.deepEqual(nextPlan.tokens.map(a => a.toLowerCase()).sort(),
      [first, second].map(a => a.toLowerCase()).sort());
    const previousObservation = wallet.kernel.fundingPlanAfterConfirmations(
      observation(afterClaims), String(afterClaims.block));
    assert.equal(previousObservation.kind, "loading");
    scenarios.push("A different real wallet cannot inherit confirmed funding or consume an older wallet observation");
    evidence.identity = { recipient: other, nextSnapshot, nextPlan, previousObservation };
    assert.deepEqual(await fingerprints(), sources);
    await writeFile(resolve(directory, "result.json"), json({ status: "passed",
      kernelSha256: sources["frontend/src/generated/dex_logic.js"], sourceFingerprints: sources,
      scenarios, evidence }) + "\n");
    console.log(json({ status: "passed", scenarios: scenarios.length, directory }));
  } catch (error) {
    await writeFile(resolve(directory, "result.json"), json({ status: "failed",
      error: String(error), kernelSha256: sources["frontend/src/generated/dex_logic.js"],
      sourceFingerprints: sources, scenarios, evidence }) + "\n");
    throw error;
  } finally {
    wallet?.stop();
    proxy.closeAllConnections();
    await new Promise<void>(done => proxy.close(() => done()));
    await env.close();
  }
}
await main();
