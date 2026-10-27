import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { open, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWalletClient,
  getAddress,
  http,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type Transaction,
} from "viem";
import { ExchangeClient } from "../src/chain/client";
import { WalletController } from "../src/wallet/session";
import type { Deployment, Pool, Token } from "../src/chain/types";
import { delay, isolatedChain, root, until } from "./support/chain.mts";

type Journal = ReturnType<WalletController["kernel"]["getSnapshot"]>["journal"];
type Entry = Journal[number];
type Write = { from: string; to?: string; data?: string; hash?: string };
type Request = { method: string; params: unknown[]; completed?: boolean };
const self = fileURLToPath(import.meta.url);
const loader = resolve(root, "contracts/node_modules/tsx/dist/loader.mjs");
const bundle = resolve(root, "frontend/src/generated/dex_logic.js");
const programHash = async () =>
  createHash("sha256")
    .update(await readFile(bundle))
    .digest("hex");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const stringify = (value: unknown) =>
  JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? item.toString() : item
  );
const hashOf = (entry: Entry) => ("hash" in entry ? entry.hash : undefined);
const rowFor = (wallet: WalletController, ids: Set<string>) =>
  wallet.kernel.getSnapshot().journal.find((entry) => !ids.has(entry.id));

async function recordingEndpoint(upstream: string) {
  const writes: Write[] = [];
  const requests: Request[] = [];
  const dropped = new Set<string>();
  const failedReceipts = new Set<string>();
  const server = createServer(async (request, response) => {
    if (request.url === "/acceptance/status") {
      response.setHeader("content-type", "application/json");
      response.end(stringify({ writes, requests }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const recorded: Request = {
      method: input.method,
      params: input.params ?? [],
    };
    requests.push(recorded);
    const hash = String(input.params?.[0] ?? "").toLowerCase();
    const answer = (body: unknown) => {
      recorded.completed = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(stringify(body));
    };
    if (
      dropped.has(hash) &&
      (input.method === "eth_getTransactionByHash" ||
        input.method === "eth_getTransactionReceipt")
    ) {
      answer({ jsonrpc: "2.0", id: input.id, result: null });
      return;
    }
    if (
      failedReceipts.has(hash) &&
      input.method === "eth_getTransactionReceipt"
    ) {
      answer({
        jsonrpc: "2.0",
        id: input.id,
        error: { code: -32005, message: "Receipt service unavailable" },
      });
      return;
    }
    try {
      const write =
        input.method === "eth_sendTransaction"
          ? ({ ...input.params[0] } as Write)
          : null;
      if (write) writes.push(write);
      const result = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stringify(input),
      }).then((reply) => reply.json());
      if (write && typeof result.result === "string")
        write.hash = result.result;
      answer(result);
    } catch (error) {
      // DEFENSE: the isolated node or a deliberately interrupted worker can close an active RPC request.
      answer({
        jsonrpc: "2.0",
        id: input.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  return {
    writes,
    requests,
    dropped,
    failedReceipts,
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done()))
      );
    },
  };
}

async function select(wallet: WalletController, address: Address) {
  wallet.dispatch({ kind: "select-local", address });
  return until(
    () => wallet.session(),
    (session) => !!session && same(session.address, address),
    "selected public wallet session"
  );
}

function verifyReplacement(
  row: Entry,
  original: Hex,
  replacement: Hex,
  kind: "repriced" | "replaced"
) {
  assert.equal(row.originalHash?.toLowerCase(), original.toLowerCase());
  assert.equal(hashOf(row)?.toLowerCase(), replacement.toLowerCase());
  assert.equal(
    row.replacements.filter(
      (step) =>
        same(step.hash, original) &&
        same(step.replacementHash, replacement) &&
        step.kind === kind
    ).length,
    1,
    "one observed replacement is recorded once, including duplicate observers"
  );
}

async function worker(mode: string, directory: string, name: string) {
  const fixture = JSON.parse(
    await readFile(resolve(directory, `fixture-${name}.json`), "utf8")
  ) as {
    deployment: Deployment;
    account: Address;
    original?: Hex;
    replacement?: Hex;
    expected?: "confirmed" | "replaced" | "unknown";
    legacy?: boolean;
    holdUntilReplaced?: boolean;
  };
  const client = new ExchangeClient(fixture.deployment);
  await client.verifyDeployment();
  const controller = new WalletController(client, { storage: localStorage });
  await controller.start();
  const evidence: Record<string, unknown> = {
    mode,
    name,
    programSha256: await programHash(),
  };
  if (mode === "produce") {
    const session = await select(controller, fixture.account);
    assert(session);
    const ids = new Set(
      controller.kernel.getSnapshot().journal.map((entry) => entry.id)
    );
    void controller
      .perform({
        label: `Recovery ${name}`,
        session,
        perform: async (writer) => {
          if (name === "faucet-replaced" || name === "saved-replaced")
            await writer.claimEther();
          else await writer.faucet(client.deployment.tokens[0]);
        },
      })
      .catch((error) => {
        evidence.operationError = String(error);
      });
    const row = await until(
      () => rowFor(controller, ids),
      (entry) =>
        !!entry &&
        entry.state === "submitted" &&
        entry.descriptor !== null &&
        controller.kernel.getSnapshot().history.kind === "ready",
      "acknowledged public pending descriptor"
    );
    assert(row && row.descriptor);
    evidence.entry = row;
    await writeFile(
      resolve(directory, `pending-${name}.tmp`),
      stringify(evidence)
    );
    await rename(
      resolve(directory, `pending-${name}.tmp`),
      resolve(directory, `pending-${name}.json`)
    );
    if (fixture.holdUntilReplaced) {
      const settled = await until(
        () => rowFor(controller, ids),
        (entry) =>
          !!entry &&
          entry.state === "replaced" &&
          "gas" in entry &&
          entry.gas !== undefined &&
          controller.kernel.getSnapshot().history.kind === "ready",
        "acknowledged replaced outcome before page exit"
      );
      assert(settled);
      evidence.entry = settled;
    }
    const archives: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      const raw = localStorage.getItem(key)!;
      let saved: unknown;
      try {
        saved = JSON.parse(raw);
      } catch {
        // DEFENSE: non-archive public wallet preferences are not necessarily JSON objects.
        continue;
      }
      if (
        saved &&
        typeof saved === "object" &&
        "version" in saved &&
        "entries" in saved
      ) {
        const archive = saved as {
          version: number;
          entries: Record<string, unknown>[];
        };
        if (fixture.legacy) {
          archive.version = 1;
          for (const entry of archive.entries) {
            delete entry.descriptor;
            delete entry.replacements;
            delete entry.originalHash;
          }
          localStorage.setItem(key, stringify(archive));
        }
        archives[key] = localStorage.getItem(key)!;
      }
    }
    assert(Object.keys(archives).length > 0, "a public archive was saved");
    evidence.archives = archives;
    await writeFile(
      resolve(directory, `produce-${name}.json`),
      stringify(evidence)
    );
    process.exit(0);
  }

  assert(fixture.original);
  const status = async () =>
    fetch(`${fixture.deployment.rpcUrl}/acceptance/status`).then((reply) =>
      reply.json()
    );
  controller.dispatch({ kind: "history-refresh" });
  if (fixture.expected === "unknown") {
    await until(
      status,
      (value) =>
        value.requests.some(
          (request: Request) =>
            request.completed &&
            request.method === "eth_getTransactionReceipt" &&
            same(String(request.params[0]), fixture.original!)
        ),
      "legacy observer attempted the known original receipt"
    );
    await delay(30);
    const attempts = (await status()).requests.filter(
      (request: Request) =>
        request.completed &&
        request.method === "eth_getTransactionReceipt" &&
        same(String(request.params[0]), fixture.original!)
    ).length;
    controller.dispatch({ kind: "history-refresh" });
    await until(
      status,
      (value) =>
        value.requests.filter(
          (request: Request) =>
            request.completed &&
            request.method === "eth_getTransactionReceipt" &&
            same(String(request.params[0]), fixture.original!)
        ).length > attempts,
      "unknown legacy outcome can be observed again without a new write"
    );
    await delay(30);
  } else {
    await until(
      () => controller.kernel.getSnapshot(),
      (view) =>
        view.journal.some(
          (entry) =>
            entry.originalHash === fixture.original &&
            entry.state === fixture.expected &&
            "gas" in entry &&
            entry.gas !== undefined
        ),
      "past replacement recovered through public history"
    );
  }
  if (fixture.replacement && fixture.expected !== "unknown") {
    await until(
      status,
      (value) =>
        value.requests.some(
          (request: Request) =>
            request.completed &&
            request.method === "eth_getTransactionReceipt" &&
            same(String(request.params[0]), fixture.replacement!)
        ),
      "replacement receipt response completed"
    );
    await delay(30);
  }
  const view = controller.kernel.getSnapshot();
  const row = view.journal.find(
    (entry) => entry.originalHash === fixture.original
  );
  assert(row);
  if (fixture.expected === "unknown") {
    assert.equal(row.state, "submitted");
    assert.equal(row.descriptor, null);
    assert.equal(hashOf(row), fixture.original);
    assert.equal(row.replacements.length, 0);
  } else assert.equal(row.state, fixture.expected);
  const original = JSON.parse(
    await readFile(resolve(directory, `produce-${name}.json`), "utf8")
  );
  for (const [key, raw] of Object.entries(original.archives))
    assert.equal(
      localStorage.getItem(key),
      raw,
      "a recovery observer must not rewrite the original page's archive"
    );
  evidence.entry = row;
  evidence.view = view;
  evidence.proxy = await status();
  await writeFile(
    resolve(directory, `recover-${name}.json`),
    stringify(evidence)
  );
  process.exit(0);
}

async function main() {
  const environment = await isolatedChain("replacements-public");
  const { directory, accounts, read, rpc, artifact, deploy } = environment;
  const proxy = await recordingEndpoint(environment.rpcUrl);
  const children = new Set<ChildProcess>();
  const programSha256 = await programHash();
  const scenarios: { scenario: string; outcome: string }[] = [];
  const evidence: Record<string, unknown> = {
    status: "running",
    programSha256,
    scenarios,
  };
  const check = async (name: string, action: () => Promise<void>) => {
    evidence.currentScenario = name;
    await action();
    assert.equal(await programHash(), programSha256);
    scenarios.push({ scenario: name, outcome: "passed" });
    delete evidence.currentScenario;
  };
  try {
    const token = await artifact("TestToken");
    const dex = await artifact("MiniDEX");
    const tokenA = await deploy(token, ["Replacement A", "RPA"]);
    const tokenB = await deploy(token, ["Replacement B", "RPB"]);
    const weth = await deploy(await artifact("WrappedEther"));
    const exchange = await deploy(dex, ["Replacement DEX"]);
    const second = await deploy(dex, ["Other DEX"]);
    const arbitrage = await deploy(await artifact("AtomicArbitrage"));
    const deployment: Deployment = {
      schemaVersion: 1,
      chainId: 31337,
      rpcUrl: proxy.url,
      tokens: [
        {
          address: tokenA,
          name: "Replacement A",
          symbol: "RPA",
          kind: "faucet",
          decimals: 18,
        },
        {
          address: tokenB,
          name: "Replacement B",
          symbol: "RPB",
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
        { address: exchange, name: "Replacement DEX" },
        { address: second, name: "Other DEX" },
      ],
      arbitrage,
      bytecodes: { TestToken: token.bytecode },
    };
    const client = new ExchangeClient(deployment);
    await client.verifyDeployment();
    const direct = async (
      account: Address,
      address: Address,
      functionName: string,
      args: readonly unknown[] = [],
      abi = token.abi
    ) => {
      const wallet = createWalletClient({
        account,
        chain: environment.chain,
        transport: http(environment.rpcUrl),
      });
      const hash = await wallet.writeContract({
        address,
        abi,
        functionName,
        args,
      });
      const receipt = await read.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      return receipt;
    };
    await direct(accounts[0], tokenA, "faucet");
    await direct(accounts[0], tokenB, "faucet");
    await direct(accounts[0], tokenA, "approve", [
      exchange,
      1_000n * 10n ** 18n,
    ]);
    await direct(accounts[0], tokenB, "approve", [
      exchange,
      1_000n * 10n ** 18n,
    ]);
    await direct(
      accounts[0],
      exchange,
      "createPool",
      [tokenA, tokenB],
      dex.abi
    );
    const seed = (
      await client.snapshot(accounts[0], client.deployment.tokens)
    ).pools.find((pool) => same(pool.exchange.address, exchange))!;
    assert(seed);
    const deadline =
      BigInt(
        (
          (await rpc("eth_getBlockByNumber", ["pending", false])) as {
            timestamp: string;
          }
        ).timestamp
      ) + 1_200n;
    await direct(
      accounts[0],
      exchange,
      "addLiquidity",
      [seed.id, 1_000n * 10n ** 18n, 1_000n * 10n ** 18n, 0n, 0n, deadline],
      dex.abi
    );
    for (const owner of accounts.slice(1, 6))
      await direct(owner, tokenA, "faucet");
    const pool = async () =>
      (await client.snapshot(accounts[1], client.deployment.tokens)).pools.find(
        (item) => same(item.exchange.address, exchange)
      )!;
    const balance = (address: Address, owner: Address) =>
      read.readContract({
        address,
        abi: token.abi,
        functionName: "balanceOf",
        args: [owner],
      }) as Promise<bigint>;
    const allowance = (owner: Address) =>
      read.readContract({
        address: tokenA,
        abi: token.abi,
        functionName: "allowance",
        args: [owner, exchange],
      }) as Promise<bigint>;
    const quote = (selected: Pool, amount: bigint) =>
      read.readContract({
        address: exchange,
        abi: dex.abi,
        functionName: "quote",
        args: [selected.id, tokenA, amount],
      }) as Promise<bigint>;
    const makeWallet = async (owner: Address) => {
      const controller = new WalletController(client, { storage: null });
      await controller.start();
      const session = await select(controller, owner);
      assert(session);
      return { controller, session };
    };
    const replace = async (
      original: Transaction,
      change: Partial<{
        to: Address;
        input: Hex;
        value: bigint;
        gas: bigint;
      }> = {}
    ) => {
      const wallet = createWalletClient({
        account: getAddress(original.from),
        chain: environment.chain,
        transport: http(environment.rpcUrl),
      });
      return wallet.sendTransaction({
        to: change.to ?? original.to ?? undefined,
        data: change.input ?? original.input,
        value: change.value ?? original.value,
        gas: change.gas ?? original.gas,
        nonce: original.nonce,
        maxFeePerGas: 100_000_000_000n,
        maxPriorityFeePerGas: 10_000_000_000n,
      });
    };
    const finish = async (
      operation: Promise<{ ok: boolean; error?: string }>
    ) => {
      let settled = false;
      void operation.finally(() => {
        settled = true;
      });
      await rpc("evm_setAutomine", [true]);
      await until(
        async () => {
          if (!settled) await rpc("evm_mine");
          return settled;
        },
        Boolean,
        "public operation settled"
      );
      return operation;
    };
    const pending = async (controller: WalletController, ids: Set<string>) => {
      const row = await until(
        () => rowFor(controller, ids),
        (entry) =>
          !!entry && entry.state === "submitted" && entry.descriptor !== null,
        "original transaction descriptor"
      );
      assert(row?.descriptor && hashOf(row));
      const actual = await read.getTransaction({ hash: hashOf(row)! as Hex });
      assert.equal(row.descriptor.nonce, actual.nonce.toString());
      assert(same(row.descriptor.from, actual.from));
      assert.equal(
        row.descriptor.hash.toLowerCase(),
        actual.hash.toLowerCase()
      );
      assert.equal(row.descriptor.value, actual.value.toString());
      assert.equal(
        row.descriptor.input.toLowerCase(),
        actual.input.toLowerCase()
      );
      await assert.rejects(
        () => read.getTransactionReceipt({ hash: actual.hash }),
        (error) => error instanceof TransactionReceiptNotFoundError,
        "the original is still unmined, not merely unreadable"
      );
      return { row, actual };
    };
    const amount = 10n ** 18n;

    await check(
      "Repriced approval keeps the call and continues the original swap",
      async () => {
        const owner = accounts[1];
        const { controller, session } = await makeWallet(owner);
        const selected = await pool();
        const quoted = await quote(selected, amount);
        const before = await balance(tokenA, owner);
        const writeStart = proxy.writes.length;
        const ids = new Set(
          controller.kernel.getSnapshot().journal.map((row) => row.id)
        );
        await rpc("evm_setAutomine", [false]);
        const operation = controller
          .perform({
            label: "Repriced approval swap",
            session,
            perform: (writer) =>
              writer.swap(selected, tokenA, amount, quoted, 50n),
          })
          .then(
            () => ({ ok: true }),
            (error) => ({ ok: false, error: String(error) })
          );
        const original = await pending(controller, ids);
        controller.dispatch({ kind: "history-refresh" });
        const replacement = await replace(original.actual);
        await rpc("evm_mine");
        const outcome = await finish(operation);
        assert.equal(outcome.ok, true, stringify(outcome));
        const entries = controller.kernel
          .getSnapshot()
          .journal.filter((row) => !ids.has(row.id));
        const approval = entries.find(
          (row) => row.originalHash === original.actual.hash
        )!;
        assert.equal(approval.state, "confirmed");
        verifyReplacement(
          approval,
          original.actual.hash,
          replacement,
          "repriced"
        );
        const receipt = await read.getTransactionReceipt({ hash: replacement });
        assert.equal(
          BigInt("gas" in approval ? approval.gas! : "-1"),
          receipt.gasUsed * receipt.effectiveGasPrice
        );
        assert.equal(
          proxy.writes.length - writeStart,
          2,
          "one original approval and one subsequent swap"
        );
        assert.equal(await balance(tokenA, owner), before - amount);
        assert.equal(
          entries.filter((row) => row.state === "confirmed").length,
          2
        );
        evidence.repricedApproval = {
          original: original.row,
          approval,
          entries,
          receipt,
        };
      }
    );

    await check(
      "Repriced swap records the new receipt and survives a later read failure",
      async () => {
        const owner = accounts[2];
        await direct(owner, tokenA, "approve", [exchange, amount]);
        const { controller, session } = await makeWallet(owner);
        const selected = await pool();
        const quoted = await quote(selected, amount);
        const before = await balance(tokenA, owner);
        const ids = new Set(
          controller.kernel.getSnapshot().journal.map((row) => row.id)
        );
        let replacement: Hex;
        let postReadFailed = false;
        await rpc("evm_setAutomine", [false]);
        const operation = controller
          .perform({
            label: "Repriced swap",
            session,
            perform: async (writer) => {
              await writer.swap(selected, tokenA, amount, quoted, 50n);
              proxy.failedReceipts.add(replacement.toLowerCase());
              try {
                await client.rpc.getTransactionReceipt({ hash: replacement });
              } catch (error) {
                postReadFailed = true;
                throw error;
              }
            },
          })
          .then(
            () => ({ ok: true }),
            (error) => ({ ok: false, error: String(error) })
          );
        const original = await pending(controller, ids);
        replacement = await replace(original.actual);
        await rpc("evm_mine");
        const outcome = await finish(operation);
        assert.equal(postReadFailed, true);
        assert.equal(outcome.ok, false);
        const entry = rowFor(controller, ids)!;
        assert.equal(entry.state, "confirmed");
        verifyReplacement(entry, original.actual.hash, replacement, "repriced");
        const receipt = await read.getTransactionReceipt({ hash: replacement });
        assert.equal(receipt.status, "success");
        assert.equal(
          BigInt("gas" in entry ? entry.gas! : "-1"),
          receipt.gasUsed * receipt.effectiveGasPrice
        );
        assert.equal(await balance(tokenA, owner), before - amount);
        proxy.failedReceipts.delete(replacement.toLowerCase());
        evidence.repricedSwap = { entry, receipt, postReadFailed, outcome };
      }
    );

    await check(
      "A cancelled approval does not authorize or continue a swap",
      async () => {
        const owner = accounts[3];
        const { controller, session } = await makeWallet(owner);
        const selected = await pool();
        const quoted = await quote(selected, amount);
        const before = await pool();
        const ids = new Set(
          controller.kernel.getSnapshot().journal.map((row) => row.id)
        );
        const writeStart = proxy.writes.length;
        await rpc("evm_setAutomine", [false]);
        const operation = controller
          .perform({
            label: "Cancelled approval swap",
            session,
            perform: (writer) =>
              writer.swap(selected, tokenA, amount, quoted, 50n),
          })
          .then(
            () => ({ ok: true }),
            (error) => ({ ok: false, error: String(error) })
          );
        const original = await pending(controller, ids);
        const replacement = await replace(original.actual, {
          to: owner,
          input: "0x",
          value: 0n,
          gas: 21_000n,
        });
        await rpc("evm_mine");
        const outcome = await finish(operation);
        assert.equal(outcome.ok, false);
        const entry = rowFor(controller, ids)!;
        assert.equal(entry.state, "replaced");
        verifyReplacement(entry, original.actual.hash, replacement, "replaced");
        assert.equal(await allowance(owner), 0n);
        assert.equal(proxy.writes.length - writeStart, 1);
        assert.deepEqual(await pool(), before);
        evidence.cancelledApproval = { entry, outcome };
      }
    );

    await check(
      "A different replacement call is not credited as the original swap",
      async () => {
        const owner = accounts[3];
        await direct(owner, tokenA, "approve", [exchange, amount]);
        const { controller, session } = await makeWallet(owner);
        const selected = await pool();
        const quoted = await quote(selected, amount);
        const before = {
          pool: await pool(),
          balance: await balance(tokenA, owner),
        };
        const ids = new Set(
          controller.kernel.getSnapshot().journal.map((row) => row.id)
        );
        const writeStart = proxy.writes.length;
        await rpc("evm_setAutomine", [false]);
        const operation = controller
          .perform({
            label: "Replaced swap",
            session,
            perform: (writer) =>
              writer.swap(selected, tokenA, amount, quoted, 50n),
          })
          .then(
            () => ({ ok: true }),
            (error) => ({ ok: false, error: String(error) })
          );
        const original = await pending(controller, ids);
        const replacement = await replace(original.actual, {
          to: accounts[9],
          input: "0x",
          value: 1n,
          gas: 21_000n,
        });
        await rpc("evm_mine");
        const outcome = await finish(operation);
        assert.equal(outcome.ok, false);
        const entry = rowFor(controller, ids)!;
        assert.equal(entry.state, "replaced");
        verifyReplacement(entry, original.actual.hash, replacement, "replaced");
        assert.equal(
          (await read.getTransactionReceipt({ hash: replacement })).status,
          "success"
        );
        assert.deepEqual(await pool(), before.pool);
        assert.equal(await balance(tokenA, owner), before.balance);
        assert.equal(proxy.writes.length - writeStart, 1);
        evidence.replacedSwap = { entry, outcome };
      }
    );

    await check(
      "Repricing does not let a changed wallet continue the old operation",
      async () => {
        const owner = accounts[4];
        const { controller, session } = await makeWallet(owner);
        const selected = await pool();
        const quoted = await quote(selected, amount);
        const before = await pool();
        const ids = new Set(
          controller.kernel.getSnapshot().journal.map((row) => row.id)
        );
        const writeStart = proxy.writes.length;
        await rpc("evm_setAutomine", [false]);
        const operation = controller
          .perform({
            label: "Changed wallet approval",
            session,
            perform: (writer) =>
              writer.swap(selected, tokenA, amount, quoted, 50n),
          })
          .then(
            () => ({ ok: true }),
            (error) => ({ ok: false, error: String(error) })
          );
        const original = await pending(controller, ids);
        await select(controller, accounts[5]);
        const replacement = await replace(original.actual);
        await rpc("evm_mine");
        const outcome = await finish(operation);
        assert.equal(outcome.ok, false);
        assert.equal(proxy.writes.length - writeStart, 1);
        assert.deepEqual(await pool(), before);
        assert(same(controller.session()!.address, accounts[5]));
        const approval = rowFor(controller, ids)!;
        assert.equal(
          approval.state,
          "confirmed",
          "wallet authorization changes do not erase a mined approval"
        );
        verifyReplacement(
          approval,
          original.actual.hash,
          replacement,
          "repriced"
        );
        assert(same(approval.account, owner));
        assert.equal(await allowance(owner), amount);
        evidence.changedWallet = {
          outcome,
          journal: controller.kernel.getSnapshot().journal,
        };
      }
    );

    await check(
      "Repricing contract creation preserves its null recipient and created token",
      async () => {
        const owner = accounts[5];
        const { controller, session } = await makeWallet(owner);
        const ids = new Set(
          controller.kernel.getSnapshot().journal.map((row) => row.id)
        );
        const writeStart = proxy.writes.length;
        let created: Token | undefined;
        await rpc("evm_setAutomine", [false]);
        const operation = controller
          .perform({
            label: "Repriced token creation",
            session,
            perform: async (writer) => {
              const confirmation = await writer.createToken("Repriced Token", "RPT");
              created = await client.importToken(confirmation.address);
            },
          })
          .then(
            () => ({ ok: true }),
            (error) => ({ ok: false, error: String(error) })
          );
        const original = await pending(controller, ids);
        assert.equal(original.actual.to, null);
        assert.equal(original.row.descriptor!.to, null);
        const replacement = await replace(original.actual);
        await rpc("evm_mine");
        const outcome = await finish(operation);
        assert.equal(outcome.ok, true, stringify(outcome));
        assert(created);
        const entry = rowFor(controller, ids)!;
        assert.equal(entry.state, "confirmed");
        verifyReplacement(entry, original.actual.hash, replacement, "repriced");
        const receipt = await read.getTransactionReceipt({ hash: replacement });
        assert(receipt.contractAddress);
        assert(same(created.address, receipt.contractAddress));
        assert.equal(created.symbol, "RPT");
        assert.equal(created.decimals, 18);
        assert.equal(proxy.writes.length - writeStart, 1);
        evidence.repricedCreation = { entry, receipt, created };
      }
    );

    const runWorker = async (mode: string, name: string) => {
      const output = await open(resolve(directory, `${mode}-${name}.log`), "w");
      const child = spawn(
        process.execPath,
        [
          `--localstorage-file=${resolve(directory, `storage-${name}`)}`,
          "--import",
          loader,
          self,
          "--worker",
          mode,
          directory,
          name,
        ],
        { cwd: root, stdio: ["ignore", output.fd, output.fd] }
      );
      children.add(child);
      const code = await new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("exit", done);
      });
      children.delete(child);
      await output.close();
      assert.equal(code, 0, `${mode}-${name} failed; see ${directory}`);
      const result = JSON.parse(
        await readFile(resolve(directory, `${mode}-${name}.json`), "utf8")
      );
      assert.equal(result.programSha256, programSha256);
      return result;
    };
    const recover = async (
      name: string,
      owner: Address,
      expected: "confirmed" | "replaced" | "unknown",
      legacy = false,
      holdUntilReplaced = false
    ) => {
      await rpc("evm_setAutomine", [true]);
      await writeFile(
        resolve(directory, `fixture-${name}.json`),
        stringify({ deployment, account: owner, legacy, holdUntilReplaced })
      );
      const beforeBeneficiary = await read.getBalance({ address: owner });
      await rpc("evm_setAutomine", [false]);
      const producing = runWorker("produce", name);
      const pendingState = await until(
        async () => {
          try {
            return JSON.parse(
              await readFile(resolve(directory, `pending-${name}.json`), "utf8")
            ) as { entry: Entry };
          } catch (error) {
            // DEFENSE: the newly started worker has not published its acknowledged descriptor yet.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        },
        (value) => value !== null,
        "producer published its public descriptor"
      );
      let producer = holdUntilReplaced ? null : await producing;
      assert(pendingState);
      const original = await read.getTransaction({
        hash: hashOf(pendingState.entry)! as Hex,
      });
      const source = original.from;
      if (name === "faucet-replaced" || name === "saved-replaced") {
        assert(same(source, accounts[0]));
        assert(!same(source, owner));
      }
      let foreign: Hex | undefined;
      if (name === "same-call-past") {
        const foreignWallet = createWalletClient({
          account: accounts[10],
          chain: environment.chain,
          transport: http(environment.rpcUrl),
        });
        const foreignNonce = await read.getTransactionCount({
          address: accounts[10],
        });
        assert.equal(
          foreignNonce,
          original.nonce,
          "two independent fresh senders use the same nonce"
        );
        foreign = await foreignWallet.sendTransaction({
          to: accounts[11],
          value: 1n,
          maxFeePerGas: 150_000_000_000n,
          maxPriorityFeePerGas: 20_000_000_000n,
        });
      }
      const replacement = await replace(
        original,
        expected === "replaced"
          ? { to: getAddress(source), input: "0x", value: 0n, gas: 21_000n }
          : {}
      );
      await rpc("evm_mine");
      const receipt = await read.getTransactionReceipt({ hash: replacement });
      assert.equal(receipt.status, "success");
      if (foreign) {
        const block = await read.getBlock({
          blockNumber: receipt.blockNumber,
          includeTransactions: true,
        });
        const matches = block.transactions.filter(
          (transaction) => transaction.nonce === original.nonce
        );
        assert.equal(
          matches[0].hash,
          foreign,
          "the unrelated same-nonce transaction precedes the actual sender's replacement"
        );
        assert(matches.some((transaction) => transaction.hash === replacement));
      }
      if (holdUntilReplaced) {
        producer = await producing;
        assert.equal(producer.entry.state, "replaced");
      }
      await rpc("evm_setAutomine", [true]);
      for (let block = 0; block < 8; block++) await rpc("evm_mine");
      assert(
        (await read.getBlockNumber({ cacheTime: 0 })) > receipt.blockNumber + 1n
      );
      proxy.dropped.add(original.hash.toLowerCase());
      await writeFile(
        resolve(directory, `fixture-${name}.json`),
        stringify({
          deployment,
          account: owner,
          original: original.hash,
          replacement,
          expected,
          legacy,
          holdUntilReplaced,
        })
      );
      const writeStart = proxy.writes.length;
      const readStart = proxy.requests.length;
      const consumer = await runWorker("recover", name);
      assert.equal(
        proxy.writes.length,
        writeStart,
        "history recovery never sends or resumes a wallet write"
      );
      const requests = proxy.requests.slice(readStart);
      const fullBlocks = requests.filter(
        (request) =>
          (request.method === "eth_getBlockByNumber" ||
            request.method === "eth_getBlockByHash") &&
          request.params[1] === true
      ).length;
      const nonces = requests.filter(
        (request) => request.method === "eth_getTransactionCount"
      ).length;
      assert(
        fullBlocks < 64,
        "locating a past replacement must not scan 4096 full blocks from genesis"
      );
      assert(nonces < 128, "nonce lookup remains bounded");
      if (expected !== "unknown") {
        verifyReplacement(
          consumer.entry,
          original.hash,
          replacement,
          expected === "confirmed" ? "repriced" : "replaced"
        );
        assert.equal(
          BigInt(consumer.entry.gas),
          receipt.gasUsed * receipt.effectiveGasPrice
        );
        assert(
          requests.some(
            (request) =>
              request.method === "eth_getTransactionReceipt" &&
              same(String(request.params[0]), replacement)
          ),
          "the replacement's actual receipt was rechecked"
        );
      }
      if (name === "faucet-replaced" || name === "saved-replaced") {
        assert.equal(
          await read.getBalance({ address: owner }),
          beforeBeneficiary
        );
        assert(same(consumer.entry.account, accounts[0]));
        assert(same(consumer.entry.beneficiary, owner));
      }
      proxy.dropped.delete(original.hash.toLowerCase());
      evidence[name] = {
        producer,
        consumer,
        original: {
          hash: original.hash,
          from: original.from,
          nonce: original.nonce,
          to: original.to,
          input: original.input,
          value: original.value,
          gas: original.gas,
        },
        replacement,
        receipt,
        fullBlocks,
        nonces,
        observerWrites: proxy.writes.length - writeStart,
      };
    };
    // Hardhat bulk mining has virtual intermediate states whose historical
    // nonce reads can move backwards. Recovery requires real, ordinary blocks.
    for (let block = 0; block < 4096; block++) await rpc("evm_mine");
    await check(
      "A past repriced transaction survives process destruction and a dropped original hash",
      () => recover("same-call-past", accounts[6], "confirmed")
    );
    await check(
      "A past faucet cancellation follows its actual sender, not its beneficiary",
      () => recover("faucet-replaced", accounts[8], "replaced")
    );
    await check(
      "An acknowledged replaced archive stays replaced when its successful replacement receipt is rechecked",
      () => recover("saved-replaced", accounts[9], "replaced", false, true)
    );
    await check(
      "A legacy archive without nonce metadata never invents replacement success",
      () => recover("legacy", accounts[7], "unknown", true)
    );

    evidence.status = "passed";
    evidence.walletWrites = proxy.writes;
    evidence.rpcRequests = proxy.requests;
    assert.equal(await programHash(), programSha256);
    await writeFile(resolve(directory, "result.json"), stringify(evidence));
    console.log(
      stringify({
        status: "passed",
        evidence: resolve(directory, "result.json"),
        scenarios: scenarios.length,
        walletWrites: proxy.writes.length,
      })
    );
  } catch (error) {
    evidence.status = "failed";
    evidence.error =
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : String(error);
    evidence.walletWrites = proxy.writes;
    evidence.rpcRequests = proxy.requests;
    await writeFile(resolve(directory, "result.json"), stringify(evidence));
    throw error;
  } finally {
    for (const child of children) child.kill("SIGTERM");
    await proxy.close();
    await environment.close();
  }
}

const task =
  process.argv[2] === "--worker"
    ? worker(process.argv[3], process.argv[4], process.argv[5])
    : main();
task.then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
