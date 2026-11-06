import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address } from "viem";
import { ExchangeClient } from "../src/chain/client";
import { WalletController } from "../src/wallet/session";
import type { Deployment } from "../src/chain/types";
import { isolatedChain, root, until } from "./support/chain.mts";

type View = ReturnType<WalletController["kernel"]["getSnapshot"]>;
const self = fileURLToPath(import.meta.url);
const loader = resolve(root, "contracts/node_modules/tsx/dist/loader.mjs");
const bundle = resolve(root, "frontend/src/generated/dex_logic.js");
const programHash = async () =>
  createHash("sha256")
    .update(await readFile(bundle))
    .digest("hex");
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const hashOf = (entry: View["journal"][number]) =>
  "hash" in entry ? entry.hash : undefined;
const rpc = async (url: string, method: string, params: unknown[] = []) => {
  const reply = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((response) => response.json());
  assert(!reply.error, JSON.stringify(reply.error));
  return reply.result;
};
const storedValues = () =>
  Array.from(
    { length: localStorage.length },
    (_, index) => localStorage.getItem(localStorage.key(index)!) ?? "",
  );

async function worker(mode: string, directory: string) {
  const fixture = await json(resolve(directory, "fixture.json"));
  const client = new ExchangeClient(fixture.deployment as Deployment);
  await client.verifyDeployment();
  const pendingStorage: Storage =
    mode === "quota"
      ? {
          get length() {
            return localStorage.length;
          },
          key: (index) => localStorage.key(index),
          getItem: (key) => localStorage.getItem(key),
          removeItem: (key) => localStorage.removeItem(key),
          clear: () => localStorage.clear(),
          setItem() {
            throw new DOMException(
              "The session storage quota is full",
              "QuotaExceededError",
            );
          },
        }
      : localStorage;
  const controller = new WalletController(client, {
    storage: null,
    pendingStorage,
  });
  const snapshot = () => controller.kernel.getSnapshot();
  const control = async () =>
    fetch(`${fixture.deployment.rpcUrl}/acceptance/status`).then((reply) =>
      reply.json(),
    );
  const result: Record<string, unknown> = {
    mode,
    programSha256: await programHash(),
  };
  await controller.start();
  if (mode === "produce" || mode === "quota") {
    const account = fixture.accounts[mode === "produce" ? 1 : 2] as Address;
    controller.dispatch({ kind: "select-local", address: account });
    const session = await until(
      () => controller.session(),
      (value) =>
        !!value && value.address.toLowerCase() === account.toLowerCase(),
      "selected public wallet session",
    );
    assert(session);
    const operation = controller.perform({
      label: "Pending asset preparation",
      session,
      perform: async (writer) => {
        await writer.faucet(client.deployment.tokens[0]);
        if (mode === "produce")
          await writer.faucet(client.deployment.tokens[1]);
      },
    });
    if (mode === "produce") {
      void operation.catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
      const view = await until(
        snapshot,
        (value) =>
          value.journal.some(
            (entry) => entry.state === "submitted" && !!hashOf(entry),
          ),
        "submitted first step",
      );
      const entry = view.journal.find(
        (item) => item.state === "submitted" && !!hashOf(item),
      )!;
      await until(
        storedValues,
        (values) => values.some((value) => value.includes(hashOf(entry)!)),
        "known pending hash reached session storage",
      );
      result.entry = entry;
      result.walletWrites = (await control()).walletWrites;
    } else {
      const waiting = await until(
        snapshot,
        (value) =>
          value.pendingRecovery.kind === "memory" &&
          !!value.pendingRecovery.error &&
          value.journal.some(
            (entry) => entry.state === "submitted" && !!hashOf(entry),
          ),
        "storage failure is visible while the real transaction remains pending",
      );
      result.storageFeedback = waiting.pendingRecovery;
      await rpc(fixture.deployment.rpcUrl, "evm_mine");
      await operation;
      const entry = snapshot().journal.find(
        (item) => item.account.toLowerCase() === account.toLowerCase(),
      );
      assert(entry && entry.state === "confirmed");
      const receipt = await client.rpc.getTransactionReceipt({
        hash: hashOf(entry)! as `0x${string}`,
      });
      assert.equal(receipt.status, "success");
      result.entry = entry;
    }
  } else if (mode === "restore") {
    const saved = await json(resolve(directory, "produce.json"));
    const before = await control();
    const submitted = snapshot().journal.find(
      (entry) => hashOf(entry) === saved.entry.hash,
    );
    assert(
      submitted && submitted.state === "submitted",
      "start() restores a known pending hash before mining",
    );
    assert.equal(
      await rpc(fixture.deployment.rpcUrl, "eth_getTransactionReceipt", [
        saved.entry.hash,
      ]),
      null,
    );
    await rpc(fixture.deployment.rpcUrl, "evm_mine");
    const view = await until(
      snapshot,
      (value) =>
        value.journal.some(
          (entry) =>
            hashOf(entry) === saved.entry.hash && entry.state === "confirmed",
        ),
      "refreshed page observes the real receipt",
    );
    const entry = view.journal.find(
      (item) => hashOf(item) === saved.entry.hash,
    )!;
    assert.equal(
      entry.account.toLowerCase(),
      saved.entry.account.toLowerCase(),
    );
    assert.equal(
      (await control()).walletWrites,
      before.walletWrites,
      "Restoring observation must not sign, resubmit, or continue the second step",
    );
    await until(
      storedValues,
      (values) => values.every((value) => !value.includes(saved.entry.hash)),
      "confirmed hash leaves the pending checkpoint",
    );
    result.entry = entry;
    result.walletWrites = (await control()).walletWrites;
  } else if (mode === "completed-refresh") {
    const saved = await json(resolve(directory, "produce.json"));
    const before = await control();
    assert(
      !snapshot().journal.some((entry) => hashOf(entry) === saved.entry.hash),
      "A new page must not restore completed history",
    );
    assert.equal((await control()).walletWrites, before.walletWrites);
    result.entries = snapshot().journal;
  } else {
    throw new Error(`Unknown acceptance worker: ${mode}`);
  }
  result.walletWrites = (await control()).walletWrites;
  await writeFile(
    resolve(directory, `${mode}.json`),
    JSON.stringify(result, null, 2),
  );
  // Destroy the old document's pending promise rather than leaving a second workflow alive.
  process.exit(0);
}

async function main() {
  const environment = await isolatedChain("pending-public");
  const { directory, accounts, artifact, deploy, rpc } = environment;
  const programSha256 = await programHash();
  let walletWrites = 0;
  const proxy = createServer(async (request, response) => {
    if (request.url === "/acceptance/status") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ walletWrites }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const message = JSON.parse(body);
    if (
      ["eth_sendTransaction", "eth_sendRawTransaction"].includes(message.method)
    )
      walletWrites++;
    const reply = await fetch(environment.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    response.setHeader("content-type", "application/json");
    response.end(await reply.text());
  });
  const run = async (mode: string) => {
    const output = await open(resolve(directory, `${mode}.log`), "w");
    const child = spawn(
      process.execPath,
      [
        `--localstorage-file=${resolve(directory, mode === "quota" ? "quota-storage" : "tab-storage")}`,
        "--import",
        loader,
        self,
        "--worker",
        mode,
        directory,
      ],
      { cwd: root, stdio: ["ignore", output.fd, output.fd], timeout: 45_000 },
    );
    try {
      const code = await new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("exit", done);
      });
      assert.equal(code, 0, `${mode} failed; see ${directory}/${mode}.log`);
      const result = await json(resolve(directory, `${mode}.json`));
      assert.equal(
        result.programSha256,
        programSha256,
        "The generated program changed during acceptance",
      );
      return result;
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await output.close();
    }
  };
  const scenarios: { scenario: string; outcome: "passed" }[] = [];
  const evidence: Record<string, unknown> = {
    status: "running",
    programSha256,
    scenarios,
  };
  try {
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    const token = await artifact("TestToken");
    const tokenA = await deploy(token, ["Pending A", "PNA"]);
    const tokenB = await deploy(token, ["Pending B", "PNB"]);
    const weth = await deploy(await artifact("WrappedEther"));
    const dex = await artifact("MiniDEX");
    const first = await deploy(dex, ["Pending DEX A"]);
    const second = await deploy(dex, ["Pending DEX B"]);
    const arbitrage = await deploy(await artifact("AtomicArbitrage"));
    const deployment: Deployment = {
      schemaVersion: 1,
      chainId: 31337,
      rpcUrl: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
      tokens: [
        {
          address: tokenA,
          name: "Pending A",
          symbol: "PNA",
          decimals: 18,
          kind: "faucet",
        },
        {
          address: tokenB,
          name: "Pending B",
          symbol: "PNB",
          decimals: 18,
          kind: "faucet",
        },
        {
          address: weth,
          name: "Wrapped Ether",
          symbol: "WETH",
          decimals: 18,
          kind: "wrapped",
        },
      ],
      exchanges: [
        { address: first, name: "Pending DEX A" },
        { address: second, name: "Pending DEX B" },
      ],
      arbitrage,
      bytecodes: { TestToken: token.bytecode },
    };
    await writeFile(
      resolve(directory, "fixture.json"),
      JSON.stringify({ deployment, accounts }),
    );
    await rpc("evm_setAutomine", [false]);
    evidence.pending = await run("produce");
    evidence.restored = await run("restore");
    scenarios.push({
      scenario:
        "A refreshed tab observes a pending transaction without signing, resubmitting, or continuing the interrupted workflow",
      outcome: "passed",
    });
    evidence.completedRefresh = await run("completed-refresh");
    assert.equal(
      walletWrites,
      1,
      "Only the first interrupted claim was submitted",
    );
    scenarios.push({
      scenario:
        "Confirmation clears the checkpoint and a later refresh does not restore completed history",
      outcome: "passed",
    });
    evidence.unavailable = await run("quota");
    assert.equal(
      walletWrites,
      2,
      "Storage failure must not repeat a successful request",
    );
    scenarios.push({
      scenario:
        "Storage quota failure is visible and does not prevent or duplicate a real transaction",
      outcome: "passed",
    });
    assert.equal(await programHash(), programSha256);
    evidence.status = "passed";
    evidence.walletWrites = walletWrites;
    console.log(
      JSON.stringify({
        status: "passed",
        evidence: resolve(directory, "result.json"),
        walletWrites,
        scenarios: scenarios.length,
      }),
    );
  } catch (error) {
    evidence.status = "failed";
    evidence.error =
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : String(error);
    throw error;
  } finally {
    await writeFile(
      resolve(directory, "result.json"),
      JSON.stringify(evidence, null, 2),
    );
    proxy.closeAllConnections();
    await new Promise<void>((done, reject) =>
      proxy.close((error) => (error ? reject(error) : done())),
    );
    await environment.close();
  }
}

(process.argv[2] === "--worker"
  ? worker(process.argv[3], process.argv[4])
  : main()
).then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
