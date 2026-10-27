import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { getAddress, maxUint256, type Abi, type Hex } from "viem";
import {
  SimulationController,
  performSimulation,
  type SimulationEvent,
} from "../src/logic/simulation";
import type {
  SimulationJob,
  SimulationReport,
} from "../../contracts/scripts/simulation-protocol";
import { delay, isolatedChain, root } from "./support/chain.mts";

const json = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? String(v) : v), 2);
const hash = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const sources = [
  "contracts/scripts/simulation-server.ts",
  "contracts/scripts/simulate.ts",
  "contracts/scripts/simulation-protocol.ts",
  "frontend/src/logic/simulation.ts",
];
const fingerprints = async () =>
  Object.fromEntries(
    await Promise.all(
      sources.map(async (p) => [p, await hash(resolve(root, p))]),
    ),
  );
const nativeFetch = globalThis.fetch;
async function waitFor<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  label: string,
  milliseconds = 120_000,
): Promise<T> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepts(value)) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const socket = createServer();
  await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((done, reject) =>
    socket.close((error) => (error ? reject(error) : done())),
  );
  return port;
}
async function main() {
  const environment = await isolatedChain("simulation-public");
  const { directory, accounts, admin, read, artifact, deploy, rpc } =
    environment;
  const programSha256 = await hash(
    resolve(root, "frontend/src/generated/dex_logic.js"),
  );
  const sourceSha256 = await fingerprints();
  const scenarios: { scenario: string; outcome: string }[] = [];
  const evidence: Record<string, unknown> = {
    status: "running",
    programSha256,
    sourceSha256,
    scenarios,
  };
  let service: ChildProcess | undefined;
  const serviceLog = await open(resolve(directory, "service.log"), "w");
  const startObservations: unknown[] = [];
  let saveControllerEvents: (() => Promise<void>) | undefined;
  const requests: {
    path: string;
    method: string;
    status: number;
    jobId?: string | null;
    state?: string;
  }[] = [];
  const snapshot = (job: SimulationJob) => ({
    id: job.id,
    state: job.state,
    progress: job.progress?.completedRounds,
    transactions: job.progress?.transactionCount,
  });
  try {
    const tokenAbi = await artifact("TestToken"),
      dexAbi = await artifact("MiniDEX"),
      arbAbi = await artifact("AtomicArbitrage");
    const a = await deploy(tokenAbi, ["Simulation A", "SMA"]),
      b = await deploy(tokenAbi, ["Simulation B", "SMB"]);
    const exchanges = [
      {
        address: await deploy(dexAbi, ["Simulation Cedar"]),
        name: "Simulation Cedar",
      },
      {
        address: await deploy(dexAbi, ["Simulation Harbor"]),
        name: "Simulation Harbor",
      },
    ];
    const arbitrage = await deploy(arbAbi);
    const transact = async (
      address: Hex,
      abi: Abi,
      functionName: string,
      args: readonly unknown[] = [],
    ) => {
      const tx = await admin.writeContract({
        address,
        abi,
        functionName,
        args,
      });
      assert.equal(
        (await read.waitForTransactionReceipt({ hash: tx })).status,
        "success",
      );
    };
    for (const token of [a, b]) {
      for (let i = 0; i < 3; i++) await transact(token, tokenAbi.abi, "faucet");
      for (const account of accounts.slice(1)) {
        const tx = await admin.writeContract({
          account,
          address: token,
          abi: tokenAbi.abi,
          functionName: "faucet",
        });
        assert.equal(
          (await read.waitForTransactionReceipt({ hash: tx })).status,
          "success",
        );
      }
      for (const exchange of exchanges)
        await transact(token, tokenAbi.abi, "approve", [
          exchange.address,
          maxUint256,
        ]);
    }
    const unit = 10n ** 18n;
    for (const [index, exchange] of exchanges.entries()) {
      await transact(exchange.address, dexAbi.abi, "createPool", [a, b]);
      const deadline =
        (await read.getBlock({ blockTag: "pending" })).timestamp + 1200n;
      await transact(exchange.address, dexAbi.abi, "addLiquidity", [
        1n,
        10_000n * unit,
        (index === 0 ? 10_000n : 12_000n) * unit,
        0n,
        0n,
        deadline,
      ]);
    }
    const nftBalances = () =>
      Promise.all(
        exchanges.flatMap((exchange) =>
          accounts.map(async (account) =>
            String(
              await read.readContract({
                address: exchange.address,
                abi: dexAbi.abi,
                functionName: "balanceOf",
                args: [account],
              }),
            ),
          ),
        ),
      );
    const initialNfts = await nftBalances();
    const fixture = resolve(directory, "fixture");
    await mkdir(resolve(fixture, "contracts/scripts"), { recursive: true });
    await mkdir(resolve(fixture, "shared"));
    await copyFile(
      resolve(root, "contracts/package.json"),
      resolve(fixture, "contracts/package.json"),
    );
    await symlink(
      resolve(root, "contracts/node_modules"),
      resolve(fixture, "contracts/node_modules"),
      "dir",
    );
    for (const name of [
      "simulation-server.ts",
      "simulate.ts",
      "simulation-protocol.ts",
    ])
      await copyFile(
        resolve(root, "contracts/scripts", name),
        resolve(fixture, "contracts/scripts", name),
      );
    await writeFile(
      resolve(fixture, "shared/deployment.json"),
      json({
        chainId: 31337,
        rpcUrl: environment.rpcUrl,
        tokens: [
          { address: a, name: "Simulation A", symbol: "SMA" },
          { address: b, name: "Simulation B", symbol: "SMB" },
        ],
        exchanges,
        arbitrage,
        abis: {
          TestToken: tokenAbi.abi,
          MiniDEX: dexAbi.abi,
          AtomicArbitrage: arbAbi.abi,
        },
      }),
    );
    const port = await freePort(),
      base = `http://127.0.0.1:${port}`;
    service = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        resolve(fixture, "contracts/scripts/simulation-server.ts"),
      ],
      {
        cwd: resolve(fixture, "contracts"),
        detached: true,
        env: {
          ...process.env,
          SIMULATION_PORT: String(port),
          LOCAL_RPC_URL: environment.rpcUrl,
        },
        stdio: ["ignore", serviceLog.fd, serviceLog.fd],
      },
    );
    await writeFile(
      resolve(directory, "service-launch.json"),
      json({ pid: service.pid, base, fixture }),
    );
    await waitFor(
      async () => {
        // DEFENSE: the spawned HTTP service has not bound its port during startup.
        try {
          return (await nativeFetch(base + "/api/simulation")).status;
        } catch (error) {
          if (error instanceof TypeError) return 0;
          throw error;
        }
      },
      (value) => value === 200,
      "simulation service startup",
      20_000,
    );
    globalThis.fetch = async (input, options) => {
      const url =
        typeof input === "string" && input.startsWith("/api/simulation")
          ? new URL(input, base)
          : input;
      const headers = new Headers(options?.headers);
      // Node has no document origin; supply the same-origin header a browser sends for POST.
      if (
        options?.method === "POST" &&
        String(url).startsWith(base + "/api/simulation")
      )
        headers.set("origin", base);
      const response = await nativeFetch(url, { ...options, headers });
      if (String(url).startsWith(base + "/api/simulation")) {
        const body = (await response.clone().json()) as SimulationJob;
        requests.push({
          path: new URL(String(url)).pathname + new URL(String(url)).search,
          method: options?.method ?? "GET",
          status: response.status,
          jobId: body.id,
          state: body.state,
        });
      }
      return response;
    };
    const controllerIds = new WeakMap<SimulationController, number>();
    let nextControllerId = 0;
    const controllerEvents: {
      controller: number;
      wire: string;
      rejected?: string;
    }[] = [];
    const dispatch = (
      controller: SimulationController,
      event: SimulationEvent,
    ) => {
      if (!controllerIds.has(controller))
        controllerIds.set(controller, nextControllerId++);
      const trace = {
        controller: controllerIds.get(controller)!,
        wire: JSON.stringify(event),
      } as { controller: number; wire: string; rejected?: string };
      controllerEvents.push(trace);
      try {
        return controller.dispatch(event);
      } catch (error) {
        trace.rejected = String(error);
        throw error;
      }
    };
    saveControllerEvents = () =>
      writeFile(
        resolve(directory, "controller-events.json"),
        json(controllerEvents),
      );
    const drive = async (
      controller: SimulationController,
      event: SimulationEvent,
    ) => {
      evidence.lastControllerEvent = event;
      const transition = dispatch(controller, event);
      assert(transition.effect, `${event.type} must emit an external effect`);
      const data = await performSimulation(transition.effect);
      const responseEvent: SimulationEvent = {
        type: "success",
        requestId: transition.effect.requestId,
        data,
      };
      evidence.lastControllerEvent = responseEvent;
      dispatch(controller, responseEvent);
      return data;
    };
    const observe = (controller: SimulationController) =>
      drive(controller, { type: "poll" });
    const start = async (
      controller: SimulationController,
      seed: number,
      rounds: number,
      interval: number,
    ) => {
      await observe(controller);
      dispatch(controller, {
        type: "edit",
        draft: {
          rounds: String(rounds),
          seed: String(seed),
          duration: "0",
          interval: String(interval),
        },
      });
      assert.equal(controller.view().invalidOptions, false);
      assert.equal(controller.view().canStart, true);
      startObservations.push({
        id: controller.view().data?.id,
        state: controller.view().data?.state,
        canStart: controller.view().canStart,
        seed,
      });
      return drive(controller, { type: "start" });
    };
    const reportFor = async (id: string) => {
      const response = await fetch(
        `/api/simulation/report?jobId=${encodeURIComponent(id)}`,
      );
      assert.equal(response.status, 200);
      return (await response.json()) as SimulationReport;
    };
    const verifyReport = async (
      job: SimulationJob,
      report: SimulationReport,
      minimumActive: number,
    ) => {
      assert(job.id);
      assert.equal(job.reportAvailable, true);
      assert.equal(report.status, job.state);
      assert.equal(report.chainId, 31337);
      assert.equal(report.seed, job.options!.seed);
      assert.equal(report.finishedAt, job.finishedAt);
      assert.equal(report.accounts.length, 20);
      assert.equal(
        new Set(report.accounts.map((address) => getAddress(address))).size,
        20,
      );
      assert.deepEqual(
        new Set(report.accounts.map((address) => getAddress(address))),
        new Set(accounts),
      );
      assert(report.activeAccounts >= minimumActive);
      const activeAddresses = new Set(
        report.transactions
          .filter(
            (tx) =>
              tx.status === 1 &&
              ["swap", "addLiquidity", "removeLiquidity", "arbitrage"].includes(
                tx.action,
              ),
          )
          .map((tx) => getAddress(tx.account)),
      );
      assert.equal(activeAddresses.size, report.activeAccounts);
      assert.equal(report.transactionCount, report.transactions.length);
      for (const action of [
        "swap",
        "addLiquidity",
        "removeLiquidity",
        "arbitrage",
      ] as const)
        assert.equal(
          report.counts[action],
          report.transactions.filter((tx) => tx.action === action).length,
        );
      await Promise.all(
        report.transactions.map(async (tx) => {
          const receipt = await read.getTransactionReceipt({
            hash: tx.hash as Hex,
          });
          assert.equal(
            receipt.status,
            tx.status === 1 ? "success" : "reverted",
          );
          assert.equal(Number(receipt.blockNumber), tx.blockNumber);
          assert.equal(String(receipt.gasUsed), tx.gasUsed);
          assert.equal(getAddress(receipt.from), getAddress(tx.account));
        }),
      );
      for (const market of report.final) {
        const p = (await read.readContract({
          address: getAddress(market.address),
          abi: dexAbi.abi,
          functionName: "pools",
          args: [BigInt(market.poolId)],
        })) as readonly [string, string, bigint, bigint, bigint, bigint];
        assert.equal(getAddress(market.token0), getAddress(p[0]));
        assert.equal(getAddress(market.token1), getAddress(p[1]));
        assert.equal(market.reserve0, String(p[2]));
        assert.equal(market.reserve1, String(p[3]));
      }
      for (const arb of report.arbitrages) {
        const receipt = await read.getTransactionReceipt({
          hash: arb.hash as Hex,
        });
        const balanceAt = (blockNumber: bigint) =>
          read.readContract({
            address: getAddress(arb.capitalToken),
            abi: tokenAbi.abi,
            functionName: "balanceOf",
            args: [receipt.from],
            blockNumber,
          }) as Promise<bigint>;
        const before = await balanceAt(receipt.blockNumber - 1n),
          after = await balanceAt(receipt.blockNumber);
        assert.equal(after - before, BigInt(arb.profit));
        assert(BigInt(arb.profit) > 0n);
        assert.equal(String(receipt.gasUsed), arb.gasUsed);
        assert.equal(
          String(receipt.gasUsed * receipt.effectiveGasPrice),
          arb.gasCostWei,
        );
      }
      const rollback = await read.getTransactionReceipt({
        hash: report.rollback.hash as Hex,
      });
      assert.equal(rollback.status, "reverted");
      assert.equal(report.rollback.status, 0);
      assert.equal(report.rollback.reservesAndTokenBalancesUnchanged, true);
      assert.deepEqual(
        await nftBalances(),
        initialNfts,
        "all simulation positions were redeemed; seed positions remain",
      );
      for (const exchange of exchanges) {
        const owner = (await read.readContract({
          address: exchange.address,
          abi: dexAbi.abi,
          functionName: "ownerOf",
          args: [1n],
        })) as string;
        assert.equal(
          getAddress(owner),
          accounts[0],
          "the unrelated seed NFT remains owned by its provider",
        );
      }
      await writeFile(
        resolve(directory, `${job.id}-report.json`),
        json(report),
      );
      return {
        job: snapshot(job),
        transactions: report.transactions.length,
        activeAccounts: report.activeAccounts,
        activeAddresses: [...activeAddresses],
        counts: report.counts,
        nftBalances: await nftBalances(),
        rollbackHash: report.rollback.hash,
      };
    };
    const first = new SimulationController();
    const firstJob = await start(first, 4211, 20, 0);
    assert(firstJob.id);
    const observedProgress = await waitFor(
      () => observe(first),
      (j) => j.state === "failed" || j.progress !== null,
      "observable first-run progress",
    );
    assert.notEqual(
      observedProgress.state,
      "failed",
      observedProgress.error ?? "worker failed",
    );
    assert(observedProgress.progress);
    const restored = new SimulationController();
    const writesBefore = requests.filter((r) => r.method === "POST").length;
    const restoredJob = await observe(restored);
    assert.equal(restoredJob.id, firstJob.id);
    assert(restoredJob.progress);
    assert.equal(
      restoredJob.progress.startedAt,
      observedProgress.progress.startedAt,
    );
    assert(
      restoredJob.progress.completedRounds >=
        observedProgress.progress.completedRounds,
    );
    assert.equal(
      requests.filter((r) => r.method === "POST").length,
      writesBefore,
    );
    evidence.restored = {
      original: snapshot(firstJob),
      restored: snapshot(restoredJob),
      observationWrites: 0,
    };
    scenarios.push({
      scenario:
        "A new controller restores the same job and progress without issuing a command",
      outcome: "passed",
    });
    const completed = await waitFor(
      () => observe(restored),
      (j) => ["completed", "failed", "stopped"].includes(j.state),
      "ordinary run completion",
    );
    assert.equal(
      completed.state,
      "completed",
      completed.error ?? "unexpected terminal state",
    );
    evidence.completed = await verifyReport(
      completed,
      await reportFor(firstJob.id),
      10,
    );
    const postsBeforeLongObservation = requests.filter(
      (request) => request.method === "POST",
    ).length;
    for (let observation = 0; observation < 300; observation++) {
      const observed = await observe(restored);
      assert.equal(observed.id, completed.id);
      assert.equal(observed.state, "completed");
      assert.equal(
        observed.progress?.completedRounds,
        completed.progress?.completedRounds,
      );
    }
    assert.equal(
      requests.filter((request) => request.method === "POST").length,
      postsBeforeLongObservation,
    );
    evidence.sustainedObservation = {
      reads: 300,
      writes: 0,
      jobId: completed.id,
    };
    scenarios.push({
      scenario:
        "Completed reports agree with real chain state and remain observable across sustained polling",
      outcome: "passed",
    });
    const second = new SimulationController();
    const secondJob = await start(second, 4212, 100, 500);
    assert(secondJob.id);
    assert.notEqual(secondJob.id, firstJob.id);
    const active = await waitFor(
      () => observe(second),
      (j) =>
        j.state === "failed" ||
        (j.progress?.phase === "trading" &&
          j.progress.counts.addLiquidity > j.progress.counts.removeLiquidity),
      "second job trading",
    );
    assert.notEqual(active.state, "failed", active.error ?? "worker failed");
    // This page still displays the first active job because it has not polled since restoration.
    const staleStop = dispatch(first, { type: "stop" }).effect;
    assert(staleStop && staleStop.kind === "stop");
    assert.equal(staleStop.jobId, firstJob.id);
    await assert.rejects(async () => {
      try {
        await performSimulation(staleStop);
      } catch (error) {
        dispatch(first, {
          type: "failure",
          requestId: staleStop.requestId,
          error: String(error),
        });
        throw error;
      }
    });
    assert.equal(requests.at(-1)?.status, 409);
    const staleReport = await fetch(
      `/api/simulation/report?jobId=${firstJob.id}`,
    );
    assert.equal(staleReport.status, 409);
    const current = await observe(new SimulationController());
    assert.equal(current.id, secondJob.id);
    assert(!["stopped", "stopping", "failed"].includes(current.state));
    await rpc("evm_setAutomine", [false]);
    const pending = await waitFor(
      async () => (await rpc("eth_pendingTransactions")) as { hash: Hex }[],
      (p) => p.length > 0,
      "real worker transaction awaiting mining",
      20_000,
    );
    const beforeStopNfts = await nftBalances();
    assert(
      beforeStopNfts.reduce((n, value) => n + BigInt(value), 0n) >
        initialNfts.reduce((n, value) => n + BigInt(value), 0n),
    );
    const stopping = await drive(second, { type: "stop" });
    assert.equal(stopping.id, secondJob.id);
    assert.equal(stopping.state, "stopping");
    assert.equal(
      await rpc("eth_getTransactionReceipt", [pending[0].hash]),
      null,
    );
    const freshlyObserved = await observe(new SimulationController());
    assert.equal(freshlyObserved.id, secondJob.id);
    assert.equal(freshlyObserved.state, "stopping");
    assert.equal(freshlyObserved.reportAvailable, false);
    // Automining reacts to new submissions; resume a continuing chain for receipt subscriptions too.
    await rpc("evm_setIntervalMining", [250]);
    await rpc("evm_setAutomine", [true]);
    await rpc("evm_mine");
    const minedPending = await waitFor(
      async () =>
        (await rpc("eth_getTransactionReceipt", [pending[0].hash])) as {
          transactionHash: string;
          blockNumber: string;
          status: string;
        } | null,
      (receipt) => receipt !== null,
      "the originally pending transaction was mined",
      20_000,
    );
    assert(minedPending);
    assert.equal(minedPending.status, "0x1");
    evidence.pendingMining = {
      hash: pending[0].hash,
      receipt: minedPending,
      intervalMs: 250,
    };
    const stopped = await waitFor(
      () => observe(second),
      (j) => ["completed", "stopped", "failed"].includes(j.state),
      "stop confirmation and position cleanup",
    );
    assert.equal(
      stopped.state,
      "stopped",
      stopped.error ?? "stop did not settle",
    );
    evidence.stopped = await verifyReport(
      stopped,
      await reportFor(secondJob.id),
      1,
    );
    evidence.stopBoundary = {
      pendingHash: pending[0].hash,
      beforeStopNfts,
      stopping: snapshot(stopping),
      restored: snapshot(freshlyObserved),
      settled: snapshot(stopped),
    };
    scenarios.push({
      scenario:
        "Stale stop/report cannot affect a new job; stop waits for a pending transaction and position cleanup",
      outcome: "passed",
    });
    assert.deepEqual(await fingerprints(), sourceSha256);
    assert.equal(
      await hash(resolve(root, "frontend/src/generated/dex_logic.js")),
      programSha256,
    );
    evidence.status = "passed";
  } catch (error) {
    evidence.status = "failed";
    evidence.actualThrown = error;
    evidence.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    globalThis.fetch = nativeFetch;
    if (service?.pid && service.exitCode === null) {
      const closed = once(service, "close");
      process.kill(-service.pid, "SIGTERM");
      await closed;
    }
    evidence.serviceExit = {
      code: service?.exitCode,
      signal: service?.signalCode,
    };
    evidence.requests = requests;
    evidence.startObservations = startObservations;
    await saveControllerEvents?.();
    evidence.controllerEvents = resolve(directory, "controller-events.json");
    const outcome = evidence.status;
    evidence.status = "finalizing";
    await writeFile(resolve(directory, "result.json"), json(evidence));
    await serviceLog.close();
    await environment.close();
    const launch = JSON.parse(
      await readFile(resolve(directory, "launch.json"), "utf8"),
    ) as { pid: number };
    await waitFor(
      async () => {
        try {
          process.kill(launch.pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
          throw error;
        }
      },
      (value) => value,
      "isolated node exit",
      10_000,
    );
    evidence.isolatedNodeExited = true;
    evidence.status = outcome;
    await writeFile(resolve(directory, "result.json"), json(evidence));
    console.log(
      json({
        status: evidence.status,
        scenarios: scenarios.length,
        evidence: resolve(directory, "result.json"),
      }),
    );
  }
}
await main();
