import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, defineChain, getAddress, http,
  type Abi, type Address, type Hex,
} from "viem";
import type { Deployment, Token } from "../src/chain/types";
import { ExchangeClient } from "../src/chain/client";
import { WalletController } from "../src/wallet/session";
import { AllowanceController } from "../src/chain/allowances";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bundlePath = resolve(root, "frontend/src/generated/dex_logic.js");
const hashProgram = async () => createHash("sha256").update(await readFile(bundlePath)).digest("hex");
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const tokenAbi = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

type Rpc = { id: string | number; jsonrpc: string; method: string; params: unknown[] };
async function rpc(url: string, method: string, params: unknown[] = []) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const value = await response.json();
  if (value.error) throw new Error(`${method}: ${JSON.stringify(value.error)}`);
  return value.result;
}
async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, label: string, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (done(value)) return value;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const socket = createSocketServer();
  await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((done, reject) => socket.close((error) => error ? reject(error) : done()));
  return port;
}
async function main() {
  const directory = await mkdtemp(resolve(root, ".local/allowances-public-"));
  const programSha256 = await hashProgram();
  const port = await freePort(), upstream = `http://127.0.0.1:${port}`;
  const log = await open(resolve(directory, "chain.log"), "w");
  const node = spawn(process.execPath, [resolve(root, "contracts/node_modules/hardhat/dist/src/cli.js"), "node", "--network", "hardhat", "--port", String(port)], {
    cwd: resolve(root, "contracts"), detached: true, stdio: ["ignore", log.fd, log.fd],
  });
  await writeFile(resolve(directory, "launch.json"), JSON.stringify({ pid: node.pid, upstream, cwd: resolve(root, "contracts") }, null, 2));
  const writes: Rpc[] = [], observations: Rpc[] = [], scenarios: { scenario: string; outcome: string }[] = [];
  let failRead: string | null = null, failAfterWrite: string | null = null;
  let heldOwner: string | null = null, held = false;
  const releases: (() => void)[] = [];
  const handle = async (request: Rpc) => {
    const call = request.params?.[0] as { to?: string; data?: string } | undefined;
    const isAllowance = request.method === "eth_call" && call?.data?.startsWith("0xdd62ed3e");
    if (isAllowance) observations.push(request);
    if (isAllowance && heldOwner && call?.data?.slice(34, 74).toLowerCase() === heldOwner.slice(2).toLowerCase()) {
      held = true;
      await new Promise<void>((done) => { releases.push(done); });
    }
    if (isAllowance && failRead && call?.to && same(call.to, failRead))
      return { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Acceptance: allowance observation unavailable" } };
    const response = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    const value = await response.json();
    if (request.method === "eth_sendTransaction" || request.method === "eth_sendRawTransaction") {
      writes.push(request);
      if (failAfterWrite && call?.to && same(call.to, failAfterWrite)) {
        failRead = failAfterWrite;
        failAfterWrite = null;
      }
    }
    return value;
  };
  const proxy = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Rpc | Rpc[];
    const result = Array.isArray(body) ? await Promise.all(body.map(handle)) : await handle(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result));
  });
  const evidence: Record<string, unknown> = { status: "running", programSha256, scenarios };
  const scenario = async (name: string, run: () => Promise<void>) => {
    await run();
    scenarios.push({ scenario: name, outcome: "passed" });
  };
  try {
    await until(async () => {
      // DEFENSE: the new isolated node has not bound its RPC port during startup.
      try { return await rpc(upstream, "eth_chainId"); }
      catch (error) { if (error instanceof TypeError) return null; throw error; }
    }, (value) => value === "0x7a69", "isolated node startup");
    const accounts = (await rpc(upstream, "eth_accounts") as string[]).map((address) => getAddress(address));
    const chain = defineChain({ id: 31337, name: "Allowance acceptance", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [upstream] } } });
    const read = createPublicClient({ chain, transport: http(upstream) });
    const admin = createWalletClient({ account: accounts[0], chain, transport: http(upstream) });
    const artifact = async (name: string) => JSON.parse(await readFile(resolve(root, `contracts/artifacts/contracts/${name}.sol/${name}.json`), "utf8"));
    const deploy = async (compiled: { abi: Abi; bytecode: Hex }, args: readonly unknown[] = []) => {
      const hash = await admin.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode, args });
      const receipt = await read.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      assert(receipt.contractAddress);
      return getAddress(receipt.contractAddress);
    };
    const testToken = await artifact("TestToken");
    const tokenA = await deploy(testToken, ["Allowance A", "ALA"]), tokenB = await deploy(testToken, ["Allowance B", "ALB"]);
    const weth = await deploy(await artifact("WrappedEther"));
    const first = await deploy(await artifact("MiniDEX"), ["Allowance DEX A"]), second = await deploy(await artifact("MiniDEX"), ["Allowance DEX B"]);
    const arbitrage = await deploy(await artifact("AtomicArbitrage"));
    const sourcePath = "contracts/test/fixtures/RefusingApproval.sol";
    const compiled = spawnSync(resolve(root, ".local/toolchain/solc"), ["--base-path", root, "--include-path", resolve(root, "contracts/node_modules"), "--standard-json"], {
      input: JSON.stringify({ language: "Solidity", sources: { [sourcePath]: { content: await readFile(resolve(root, sourcePath), "utf8") } }, settings: { evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } }), encoding: "utf8",
    });
    assert.equal(compiled.status, 0, compiled.stderr);
    await writeFile(resolve(directory, "fixture-compiler.json"), compiled.stdout);
    const output = JSON.parse(compiled.stdout);
    assert(!output.errors?.some((error: { severity: string }) => error.severity === "error"), compiled.stdout);
    const refusingArtifact = output.contracts[sourcePath].RefusingApproval;
    const refusing = await deploy({ abi: refusingArtifact.abi, bytecode: `0x${refusingArtifact.evm.bytecode.object}` });
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    const rpcUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const tokens: Token[] = [
      { address: tokenA, name: "Allowance A", symbol: "ALA", decimals: 18, kind: "faucet" },
      { address: tokenB, name: "Allowance B", symbol: "ALB", decimals: 18, kind: "faucet" },
      { address: weth, name: "Wrapped Ether", symbol: "WETH", decimals: 18, kind: "wrapped" },
      { address: refusing, name: "Refusing Approval", symbol: "REFUSE", decimals: 18, kind: "external" },
    ];
    const deployment: Deployment = { schemaVersion: 1, chainId: 31337, rpcUrl, tokens: tokens.slice(0, 3), exchanges: [{ address: first, name: "Allowance DEX A" }, { address: second, name: "Allowance DEX B" }], arbitrage, bytecodes: { TestToken: testToken.bytecode } };
    const client = new ExchangeClient(deployment);
    await client.verifyDeployment();
    const wallet = new WalletController(client, { storage: null });
    await wallet.start();
    const select = async (owner: Address) => {
      wallet.dispatch({ kind: "select-local", address: owner });
      await until(() => wallet.session(), (session) => !!session && same(session.address, owner), "selected wallet");
    };
    const owner = accounts[1], other = accounts[2];
    const send = async (address: Address, abi: Abi, functionName: string, args: readonly unknown[], account: Address = owner) => {
      const hash = await admin.writeContract({ account, address, abi, functionName, args });
      const receipt = await read.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
    };
    const allowance = (token: Address, account: Address, spender: Address) => read.readContract({ address: token, abi: tokenAbi, functionName: "allowance", args: [account, spender] });
    await select(owner);
    const approvals = new AllowanceController(client, wallet, tokens);
    const view = () => approvals.getSnapshot();
    const row = (token: string, spender: string) => {
      const entry = view().rows.find((entry) => same(entry.token, token) && same(entry.spender, spender));
      assert(entry, `Missing row ${token}/${spender}`);
      return entry;
    };
    const dexAbi = (await artifact("MiniDEX")).abi as Abi;
    await send(tokenA, testToken.abi, "faucet", []);
    await send(tokenB, testToken.abi, "faucet", []);
    await send(tokenA, tokenAbi, "approve", [first, 100n * 10n ** 18n]);
    await send(tokenB, tokenAbi, "approve", [first, 100n * 10n ** 18n]);
    await send(first, dexAbi, "createPool", [tokenA, tokenB]);
    const poolId = await read.readContract({ address: first, abi: dexAbi, functionName: "getPool", args: [tokenA, tokenB] });
    const block = await read.getBlock();
    await send(first, dexAbi, "addLiquidity", [poolId, 10n ** 18n, 10n ** 18n, 10n ** 18n, 10n ** 18n, block.timestamp + 300n]);
    await send(tokenA, tokenAbi, "approve", [first, 11n * 10n ** 18n]);
    await send(tokenA, tokenAbi, "approve", [second, 5n * 10n ** 18n]);
    await send(tokenB, tokenAbi, "approve", [first, 3n * 10n ** 18n]);
    await send(tokenA, tokenAbi, "approve", [first, 7n * 10n ** 18n], other);
    const maximum = (1n << 256n) - 1n;
    await send(weth, tokenAbi, "approve", [arbitrage, maximum]);
    await send(refusing, refusingArtifact.abi, "seed", [owner, first, 9n * 10n ** 18n]);
    const protectedState = async () => ({
      otherOwner: await allowance(tokenA, other, first),
      otherSpender: await allowance(tokenA, owner, second),
      otherToken: await allowance(tokenB, owner, first),
      tokenABalance: await read.readContract({ address: tokenA, abi: tokenAbi, functionName: "balanceOf", args: [owner] }),
      tokenBBalance: await read.readContract({ address: tokenB, abi: tokenAbi, functionName: "balanceOf", args: [owner] }),
      dexTokenABalance: await read.readContract({ address: tokenA, abi: tokenAbi, functionName: "balanceOf", args: [first] }),
      dexTokenBBalance: await read.readContract({ address: tokenB, abi: tokenAbi, functionName: "balanceOf", args: [first] }),
      pool: await read.readContract({ address: first, abi: dexAbi, functionName: "pools", args: [poolId] }),
    });
    await scenario("The public view reads actual owner/token/spender allowances at a fixed block", async () => {
      const observationStart = observations.length;
      await approvals.refresh();
      assert.equal(view().phase, "ready");
      assert.equal(view().owner, owner);
      assert.equal(row(tokenA, first).allowance, (11n * 10n ** 18n).toString());
      assert.equal(row(tokenA, second).allowance, (5n * 10n ** 18n).toString());
      assert.equal(row(weth, arbitrage).allowance, maximum.toString());
      assert.equal(row(tokenA, arbitrage).allowance, "0");
      assert.equal(row(tokenA, arbitrage).canRevoke, false);
      assert(view().block !== null);
      evidence.initialObservation = structuredClone(view());
      const calls = observations.slice(observationStart);
      assert(calls.length > 0);
      const expectedBlock = `0x${BigInt(view().block!).toString(16)}`;
      assert(calls.every((call) => call.params[1] === expectedBlock), "Every allowance in the snapshot must be read from its reported block");
      evidence.fixedBlockObservation = { block: view().block, calls: calls.length };
    });
    await scenario("Zero and out-of-deployment spenders cannot issue a revoke", async () => {
      const before = writes.length;
      approvals.review(tokenA, arbitrage);
      await approvals.confirm();
      assert.equal(view().review, null);
      approvals.review(tokenA, accounts[8]);
      await approvals.confirm();
      assert.equal(view().review, null);
      assert.equal(writes.length, before);
    });
    await scenario("Cancelling a reviewed positive allowance does not send a wallet transaction", async () => {
      const before = writes.length;
      approvals.review(tokenA, first);
      assert.equal(view().review?.owner, owner);
      assert.equal(view().review?.token, tokenA);
      assert.equal(view().review?.spender, first);
      approvals.cancel();
      await approvals.confirm();
      assert.equal(view().review, null);
      assert.equal(writes.length, before);
      assert.equal(await allowance(tokenA, owner, first), 11n * 10n ** 18n);
    });
    await scenario("A revoke clears exactly one real allowance and retains balances, pool reserves, and other approvals", async () => {
      const before = await protectedState(), count = writes.length;
      approvals.review(tokenA, first);
      await approvals.confirm();
      assert.equal(view().action.kind, "verified");
      assert.equal(await allowance(tokenA, owner, first), 0n);
      assert.equal(row(tokenA, first).allowance, "0");
      assert.equal(row(tokenA, first).canRevoke, false);
      const after = await protectedState();
      assert.deepEqual(after, before);
      evidence.isolatedRevoke = { before, after, action: view().action };
      assert.equal(writes.length, count + 1);
      const journal = wallet.kernel.getSnapshot().journal;
      const last = journal.find((entry) => "hash" in entry && entry.hash === view().action.hash);
      assert(last && last.state === "confirmed");
      assert.equal(last.account, owner);
    });
    await scenario("A previously unlimited WETH allowance is identified and can be revoked", async () => {
      assert.equal(row(weth, arbitrage).allowance, maximum.toString());
      assert.equal(row(weth, arbitrage).unlimited, true);
      assert.equal(row(tokenB, first).unlimited, false);
      approvals.review(weth, arbitrage);
      await approvals.confirm();
      assert.equal(view().action.kind, "verified");
      assert.equal(await allowance(weth, owner, arbitrage), 0n);
      assert.equal(row(weth, arbitrage).allowance, "0");
      evidence.unlimitedWethRevoke = view().action;
    });
    await scenario("A failed allowance observation stays unknown and does not disable unrelated rows", async () => {
      failRead = tokenA;
      await approvals.refresh();
      assert.equal(row(tokenA, second).allowance, null);
      assert(row(tokenA, second).error);
      assert.equal(row(tokenA, second).canRevoke, false);
      assert.equal(row(tokenB, first).allowance, (3n * 10n ** 18n).toString());
      failRead = null;
      await approvals.refresh();
      assert.equal(row(tokenA, second).allowance, (5n * 10n ** 18n).toString());
    });
    await scenario("An ERC20 false approval result is refused without broadcasting or reporting revocation", async () => {
      const count = writes.length;
      approvals.review(refusing, first);
      await approvals.confirm();
      assert.equal(view().action.kind, "error");
      assert.equal(writes.length, count);
      assert.equal(await allowance(refusing, owner, first), 9n * 10n ** 18n);
    });
    await scenario("A confirmed revoke with an unavailable post-read remains confirmed and can be verified later", async () => {
      failAfterWrite = tokenA;
      approvals.review(tokenA, second);
      await approvals.confirm();
      assert.equal(view().action.kind, "unverified");
      assert.equal(await allowance(tokenA, owner, second), 0n);
      const hash = view().action.hash;
      evidence.unverifiedAfterReceipt = view().action;
      const entry = wallet.kernel.getSnapshot().journal.find((entry) => "hash" in entry && entry.hash === hash);
      assert(entry && entry.state === "confirmed");
      failRead = null;
      await approvals.refresh();
      assert.equal(row(tokenA, second).allowance, "0");
      assert.equal(view().action.kind, "verified");
      evidence.verifiedAfterRetry = view().action;
      assert(wallet.kernel.getSnapshot().journal.some((entry) => "hash" in entry && entry.hash === hash && entry.state === "confirmed"));
    });
    await scenario("Changing accounts invalidates a prepared revoke rather than spending from the new account", async () => {
      approvals.review(tokenB, first);
      assert(view().review);
      const count = writes.length;
      await select(other);
      await approvals.confirm();
      assert.equal(view().review, null);
      assert.equal(writes.length, count);
      assert.equal(await allowance(tokenB, owner, first), 3n * 10n ** 18n);
    });
    await scenario("A delayed old-account observation cannot replace the newer account snapshot", async () => {
      await select(owner);
      heldOwner = owner;
      const pending = approvals.refresh();
      await until(() => held, Boolean, "old-account allowance request held at RPC");
      await select(other);
      await approvals.refresh();
      assert.equal(view().owner, other);
      assert.equal(row(tokenA, first).allowance, (7n * 10n ** 18n).toString());
      heldOwner = null;
      releases.splice(0).forEach((done) => done());
      await pending;
      assert.equal(view().owner, other);
      assert.equal(row(tokenA, first).allowance, (7n * 10n ** 18n).toString());
    });
    approvals.dispose();
    assert.equal(await hashProgram(), programSha256, "The generated bundle changed during acceptance");
    evidence.status = "passed";
    evidence.walletWrites = writes.length;
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
    throw error;
  } finally {
    heldOwner = null;
    releases.splice(0).forEach((done) => done());
    proxy.closeAllConnections();
    if (proxy.listening) await new Promise<void>((done) => proxy.close(() => done()));
    if (node.exitCode === null && node.pid) {
      // DEFENSE: the node may exit between this observation and the group signal.
      try { process.kill(-node.pid, "SIGTERM"); }
      catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error; }
    }
    await log.close();
    await writeFile(resolve(directory, "rpc-writes.json"), JSON.stringify(writes, null, 2));
    await writeFile(resolve(directory, "rpc-observations.json"), JSON.stringify(observations, null, 2));
    await writeFile(resolve(directory, "result.json"), JSON.stringify(evidence, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
    console.log(JSON.stringify({ status: evidence.status, evidence: resolve(directory, "result.json"), walletWrites: writes.length }));
  }
}
await main();
