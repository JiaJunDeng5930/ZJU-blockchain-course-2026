import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { decodeFunctionData, getAddress, maxUint256 } from "viem";
import { ExchangeClient } from "../src/chain/client";
import type { ArbitrageResult, Deployment, Pool } from "../src/chain/types";
import { scanArbitrage } from "../src/logic/arbitrage";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, until } from "./support/chain.mts";

const units = 10n ** 18n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, v) => (typeof v === "bigint" ? String(v) : v),
    2,
  );
const programFile = new URL("../src/generated/dex_logic.js", import.meta.url);
const programHash = async () =>
  createHash("sha256")
    .update(await readFile(programFile))
    .digest("hex");

const sourceHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      [
        "chain/liquidity.ts",
        "chain/arbitrage.ts",
        "chain/client.ts",
        "wallet/session.ts",
      ].map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(new URL(`../src/${name}`, import.meta.url)))
          .digest("hex"),
      ]),
    ),
  );

type Write = {
  from: string;
  to: string;
  data: string;
  functionName: string;
  args: readonly unknown[];
  pendingTimestamp: bigint;
  hash?: string;
  delayedApproval?: { before: bigint; minedAt: bigint };
  rpcError?: unknown;
};

async function main() {
  const environment = await isolatedChain("deadlines-public");
  const { accounts, admin, read, artifact, deploy, rpc, directory } =
    environment;
  const writes: Write[] = [];
  const scenarios: { scenario: string; outcome: string; error?: string }[] = [];
  const evidence: Record<string, unknown> = {
    status: "running",
    programSha256: await programHash(),
    sourceSha256: await sourceHashes(),
    scenarios,
    writes,
  };
  let wallet: WalletController | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  const state = { delayApprovals: false };
  const abiByAddress = new Map<
    string,
    Awaited<ReturnType<typeof artifact>>["abi"]
  >();
  const latestTime = async () => (await read.getBlock()).timestamp;
  const pendingTime = async () =>
    (await read.getBlock({ blockTag: "pending" })).timestamp;

  const scenario = async (name: string, action: () => Promise<void>) => {
    evidence.currentScenario = name;
    try {
      await action();
      assert.equal(await programHash(), evidence.programSha256);
      assert.deepEqual(await sourceHashes(), evidence.sourceSha256);
      scenarios.push({ scenario: name, outcome: "passed" });
    } catch (error) {
      scenarios.push({
        scenario: name,
        outcome: "failed",
        error: String(error),
      });
    } finally {
      state.delayApprovals = false;
      delete evidence.currentScenario;
    }
  };

  try {
    const tokenArtifact = await artifact("TestToken");
    const dexArtifact = await artifact("MiniDEX");
    const arbArtifact = await artifact("AtomicArbitrage");
    const a = await deploy(tokenArtifact, ["Deadline A", "DLA"]);
    const b = await deploy(tokenArtifact, ["Deadline B", "DLB"]);
    const wrapped = await deploy(await artifact("WrappedEther"));
    const first = await deploy(dexArtifact, ["First deadline DEX"]);
    const second = await deploy(dexArtifact, ["Second deadline DEX"]);
    const arbitrage = await deploy(arbArtifact);
    for (const address of [a, b])
      abiByAddress.set(address.toLowerCase(), tokenArtifact.abi);
    for (const address of [first, second])
      abiByAddress.set(address.toLowerCase(), dexArtifact.abi);
    abiByAddress.set(arbitrage.toLowerCase(), arbArtifact.abi);

    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const incoming = JSON.parse(Buffer.concat(chunks).toString());
      let delayed = false;
      try {
        let write: Write | undefined;
        if (incoming.method === "eth_sendTransaction") {
          const submitted = incoming.params[0];
          const abi = abiByAddress.get(submitted.to.toLowerCase());
          assert(abi, "wallet only submits to the fixture's public contracts");
          const decoded = decodeFunctionData({ abi, data: submitted.data });
          write = {
            ...submitted,
            functionName: decoded.functionName,
            args: decoded.args ?? [],
            pendingTimestamp: await pendingTime(),
          };
          assert(write);
          writes.push(write);
          if (state.delayApprovals && decoded.functionName === "approve") {
            await rpc("evm_setAutomine", [false]);
            delayed = true;
          }
        }
        const result = await fetch(environment.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(incoming),
        }).then((reply) => reply.json());
        if (write && typeof result.result === "string") {
          write.hash = result.result;
          if (delayed) {
            const before = await latestTime();
            await rpc("evm_setNextBlockTimestamp", [Number(before + 1500n)]);
            await rpc("evm_mine");
            write.delayedApproval = { before, minedAt: await latestTime() };
          }
        }
        if (write && result.error) write.rpcError = result.error;
        if (delayed) {
          await rpc("evm_setAutomine", [true]);
          delayed = false;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch (error) {
        // DEFENSE: a failed fixture RPC must settle the wallet request, not leave it pending.
        if (delayed) await rpc("evm_setAutomine", [true]);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: incoming.id,
            error: { code: -32000, message: String(error) },
          }),
        );
      }
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    const deployment: Deployment = {
      schemaVersion: 1,
      chainId: 31337,
      rpcUrl: `http://127.0.0.1:${port}`,
      tokens: [
        {
          address: a,
          name: "Deadline A",
          symbol: "DLA",
          kind: "faucet",
          decimals: 18,
        },
        {
          address: b,
          name: "Deadline B",
          symbol: "DLB",
          kind: "faucet",
          decimals: 18,
        },
        {
          address: wrapped,
          name: "Wrapped Ether",
          symbol: "WETH",
          kind: "wrapped",
          decimals: 18,
        },
      ],
      exchanges: [
        { address: first, name: "First deadline DEX" },
        { address: second, name: "Second deadline DEX" },
      ],
      arbitrage,
      bytecodes: { TestToken: tokenArtifact.bytecode },
    };
    const client = new ExchangeClient(deployment);
    await client.verifyDeployment();
    wallet = new WalletController(client, { storage: null });
    await wallet.start();
    wallet.dispatch({ kind: "select-local", address: accounts[1] });
    const owner = accounts[1];
    await until(
      () => wallet!.session(),
      (value) => !!value && same(value.address, owner),
      "deadline wallet",
    );
    const controller = wallet;
    const perform = (
      label: string,
      action: Parameters<WalletController["perform"]>[0]["perform"],
    ) => {
      const session = controller.session();
      assert(session);
      return controller.perform({ label, session, perform: action });
    };
    const adminWrite = async (
      address: string,
      functionName: string,
      args: readonly unknown[] = [],
    ) => {
      const abi = abiByAddress.get(address.toLowerCase());
      assert(abi);
      const hash = await admin.writeContract({
        address: getAddress(address),
        abi,
        functionName,
        args,
      });
      const receipt = await read.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
    };
    for (const token of deployment.tokens.slice(0, 2)) {
      await perform("Fund deadline user", (writer) => writer.faucet(token));
      await adminWrite(token.address, "faucet");
      for (const exchange of [first, second])
        await adminWrite(token.address, "approve", [exchange, maxUint256]);
    }
    const findPool = async (exchange: string): Promise<Pool> => {
      const snapshot = await client.snapshot(owner, deployment.tokens);
      const pool = snapshot.pools.find((candidate) =>
        same(candidate.exchange.address, exchange),
      );
      assert(pool);
      return pool;
    };
    for (const exchange of [first, second]) {
      await adminWrite(exchange, "createPool", [a, b]);
      const pool = await findPool(exchange);
      const aAmount = 1000n * units;
      const bAmount = (same(exchange, first) ? 1000n : 2000n) * units;
      await adminWrite(exchange, "addLiquidity", [
        pool.id,
        same(pool.token0, a) ? aAmount : bAmount,
        same(pool.token1, b) ? bAmount : aAmount,
        0n,
        0n,
        (await pendingTime()) + 1200n,
      ]);
    }

    const confirmedWrite = async (
      start: number,
      name: string,
      expectedApprovals: number,
    ) => {
      const operationWrites = writes.slice(start);
      const approvals = operationWrites.filter(
        (write) => write.functionName === "approve",
      );
      assert.equal(approvals.length, expectedApprovals);
      for (const approval of approvals) {
        assert(approval.delayedApproval);
        assert(
          approval.delayedApproval.minedAt - approval.delayedApproval.before >
            1200n,
        );
      }
      const calls = operationWrites.filter(
        (write) => write.functionName === name,
      );
      assert.equal(
        calls.length,
        1,
        "the operation submits its business call exactly once",
      );
      const call = calls[0];
      assert(call.hash);
      const receipt = await read.getTransactionReceipt({
        hash: call.hash as `0x${string}`,
      });
      assert.equal(receipt.status, "success");
      const deadline = call.args.at(-1);
      assert.equal(typeof deadline, "bigint");
      assert.equal(
        deadline,
        call.pendingTimestamp + 1200n,
        "deadline is bound to the business call's pending chain time",
      );
      const mined = await read.getBlock({ blockNumber: receipt.blockNumber });
      assert(mined.timestamp <= deadline);
      return {
        call,
        approvals,
        block: receipt.blockNumber,
        minedAt: mined.timestamp,
      };
    };

    await scenario(
      "Two slow approvals do not consume the liquidity transaction lifetime",
      async () => {
        const pool = await findPool(first);
        const before = await client.snapshot(owner, deployment.tokens);
        const start = writes.length;
        state.delayApprovals = true;
        await perform("Add liquidity after slow approvals", (writer) =>
          writer.addLiquidity(pool, 10n * units, 10n * units, 50n),
        );
        const observed = await confirmedWrite(start, "addLiquidity", 2);
        assert.deepEqual(observed.call.args.slice(0, 5), [
          pool.id,
          10n * units,
          10n * units,
          (995n * units) / 100n,
          (995n * units) / 100n,
        ]);
        const after = await client.snapshot(owner, deployment.tokens);
        assert.equal(
          after.positions.filter((position) => same(position.owner, owner))
            .length,
          1,
        );
        assert.equal(before.balances[a] - after.balances[a], 10n * units);
        assert.equal(before.balances[b] - after.balances[b], 10n * units);
        const nextPool = await findPool(first);
        assert.equal(nextPool.reserve0 - pool.reserve0, 10n * units);
        assert.equal(nextPool.reserve1 - pool.reserve1, 10n * units);
        evidence.liquidity = {
          observed,
          position: after.positions.find((position) =>
            same(position.owner, owner),
          ),
          beforePool: pool,
          afterPool: nextPool,
        };
      },
    );

    await scenario(
      "Swap remains executable after its slow approval",
      async () => {
        const pool = await findPool(first);
        const before = await client.snapshot(owner, deployment.tokens);
        const swapAmount = 11n * units;
        const quote = await client.quote(pool, a, swapAmount);
        assert(quote > 0n);
        const start = writes.length;
        state.delayApprovals = true;
        await perform("Swap after slow approval", (writer) =>
          writer.swap(pool, a, swapAmount, quote, 50n),
        );
        const observed = await confirmedWrite(start, "swap", 1);
        assert.equal(observed.call.args[0], pool.id);
        assert(same(String(observed.call.args[1]), a));
        assert.equal(observed.call.args[2], swapAmount);
        assert.equal(observed.call.args[3], (quote * 9950n) / 10000n);
        const after = await client.snapshot(owner, deployment.tokens);
        assert.equal(before.balances[a] - after.balances[a], swapAmount);
        assert.equal(after.balances[b] - before.balances[b], quote);
        evidence.swap = { observed, quoted: quote };
      },
    );

    await scenario(
      "Atomic arbitrage keeps its route and minimum profit after a slow approval",
      async () => {
        const before = await client.snapshot(owner, deployment.tokens);
        const pool = await findPool(first);
        const route = scanArbitrage(
          pool,
          before.pools,
          a,
          before.block,
          deployment.tokens,
        )[0];
        assert(route, "the fixture must offer a profitable atomic route");
        const start = writes.length;
        let result: ArbitrageResult | undefined;
        state.delayApprovals = true;
        await perform("Arbitrage after slow approval", async (writer) => {
          result = await writer.arbitrage(route, "0.000001");
        });
        const observed = await confirmedWrite(start, "execute", 1);
        assert(result);
        assert(same(String(observed.call.args[0]), route.buy.exchange.address));
        assert.equal(observed.call.args[1], route.buy.id);
        assert(
          same(String(observed.call.args[2]), route.sell.exchange.address),
        );
        assert.equal(observed.call.args[3], route.sell.id);
        assert(same(String(observed.call.args[4]), a));
        assert.equal(observed.call.args[5], route.amountIn);
        assert.equal(observed.call.args[6], 10n ** 12n);
        const after = await client.snapshot(owner, deployment.tokens);
        assert(result.profit >= 10n ** 12n);
        assert.equal(after.balances[a] - before.balances[a], result.profit);
        assert.equal(after.balances[b], before.balances[b]);
        evidence.arbitrage = { observed, route, result };
      },
    );
    assert.equal(
      scenarios.filter((entry) => entry.outcome === "failed").length,
      0,
      "all public deadline scenarios must pass",
    );
    evidence.status = "passed";
  } catch (error) {
    evidence.status = "failed";
    evidence.error = String(error);
    process.exitCode = 1;
  } finally {
    wallet?.stop();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server!.close((error) => (error ? reject(error) : done())),
      );
    }
    await environment.close();
    await writeFile(`${directory}/result.json`, json(evidence) + "\n");
    console.log(
      json({
        status: evidence.status,
        scenarios,
        result: `${directory}/result.json`,
        programSha256: evidence.programSha256,
      }),
    );
  }
}

await main();
