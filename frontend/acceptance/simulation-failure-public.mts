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
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import {
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  maxUint256,
  type Abi,
  type Hex,
} from "viem";
import type {
  SimulationJob,
  SimulationJournal,
  SimulationOptions,
} from "../../contracts/scripts/simulation-protocol";
import { delay, isolatedChain, root } from "./support/chain.mts";

const json = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? String(v) : v), 2);
const fingerprint = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
async function waitFor<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  label: string,
  timeout = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepts(value)) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function listen(server: Server) {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
type RpcCall = { id: number; method: string; params?: unknown[] };
type RpcResult = { id: number; result?: unknown; error?: unknown };

async function main() {
  const environment = await isolatedChain("simulation-failure-public");
  const { directory, accounts, admin, read, artifact, deploy, rpc } =
    environment;
  const sources = [
    "contracts/scripts/simulation-server.ts",
    "contracts/scripts/simulate.ts",
    "contracts/scripts/simulation-protocol.ts",
  ];
  const sourceFingerprints = Object.fromEntries(
    await Promise.all(
      sources.map(async (p) => [p, await fingerprint(resolve(root, p))]),
    ),
  );
  const evidence: Record<string, unknown> = {
    status: "running",
    sourceFingerprints,
    kernelSha256: await fingerprint(
      resolve(root, "frontend/src/generated/dex_logic.js"),
    ),
    scenarios: [],
  };
  const scenarios = evidence.scenarios as {
    scenario: string;
    outcome: string;
  }[];
  const serviceLog = await open(resolve(directory, "service.log"), "w");
  let service: ChildProcess | undefined;
  let proxy: Server | undefined;
  let mode: "observing" | "outage" | "revert-swap" = "observing";
  let revertedHash: Hex | undefined;
  let faultMintHash: Hex | undefined;
  const observedReceipts = new Set<string>();
  const proxyFailures: string[] = [];
  try {
    const tokenArtifact = await artifact("TestToken"),
      dexArtifact = await artifact("MiniDEX"),
      arbArtifact = await artifact("AtomicArbitrage");
    const a = await deploy(tokenArtifact, ["Failure A", "FLA"]),
      b = await deploy(tokenArtifact, ["Failure B", "FLB"]);
    const exchanges = [
      {
        address: await deploy(dexArtifact, ["Failure Cedar"]),
        name: "Failure Cedar",
      },
      {
        address: await deploy(dexArtifact, ["Failure Harbor"]),
        name: "Failure Harbor",
      },
    ];
    const arbitrage = await deploy(arbArtifact);
    const unit = 10n ** 18n;
    const send = async (
      account: Hex,
      address: Hex,
      abi: Abi,
      functionName: string,
      args: readonly unknown[] = [],
    ) => {
      const hash = await admin.writeContract({
        account,
        address,
        abi,
        functionName,
        args,
      });
      const receipt = await read.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      return receipt;
    };
    for (const token of [a, b]) {
      for (const account of accounts)
        await send(account, token, tokenArtifact.abi, "faucet");
      for (let i = 0; i < 2; i++)
        await send(accounts[0], token, tokenArtifact.abi, "faucet");
      for (const exchange of exchanges)
        await send(accounts[0], token, tokenArtifact.abi, "approve", [
          exchange.address,
          maxUint256,
        ]);
    }
    for (const exchange of exchanges) {
      await send(accounts[0], exchange.address, dexArtifact.abi, "createPool", [
        a,
        b,
      ]);
      await send(
        accounts[0],
        exchange.address,
        dexArtifact.abi,
        "addLiquidity",
        [
          1n,
          10_000n * unit,
          10_000n * unit,
          0n,
          0n,
          (await read.getBlock({ blockTag: "pending" })).timestamp + 1200n,
        ],
      );
    }
    const dexAddresses = new Set(exchanges.map((e) => e.address.toLowerCase()));
    const liquidityEvents = (receipt: {
      logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[];
    }) =>
      receipt.logs
        .filter((log) => dexAddresses.has(log.address.toLowerCase()))
        .flatMap((log) => {
          const event = decodeEventLog({
            abi: dexArtifact.abi,
            topics: log.topics as [Hex, ...Hex[]],
            data: log.data,
            strict: true,
          });
          if (
            event.eventName !== "LiquidityAdded" &&
            event.eventName !== "LiquidityRemoved"
          )
            return [];
          return [
            {
              exchange: getAddress(log.address),
              event: event.eventName,
              args: event.args as unknown as {
                poolId: bigint;
                positionId: bigint;
              },
            },
          ];
        });
    proxy = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString();
        const incoming = JSON.parse(raw) as RpcCall | RpcCall[];
        const calls = Array.isArray(incoming) ? incoming : [incoming];
        if (mode === "outage") {
          response.writeHead(503, { "content-type": "text/plain" });
          response.end(
            "Acceptance fixture: RPC unavailable after confirmed mint",
          );
          return;
        }
        const queuedSwap =
          mode === "revert-swap"
            ? calls.find((call) => {
                if (call.method !== "eth_sendTransaction") return false;
                const tx = call.params?.[0] as { to?: string; data?: Hex };
                if (
                  !tx.to ||
                  !tx.data ||
                  !dexAddresses.has(tx.to.toLowerCase())
                )
                  return false;
                return (
                  decodeFunctionData({ abi: dexArtifact.abi, data: tx.data })
                    .functionName === "swap"
                );
              })
            : undefined;
        if (queuedSwap) await rpc("evm_setAutomine", [false]);
        const upstream = await fetch(environment.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: raw,
        });
        const wire = await upstream.text();
        const decoded = JSON.parse(wire) as RpcResult | RpcResult[];
        const results = Array.isArray(decoded) ? decoded : [decoded];
        if (queuedSwap) {
          const tx = queuedSwap.params![0] as { data: Hex };
          const call = decodeFunctionData({
            abi: dexArtifact.abi,
            data: tx.data,
          });
          const deadline = (call.args as readonly unknown[]).at(-1) as bigint;
          revertedHash = results.find((result) => result.id === queuedSwap.id)!
            .result as Hex;
          assert(revertedHash?.startsWith("0x"), json(results));
          await rpc("evm_setNextBlockTimestamp", [Number(deadline + 1n)]);
          await rpc("evm_mine");
          await rpc("evm_setAutomine", [true]);
          mode = "observing";
        }
        for (const call of calls.filter(
          (call) => call.method === "eth_getTransactionReceipt",
        )) {
          const receipt = results.find((result) => result.id === call.id)
            ?.result as {
            transactionHash: Hex;
            status: string;
            logs: { address: string; data: Hex; topics: Hex[] }[];
          } | null;
          if (!receipt) continue;
          observedReceipts.add(receipt.transactionHash);
          if (
            observedReceipts.size > 115 &&
            !faultMintHash &&
            receipt.status === "0x1" &&
            liquidityEvents(receipt).some(
              (event) => event.event === "LiquidityAdded",
            )
          ) {
            faultMintHash = receipt.transactionHash;
            mode = "outage";
          }
        }
        response.writeHead(upstream.status, {
          "content-type": "application/json",
        });
        response.end(wire);
      } catch (error) {
        proxyFailures.push(String(error));
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(String(error));
      }
    });
    const proxyUrl = await listen(proxy);
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
        rpcUrl: proxyUrl,
        tokens: [
          { address: a, name: "Failure A", symbol: "FLA" },
          { address: b, name: "Failure B", symbol: "FLB" },
        ],
        exchanges,
        arbitrage,
        abis: {
          TestToken: tokenArtifact.abi,
          MiniDEX: dexArtifact.abi,
          AtomicArbitrage: arbArtifact.abi,
        },
      }),
    );
    const reservation = createServer();
    const base = await listen(reservation);
    await new Promise<void>((done, reject) =>
      reservation.close((error) => (error ? reject(error) : done())),
    );
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
          SIMULATION_PORT: new URL(base).port,
          DEX_WEB_PORT: new URL(base).port,
          LOCAL_RPC_URL: proxyUrl,
        },
        stdio: ["ignore", serviceLog.fd, serviceLog.fd],
      },
    );
    await writeFile(
      resolve(directory, "service-launch.json"),
      json({ pid: service.pid, base, proxyUrl, fixture }),
    );
    await waitFor(
      async () => {
        // DEFENSE: the child service has not bound its public HTTP port while starting.
        try {
          return (await fetch(base + "/api/simulation")).status;
        } catch (error) {
          if (error instanceof TypeError) return 0;
          throw error;
        }
      },
      (status) => status === 200,
      "service startup",
      20_000,
    );
    assert.equal(
      (await fetch(base + "/api/simulation/journal?jobId=missing")).status,
      404,
    );
    const job = async () =>
      (await (await fetch(base + "/api/simulation")).json()) as SimulationJob;
    const start = async (seed: number, rounds = 200) => {
      const options: SimulationOptions = {
        rounds,
        seed,
        durationSeconds: 0,
        intervalMs: 5,
      };
      const response = await fetch(base + "/api/simulation/start", {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: json(options),
      });
      assert.equal(response.status, 202, await response.clone().text());
      const value = (await response.json()) as SimulationJob;
      assert(value.id);
      return value;
    };
    const journalFor = async (id: string) => {
      const response = await fetch(
        `${base}/api/simulation/journal?jobId=${encodeURIComponent(id)}`,
      );
      assert.equal(response.status, 200, await response.clone().text());
      assert.match(
        response.headers.get("content-disposition") ?? "",
        /attachment/,
      );
      return (await response.json()) as SimulationJournal;
    };
    const assertSeeds = async () => {
      for (const exchange of exchanges)
        assert.equal(
          getAddress(
            (await read.readContract({
              address: exchange.address,
              abi: dexArtifact.abi,
              functionName: "ownerOf",
              args: [1n],
            })) as string,
          ),
          accounts[0],
        );
    };
    const before = await read.getBlockNumber({ cacheTime: 0 });
    const first = await start(4212);
    const failed = await waitFor(
      job,
      (value) => value.state === "failed",
      "worker failure after injected RPC outage",
    );
    assert(
      faultMintHash,
      "fixture must fault only after a confirmed mint beyond the 100-entry progress window",
    );
    assert.equal(failed.reportAvailable, false);
    const journal = await journalFor(first.id!);
    assert.equal(journal.jobId, first.id);
    assert.equal(journal.state, "failed");
    assert(journal.error && journal.finishedAt);
    assert(journal.transactions.length > 115);
    assert.equal(failed.journal?.transactionCount, journal.transactions.length);
    assert.deepEqual(failed.journal?.positions, journal.positions);
    assert(journal.transactions.some((tx) => tx.hash === faultMintHash));
    const through = await read.getBlockNumber({ cacheTime: 0 });
    const chainHashes: string[] = [];
    for (let blockNumber = before + 1n; blockNumber <= through; blockNumber++)
      chainHashes.push(
        ...((await read.getBlock({ blockNumber })).transactions as Hex[]),
      );
    assert.deepEqual(
      [...journal.transactions.map((tx) => tx.hash)].sort(),
      [...chainHashes].sort(),
      "journal must retain every actual transaction, including those older than the progress window",
    );
    assert.equal(new Set(chainHashes).size, journal.transactions.length);
    const actualPositions = new Map<
      string,
      {
        exchange: string;
        poolId: string;
        positionId: string;
        account: string;
        mintHash: string;
        redeemHash: string | null;
      }
    >();
    for (const tx of journal.transactions) {
      const receipt = await read.getTransactionReceipt({
        hash: tx.hash as Hex,
      });
      assert.equal(Number(receipt.blockNumber), tx.blockNumber);
      assert.equal(getAddress(receipt.from), getAddress(tx.account));
      assert.equal(receipt.gasUsed.toString(), tx.gasUsed);
      assert.equal(receipt.status === "success" ? 1 : 0, tx.status);
      for (const event of liquidityEvents(receipt)) {
        const positionId = String(event.args.positionId),
          poolId = String(event.args.poolId);
        assert.deepEqual(tx.liquidity, {
          exchange: event.exchange,
          poolId,
          positionId,
        });
        const key = `${event.exchange}/${positionId}`;
        if (event.event === "LiquidityAdded")
          actualPositions.set(key, {
            exchange: event.exchange,
            poolId,
            positionId,
            account: tx.account,
            mintHash: tx.hash,
            redeemHash: null,
          });
        else {
          const position = actualPositions.get(key);
          assert(
            position,
            "run must not redeem a position outside its own confirmed mints",
          );
          position.redeemHash = tx.hash;
        }
      }
    }
    const normalize = (positions: SimulationJournal["positions"]) =>
      positions
        .map((p) => ({
          ...p,
          exchange: getAddress(p.exchange),
          account: getAddress(p.account),
        }))
        .sort((x, y) =>
          `${x.exchange}/${x.positionId}`.localeCompare(
            `${y.exchange}/${y.positionId}`,
          ),
        );
    assert.deepEqual(
      normalize(journal.positions),
      normalize([...actualPositions.values()]),
    );
    const unredeemed = journal.positions.filter(
      (position) => position.redeemHash === null,
    );
    assert(
      unredeemed.length > 0,
      "injected outage must leave an actual minted NFT without a recorded burn",
    );
    for (const position of unredeemed)
      assert.equal(
        getAddress(
          (await read.readContract({
            address: getAddress(position.exchange),
            abi: dexArtifact.abi,
            functionName: "ownerOf",
            args: [BigInt(position.positionId)],
          })) as string,
        ),
        getAddress(position.account),
      );
    await assertSeeds();
    assert(failed.progress && failed.progress.transactions.length <= 100);
    assert(
      journal.transactions.some(
        (tx) =>
          !failed.progress!.transactions.some(
            (recent) => recent.hash === tx.hash,
          ),
      ),
    );
    await writeFile(
      resolve(directory, "rpc-failure-journal.json"),
      json(journal),
    );
    evidence.rpcFailure = {
      id: first.id,
      faultMintHash,
      transactionCount: journal.transactions.length,
      recentProgressCount: failed.progress.transactions.length,
      unredeemed,
      fromBlock: String(before + 1n),
      throughBlock: String(through),
    };
    scenarios.push({
      scenario:
        "RPC failure retains all confirmed receipts and exact mint/burn evidence",
      outcome: "passed",
    });

    mode = "observing";
    const seedBalance = (await read.readContract({
      address: a,
      abi: tokenArtifact.abi,
      functionName: "balanceOf",
      args: [accounts[1]],
    })) as bigint;
    await send(accounts[1], a, tokenArtifact.abi, "transfer", [
      accounts[0],
      seedBalance,
    ]);
    const beforePreflight = await read.getBlockNumber({ cacheTime: 0 });
    const nonces = await Promise.all(
      accounts.map((account) => read.getTransactionCount({ address: account })),
    );
    const second = await start(4213, 20);
    assert.notEqual(second.id, first.id);
    assert.equal(
      (await fetch(`${base}/api/simulation/journal?jobId=${first.id}`)).status,
      409,
    );
    const fundingFailure = await waitFor(
      job,
      (value) => value.state === "failed",
      "funding preflight failure",
    );
    assert.equal(await read.getBlockNumber({ cacheTime: 0 }), beforePreflight);
    assert.deepEqual(
      await Promise.all(
        accounts.map((account) =>
          read.getTransactionCount({ address: account }),
        ),
      ),
      nonces,
    );
    assert.match(
      fundingFailure.error ?? "",
      /account\s*2|0x70997970c51812dc3a010c7d01b50e0d17dc79c8/i,
    );
    assert.match(fundingFailure.error ?? "", /FLA|1000|1,000|0x[a-f\d]{40}/i);
    const fundingJournal = await journalFor(second.id!);
    assert.equal(fundingJournal.transactions.length, 0);
    assert.equal(fundingJournal.positions.length, 0);
    await assertSeeds();
    evidence.fundingFailure = {
      job: fundingFailure,
      block: String(beforePreflight),
      nonceUnchanged: true,
    };
    scenarios.push({
      scenario:
        "unfunded required seed is rejected before any chain write and old jobs stay isolated",
      outcome: "passed",
    });

    await send(accounts[1], a, tokenArtifact.abi, "faucet");
    mode = "revert-swap";
    const third = await start(4214, 20);
    const reverted = await waitFor(
      job,
      (value) => value.state === "failed",
      "expired mined swap failure",
    );
    assert(
      revertedHash,
      "fixture must mine an unmodified pending swap after its actual deadline",
    );
    const revertedReceipt = await read.getTransactionReceipt({
      hash: revertedHash,
    });
    assert.equal(revertedReceipt.status, "reverted");
    const revertedJournal = await journalFor(third.id!);
    const recordedRevert = revertedJournal.transactions.find(
      (tx) => tx.hash === revertedHash,
    );
    assert(
      recordedRevert,
      "an actual status-0 receipt must survive the worker's thrown error",
    );
    assert.equal(recordedRevert.status, 0);
    assert.equal(recordedRevert.gasUsed, revertedReceipt.gasUsed.toString());
    assert.equal(recordedRevert.liquidity, undefined);
    assert.equal(reverted.reportAvailable, false);
    await assertSeeds();
    evidence.reverted = {
      id: third.id,
      hash: revertedHash,
      receipt: revertedReceipt,
      transaction: recordedRevert,
    };
    scenarios.push({
      scenario:
        "mined business revert retains its actual failed receipt without inventing success or cleanup",
      outcome: "passed",
    });
    assert.deepEqual(proxyFailures, []);
    for (const [file, expected] of Object.entries(sourceFingerprints))
      assert.equal(
        await fingerprint(resolve(root, file)),
        expected,
        `source changed during acceptance: ${file}`,
      );
    evidence.status = "passed";
  } catch (error) {
    evidence.status = "failed";
    evidence.error = String(error);
    evidence.proxyFailures = proxyFailures;
    throw error;
  } finally {
    await writeFile(resolve(directory, "result.json"), json(evidence));
    if (service?.pid && service.exitCode === null) {
      process.kill(-service.pid, "SIGTERM");
      await Promise.race([once(service, "exit"), delay(5000)]);
    }
    if (proxy)
      await new Promise<void>((done, reject) =>
        proxy!.close((error) => (error ? reject(error) : done())),
      );
    await serviceLog.close();
    await environment.close();
    console.log(resolve(directory, "result.json"));
  }
}
await main();
