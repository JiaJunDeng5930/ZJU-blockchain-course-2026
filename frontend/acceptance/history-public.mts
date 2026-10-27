import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import type { Deployment } from "../src/chain/types";

type Controller = import("../src/wallet/session").WalletController;
type View = ReturnType<Controller["kernel"]["getSnapshot"]>;
const root = fileURLToPath(new URL("../../", import.meta.url));
const loader = resolve(root, "contracts/node_modules/tsx/dist/loader.mjs");
const self = fileURLToPath(import.meta.url);
const bundlePath = resolve(root, "frontend/src/generated/dex_logic.js");
const programHash = async () =>
  createHash("sha256")
    .update(await readFile(bundlePath))
    .digest("hex");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function hashOf(
  entry: View["journal"][number] | undefined,
): string | undefined {
  return entry && "hash" in entry ? (entry.hash ?? undefined) : undefined;
}

async function until<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  label: string,
  timeout = 30_000,
): Promise<T> {
  const end = Date.now() + timeout;
  do {
    const value = await read();
    if (done(value)) return value;
    await delay(30);
  } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
}
async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}
async function rpc(url: string, method: string, params: unknown[] = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const reply = await response.json();
  if (reply.error) throw new Error(JSON.stringify(reply.error));
  return reply.result;
}
async function freePort() {
  const server = createSocketServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
function archiveValues(): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, i) =>
      localStorage.key(i)!,
    ).map((key) => [key, localStorage.getItem(key)!]),
  );
}

async function worker(mode: string, directory: string) {
  const { WalletController } = await import("../src/wallet/session");
  const { ExchangeClient } = await import("../src/chain/client");
  const fixture = await json(resolve(directory, "fixture.json"));
  const deployment =
    mode === "endpoint-scope"
      ? { ...fixture.deployment, rpcUrl: fixture.upstream }
      : fixture.deployment;
  const client = new ExchangeClient(deployment as Deployment);
  await client.verifyDeployment();
  fixture.accounts = await client.localAccounts();
  const controller = new WalletController(
    client,
    mode === "memory" ? { storage: null } : { storage: localStorage },
  );
  const snapshot = () => controller.kernel.getSnapshot();
  const select = async (instance: Controller, account: Address) => {
    instance.dispatch({ kind: "select-local", address: account });
    try {
      return await until(
        () => instance.session(),
        (value) => value?.address.toLowerCase() === account.toLowerCase(),
        "selected wallet",
        10_000,
      );
    } catch (error) {
      await writeFile(
        resolve(directory, `${mode}-selection.json`),
        JSON.stringify(instance.kernel.getSnapshot(), null, 2),
      );
      throw error;
    }
  };
  const control = async () =>
    (await fetch(`${fixture.deployment.rpcUrl}/acceptance/status`)).json();
  const claim = async (
    instance: Controller,
    account: Address,
    tokenIndex: number,
  ) => {
    const session = await select(instance, account);
    await instance.perform({
      label: "History acceptance claim",
      session: session!,
      perform: async (writer) => {
        await writer.faucet(fixture.deployment.tokens[tokenIndex]);
      },
    });
  };
  const result: Record<string, unknown> = {
    mode,
    programSha256: await programHash(),
  };
  await controller.start();
  if (mode === "pending" || mode === "unknown-producer") {
    const account = fixture.accounts[mode === "pending" ? 0 : 4] as Address;
    const session = await select(controller, account);
    void controller
      .perform({
        label: "Interrupted history acceptance",
        session: session!,
        perform: async (writer) => {
          await writer.faucet(fixture.deployment.tokens[0]);
        },
      })
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    const view = await until(
      snapshot,
      (value) =>
        value.history.kind === "ready" &&
        value.journal.some(
          (entry) =>
            entry.account.toLowerCase() === account.toLowerCase() &&
            (mode === "pending"
              ? entry.state === "submitted" && !!hashOf(entry)
              : entry.state === "awaiting-wallet" && !hashOf(entry)),
        ),
      "saved interrupted operation",
    );
    if (mode === "unknown-producer")
      await until(
        control,
        (value) => value.held,
        "request reached delayed RPC",
      );
    const row = view.journal.find(
      (entry) => entry.account.toLowerCase() === account.toLowerCase(),
    )!;
    result.entry = row;
    result.archives = archiveValues();
    if (mode === "pending")
      assert(
        Object.values(result.archives as Record<string, string>).some((value) =>
          value.includes(hashOf(row)!),
        ),
        "The submitted hash must reach real storage before refresh",
      );
    await writeFile(resolve(directory, `${mode}.json`), JSON.stringify(result));
    // Closing this process models navigation destroying the old document while its promise is pending.
    process.exit(process.exitCode ?? 0);
  } else if (mode === "restore") {
    const saved = await json(resolve(directory, "pending.json"));
    const before = await control();
    await until(
      snapshot,
      (value) =>
        value.journal.some(
          (entry) =>
            hashOf(entry) === saved.entry.hash && entry.state === "submitted",
        ),
      "restored pending transaction before mining",
    );
    assert.equal(
      await rpc(fixture.deployment.rpcUrl, "eth_getTransactionReceipt", [
        saved.entry.hash,
      ]),
      null,
    );
    result.observedPendingBeforeMining = true;
    await rpc(fixture.deployment.rpcUrl, "evm_mine");
    const view = await until(
      snapshot,
      (value) =>
        value.journal.some(
          (entry) =>
            hashOf(entry) === saved.entry.hash && entry.state === "confirmed",
        ),
      "receipt recovery after process restart",
    );
    const entry = view.journal.find(
      (entry) => hashOf(entry) === saved.entry.hash,
    )!;
    assert.equal(
      entry.account.toLowerCase(),
      saved.entry.account.toLowerCase(),
    );
    assert.equal(
      entry.id,
      saved.entry.id,
      "Restoring a record must preserve its composite identity",
    );
    assert.equal(
      (await control()).walletWrites,
      before.walletWrites,
      "Restoration must not submit a wallet request",
    );
    for (const [key, value] of Object.entries(saved.archives))
      assert.equal(
        localStorage.getItem(key),
        value,
        "An observer must not rewrite the producer archive",
      );
    assert(entry.state === "confirmed");
    const receipt = await rpc(
      fixture.deployment.rpcUrl,
      "eth_getTransactionReceipt",
      [saved.entry.hash],
    );
    assert.equal(entry.block, BigInt(receipt.blockNumber).toString());
    assert.equal(
      entry.gas,
      (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString(),
    );
    result.entry = entry;
  } else if (mode === "parallel") {
    const second = new WalletController(client, { storage: localStorage });
    await second.start();
    const secondSession = await select(second, fixture.accounts[2]);
    await Promise.all([
      claim(controller, fixture.accounts[1], 0),
      second.perform({
        label: "History acceptance funding",
        session: secondSession!,
        perform: async (writer) => {
          await writer.claimEther();
        },
      }),
    ]);
    const firstEntry = snapshot().journal.find(
      (entry) =>
        entry.account.toLowerCase() === fixture.accounts[1].toLowerCase() &&
        entry.state === "confirmed",
    )!;
    const secondEntry = second.kernel
      .getSnapshot()
      .journal.find(
        (entry) =>
          entry.beneficiary?.toLowerCase() ===
            fixture.accounts[2].toLowerCase() && entry.state === "confirmed",
      )!;
    assert(hashOf(firstEntry) && hashOf(secondEntry));
    assert.notEqual(firstEntry.id, secondEntry.id);
    assert.equal(
      secondEntry.account.toLowerCase(),
      fixture.accounts[0].toLowerCase(),
    );
    assert.equal(secondEntry.authority, "dev-faucet");
    result.entries = [firstEntry, secondEntry];
    second.stop();
  } else if (mode === "parallel-restore") {
    const saved = await json(resolve(directory, "parallel.json"));
    const initial = await json(resolve(directory, "pending.json"));
    const hashes = [
      initial.entry.hash,
      ...saved.entries.map((entry: { hash: string }) => entry.hash),
    ];
    const before = await control();
    const view = await until(
      snapshot,
      (value) =>
        hashes.every((hash) =>
          value.journal.some(
            (entry) => hashOf(entry) === hash && entry.state === "confirmed",
          ),
        ),
      "all page archives recover",
    );
    for (const hash of hashes)
      assert.equal(
        view.journal.filter((entry) => hashOf(entry) === hash).length,
        1,
        "Each transaction must appear once",
      );
    const ids = view.journal
      .filter((entry) => hashes.includes(hashOf(entry)))
      .map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal((await control()).walletWrites, before.walletWrites);
    result.hashes = hashes;
  } else if (mode === "memory" || mode === "corrupt") {
    const account = fixture.accounts[mode === "memory" ? 3 : 5] as Address;
    const before = await control();
    await claim(controller, account, 0);
    const entry = snapshot().journal.find(
      (entry) =>
        entry.account.toLowerCase() === account.toLowerCase() &&
        entry.state === "confirmed",
    );
    assert(hashOf(entry));
    assert.equal((await control()).walletWrites, before.walletWrites + 1);
    const history = snapshot().history;
    assert(history.error, "Unavailable history must be visible");
    if (mode === "memory") assert.equal(history.kind, "memory");
    if (mode === "corrupt")
      assert.equal(
        localStorage.getItem(fixture.corruptKey),
        "{",
        "Unreadable data must be preserved",
      );
    result.entry = entry;
    result.history = history;
  } else if (mode === "endpoint-scope") {
    const saved = await json(resolve(directory, "pending.json"));
    assert(
      Object.values(archiveValues()).some((value) =>
        value.includes(saved.entry.hash),
      ),
    );
    assert(
      (await client.rpc.getTransactionReceipt({ hash: saved.entry.hash }))
        .status === "success",
    );
    assert.notEqual(fixture.deployment.rpcUrl, fixture.upstream);
    assert.equal(
      snapshot().journal.length,
      0,
      "A different configured endpoint must not import the other endpoint's history",
    );
    assert.equal(snapshot().history.kind, "ready");
    result.isolated = true;
  } else if (mode === "unknown-restore") {
    const saved = await json(resolve(directory, "unknown-producer.json"));
    const before = await control();
    const view = await until(
      snapshot,
      (value) =>
        value.history.kind !== "loading" &&
        value.journal.some((entry) => entry.id === saved.entry.id),
      "unknown outcome recovery",
    );
    const entry = view.journal.find((entry) => entry.id === saved.entry.id)!;
    assert.equal(
      entry.state,
      "submission-unknown",
      "Missing hash cannot establish submission failure",
    );
    assert(!hashOf(entry));
    assert.equal((await control()).walletWrites, before.walletWrites);
    result.entry = entry;
  } else throw new Error(`Unknown acceptance mode: ${mode}`);
  controller.stop();
  await writeFile(resolve(directory, `${mode}.json`), JSON.stringify(result));
}

async function orchestrate() {
  const directory = await mkdtemp(resolve(root, ".local/history-public-"));
  const programSha256 = await programHash();
  const port = await freePort(),
    upstream = `http://127.0.0.1:${port}`;
  const log = await open(resolve(directory, "chain.log"), "w");
  const chain = spawn(
    process.execPath,
    [
      resolve(root, "contracts/node_modules/hardhat/dist/src/cli.js"),
      "node",
      "--network",
      "hardhat",
      "--port",
      String(port),
    ],
    {
      cwd: resolve(root, "contracts"),
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    },
  );
  await writeFile(
    resolve(directory, "launch.json"),
    JSON.stringify(
      {
        cwd: resolve(root, "contracts"),
        config: resolve(root, "contracts/hardhat.config.ts"),
        port,
        pid: chain.pid,
      },
      null,
      2,
    ),
  );
  let walletWrites = 0,
    hold = false,
    heldBody: string | undefined;
  const proxy = createServer(async (request, response) => {
    if (request.url === "/acceptance/status") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ walletWrites, held: !!heldBody }));
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const message = JSON.parse(body);
      if (
        ["eth_sendTransaction", "eth_sendRawTransaction"].includes(
          message.method,
        )
      ) {
        walletWrites++;
        if (hold) {
          assert(!heldBody);
          heldBody = body;
          return;
        }
      }
      const reply = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      response.setHeader("content-type", "application/json");
      response.end(await reply.text());
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  const children = new Set<ChildProcess>();
  const run = async (mode: string) => {
    const output = await open(resolve(directory, `${mode}.log`), "w");
    const child = spawn(
      process.execPath,
      [
        `--localstorage-file=${resolve(directory, "storage")}`,
        "--import",
        loader,
        self,
        "--worker",
        mode,
        directory,
      ],
      { cwd: root, stdio: ["ignore", output.fd, output.fd] },
    );
    children.add(child);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    children.delete(child);
    await output.close();
    assert.equal(code, 0, `${mode} failed; see ${directory}/${mode}.log`);
    const result = await json(resolve(directory, `${mode}.json`));
    assert.equal(
      result.programSha256,
      programSha256,
      "The generated program changed during acceptance",
    );
    return result;
  };
  try {
    await until(
      async () => {
        try {
          return await rpc(upstream, "eth_chainId");
        } catch (error) {
          // DEFENSE: the isolated node has not bound its port during startup.
          if (
            error instanceof TypeError &&
            (error.cause as { code?: string })?.code === "ECONNREFUSED"
          )
            return null;
          throw error;
        }
      },
      (value) => value === "0x7a69",
      "isolated Hardhat node",
    );
    const accounts = (await rpc(upstream, "eth_accounts")) as Address[];
    const network = defineChain({
      id: 31337,
      name: "History acceptance",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [upstream] } },
    });
    const publicClient = createPublicClient({
      chain: network,
      transport: http(upstream),
    });
    const wallet = createWalletClient({
      account: accounts[0],
      chain: network,
      transport: http(upstream),
    });
    const deploy = async (name: string, args: readonly unknown[] = []) => {
      const artifact = await json(
        resolve(root, `contracts/artifacts/contracts/${name}.sol/${name}.json`),
      );
      const hash = await wallet.deployContract({
        abi: artifact.abi as Abi,
        bytecode: artifact.bytecode as Hex,
        args,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      assert(receipt.contractAddress);
      return receipt.contractAddress;
    };
    const tokenA = await deploy("TestToken", ["History A", "HSA"]),
      tokenB = await deploy("TestToken", ["History B", "HSB"]);
    const wrapped = await deploy("WrappedEther"),
      first = await deploy("MiniDEX", ["History DEX A"]),
      second = await deploy("MiniDEX", ["History DEX B"]),
      arbitrage = await deploy("AtomicArbitrage");
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const rpcUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const fixture = {
      accounts,
      upstream,
      deployment: {
        schemaVersion: 1,
        chainId: 31337,
        rpcUrl,
        tokens: [
          { address: tokenA, name: "History A", symbol: "HSA", kind: "faucet" },
          { address: tokenB, name: "History B", symbol: "HSB", kind: "faucet" },
          {
            address: wrapped,
            name: "Wrapped Ether",
            symbol: "WETH",
            kind: "wrapped",
          },
        ],
        exchanges: [
          { address: first, name: "History DEX A" },
          { address: second, name: "History DEX B" },
        ],
        arbitrage,
        bytecodes: {
          TestToken: (
            await json(
              resolve(
                root,
                "contracts/artifacts/contracts/TestToken.sol/TestToken.json",
              ),
            )
          ).bytecode,
        },
      },
      corruptKey: "",
    };
    const saveFixture = () =>
      writeFile(resolve(directory, "fixture.json"), JSON.stringify(fixture));
    await saveFixture();
    await rpc(upstream, "evm_setAutomine", [false]);
    const pending = await run("pending");
    const restored = await run("restore");
    await rpc(upstream, "evm_setAutomine", [true]);
    const parallel = await run("parallel");
    const parallelRestored = await run("parallel-restore");
    const memory = await run("memory");
    hold = true;
    const unknown = await run("unknown-producer");
    assert(heldBody);
    hold = false;
    const accepted = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: heldBody,
    }).then((response) => response.json());
    assert(accepted.result);
    const unknownRestored = await run("unknown-restore");
    const ownId = pending.entry.id.slice(0, pending.entry.id.lastIndexOf(":"));
    const key = Object.keys(pending.archives).find((key) =>
      key.endsWith(`:${ownId}`),
    );
    assert(key, "A producer archive must exist");
    fixture.corruptKey = key.slice(0, -ownId.length) + crypto.randomUUID();
    await saveFixture();
    const injection = spawn(
      process.execPath,
      [
        `--localstorage-file=${resolve(directory, "storage")}`,
        "-e",
        `localStorage.setItem(${JSON.stringify(fixture.corruptKey)}, "{")`,
      ],
      { stdio: "ignore" },
    );
    assert.equal(
      await new Promise((resolve) => injection.once("exit", resolve)),
      0,
    );
    const corrupt = await run("corrupt");
    const endpoint = await run("endpoint-scope");
    assert.equal(
      await programHash(),
      programSha256,
      "The generated program changed during acceptance",
    );
    assert.equal(
      walletWrites,
      6,
      "Only the six original operations may request a wallet write",
    );
    const result = {
      status: "passed",
      programSha256,
      directory,
      pending: pending.entry,
      restored: restored.entry,
      parallel: parallel.entries,
      recoveredHashes: parallelRestored.hashes,
      memory: memory.history,
      unknownAcceptedHash: accepted.result,
      unknown: unknownRestored.entry,
      corruptPreserved: true,
      endpointIsolated: endpoint.isolated,
      walletWrites,
    };
    await writeFile(
      resolve(directory, "result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(
      JSON.stringify({
        status: result.status,
        evidence: resolve(directory, "result.json"),
        walletWrites,
      }),
    );
  } finally {
    for (const child of children) child.kill("SIGTERM");
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    if (chain.pid) {
      try {
        process.kill(-chain.pid, "SIGTERM");
      } catch (error) {
        // DEFENSE: startup failure can terminate the isolated child before cleanup runs.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await log.close();
  }
}
if (process.argv[2] === "--worker")
  await worker(process.argv[3], process.argv[4]);
else await orchestrate();
