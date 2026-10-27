import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseUnits } from "viem";
import { ExchangeClient } from "../src/chain/client";
import { poolKey } from "../src/chain/amounts";
import type { Deployment } from "../src/chain/types";
import { resolvePoolSelection } from "../src/logic/poolSelection";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, root, until } from "./support/chain.mts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry),
    2,
  );

async function main() {
  const environment = await isolatedChain("pool-location-public");
  const { directory, accounts, admin, artifact, deploy, read, rpc } =
    environment;
  const paths = [
    "frontend/src/generated/dex_logic.js",
    "frontend/src/logic/poolSelection.ts",
    "frontend/src/chain/amounts.ts",
    "frontend/src/chain/client.ts",
    "frontend/src/chain/types.ts",
    "frontend/src/wallet/session.ts",
  ];
  const fingerprints = async () =>
    Object.fromEntries(
      await Promise.all(
        paths.map(async (path) => [
          path,
          createHash("sha256")
            .update(await readFile(resolve(root, path)))
            .digest("hex"),
        ]),
      ),
    );
  let wallet: WalletController | undefined;
  let sources: Record<string, string> = {};
  const scenarios: string[] = [];
  const evidence: Record<string, unknown> = {
    scope:
      "Domain selection and explicit-pool SDK binding; React Swap best-quote routing and browser push/pop are outside this runner.",
  };
  try {
    sources = await fingerprints();
    const tokenArtifact = await artifact("TestToken"),
      dex = await artifact("MiniDEX");
    const first = await deploy(tokenArtifact, ["Location capital", "LOC"]);
    const second = await deploy(tokenArtifact, ["Location reserve", "RSV"]);
    const wrapped = await deploy(await artifact("WrappedEther"));
    const harbor = await deploy(dex, ["Location Harbor"]);
    const summit = await deploy(dex, ["Location Summit"]);
    const legacy = await deploy(dex, ["Earlier deployment"]);
    const arbitrage = await deploy(await artifact("AtomicArbitrage"));
    const deployment: Deployment = {
      schemaVersion: 1,
      chainId: 31337,
      rpcUrl: environment.rpcUrl,
      tokens: [
        {
          address: first,
          name: "Location capital",
          symbol: "LOC",
          kind: "faucet",
          decimals: 18,
        },
        {
          address: second,
          name: "Location reserve",
          symbol: "RSV",
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
        { address: harbor, name: "Location Harbor" },
        { address: summit, name: "Location Summit" },
      ],
      arbitrage,
      bytecodes: { TestToken: tokenArtifact.bytecode },
    };
    const client = new ExchangeClient(deployment);
    await client.verifyDeployment();
    const actor = accounts[1];
    wallet = new WalletController(client, { storage: null });
    await wallet.start();
    wallet.dispatch({ kind: "select-local", address: actor });
    await until(
      () => wallet!.session(),
      (session) => !!session && same(session.address, actor),
      "location wallet",
    );
    const perform = async (
      label: string,
      action: Parameters<WalletController["perform"]>[0]["perform"],
    ) => {
      const session = wallet!.session();
      assert(session);
      await wallet!.perform({ label, session, perform: action });
    };
    for (const token of deployment.tokens.slice(0, 2))
      await perform("Fund location actor", (writer) => writer.faucet(token));
    for (const exchange of deployment.exchanges)
      await perform("Create location pool", (writer) =>
        writer.createPool(exchange.address, first, second),
      );
    let snapshot = await client.snapshot(actor, deployment.tokens);
    assert.equal(snapshot.pools.length, 2);
    const amount = parseUnits("1000", 18);
    for (const pool of snapshot.pools)
      await perform("Seed location pool", (writer) =>
        writer.addLiquidity(pool, amount, amount, 50n),
      );
    snapshot = await client.snapshot(actor, deployment.tokens);
    const firstPool = snapshot.pools.find((pool) =>
      same(pool.exchange.address, harbor),
    );
    const target = snapshot.pools.find((pool) =>
      same(pool.exchange.address, summit),
    );
    assert(firstPool && target);
    assert.equal(firstPool.id, target.id);

    const location = new URL("http://127.0.0.1:3000/");
    location.searchParams.set("view", "swap");
    location.searchParams.set("pool", poolKey(target));
    const selected = resolvePoolSelection(
      location.searchParams.get("pool"),
      snapshot.pools,
    );
    assert.equal(selected.kind, "selected");
    assert(selected.kind === "selected");
    assert(same(selected.pool.exchange.address, summit));
    const input = parseUnits("11", 18);
    const quoted = await client.quote(selected.pool, first, input);
    assert(quoted > 0n);
    await perform("Trade URL-selected pool", (writer) =>
      writer.swap(selected.pool, first, input, quoted, 50n),
    );
    const after = await client.snapshot(actor, deployment.tokens);
    const logs = await read.getContractEvents({
      address: summit,
      abi: dex.abi,
      eventName: "Swap",
      strict: true,
      fromBlock: BigInt(snapshot.block + 1),
      toBlock: BigInt(after.block),
    });
    assert.equal(logs.length, 1);
    const swap = logs[0].args as {
      poolId: bigint;
      tokenIn: string;
      amountIn: bigint;
      amountOut: bigint;
      recipient: string;
    };
    assert.equal(swap.poolId, target.id);
    assert(same(swap.tokenIn, first));
    assert.equal(swap.amountIn, input);
    assert(swap.amountOut > 0n);
    assert(same(swap.recipient, actor));
    const receipt = await read.getTransactionReceipt({
      hash: logs[0].transactionHash,
    });
    assert.equal(receipt.status, "success");
    assert(receipt.to && same(receipt.to, summit));
    assert.deepEqual(
      after.pools.find((pool) => same(pool.exchange.address, harbor)),
      firstPool,
    );
    const current = after.pools.find((pool) =>
      same(pool.exchange.address, summit),
    );
    assert(current);
    assert.notDeepEqual(
      [current.reserve0, current.reserve1],
      [target.reserve0, target.reserve1],
    );
    assert.equal(after.balances[first], snapshot.balances[first] - input);
    assert.equal(
      after.balances[second],
      snapshot.balances[second] + swap.amountOut,
    );
    scenarios.push(
      "A URL-resolved context supplied to the explicit-pool writer binds its named DEX",
    );
    evidence.execution = {
      location: location.href,
      selected: selected.pool,
      receipt,
      swap,
      current,
      otherPool: firstPool,
    };

    const reopened = new URL(location.href);
    const restored = resolvePoolSelection(
      reopened.searchParams.get("pool"),
      after.pools,
    );
    assert.equal(restored.kind, "selected");
    assert(restored.kind === "selected");
    const chainPool = (await read.readContract({
      address: summit,
      abi: dex.abi,
      functionName: "pools",
      args: [target.id],
    })) as readonly [string, string, bigint, bigint, bigint, bigint];
    assert(same(restored.pool.exchange.address, summit));
    assert.equal(restored.pool.id, target.id);
    assert.equal(restored.pool.reserve0, chainPool[2]);
    assert.equal(restored.pool.reserve1, chainPool[3]);
    assert.equal(restored.pool.totalShares, chainPool[4]);
    assert.notDeepEqual(
      [restored.pool.reserve0, restored.pool.reserve1],
      [target.reserve0, target.reserve1],
    );
    scenarios.push(
      "A copied URL resolves refreshed chain reserves instead of its former quote snapshot",
    );
    evidence.restored = {
      location: reopened.href,
      pool: restored.pool,
      chainPool,
    };

    const createLegacyHash = await admin.writeContract({
      address: legacy,
      abi: dex.abi,
      functionName: "createPool",
      args: [first, second],
    });
    assert.equal(
      (await read.waitForTransactionReceipt({ hash: createLegacyHash })).status,
      "success",
    );
    const legacyId = (await read.readContract({
      address: legacy,
      abi: dex.abi,
      functionName: "getPool",
      args: [first, second],
    })) as bigint;
    assert.equal(legacyId, target.id);
    const earlierClient = new ExchangeClient({
      ...deployment,
      exchanges: [{ address: legacy, name: "Earlier deployment" }],
    });
    await earlierClient.verifyDeployment();
    const earlierSnapshot = await earlierClient.snapshot(
      actor,
      deployment.tokens,
    );
    assert.equal(earlierSnapshot.pools.length, 1);
    const earlierPool = earlierSnapshot.pools[0];
    assert.equal(earlierPool.id, legacyId);
    const oldLocation = new URL(location.href);
    oldLocation.searchParams.set("pool", poolKey(earlierPool));
    const beforeReject = {
      block: await read.getBlockNumber(),
      nonce: await rpc("eth_getTransactionCount", [actor, "latest"]),
    };
    const live = await client.snapshot(actor, deployment.tokens);
    const missing = resolvePoolSelection(
      oldLocation.searchParams.get("pool"),
      live.pools,
    );
    assert.deepEqual(missing, {
      kind: "missing",
      requested: oldLocation.searchParams.get("pool"),
    });
    assert.equal(Object.hasOwn(missing, "pool"), false);
    assert.equal(await read.getBlockNumber(), beforeReject.block);
    assert.equal(
      await rpc("eth_getTransactionCount", [actor, "latest"]),
      beforeReject.nonce,
    );
    oldLocation.searchParams.delete("pool");
    const explicitDefault = resolvePoolSelection(
      oldLocation.searchParams.get("pool"),
      live.pools,
    );
    assert.equal(explicitDefault.kind, "selected");
    assert(explicitDefault.kind === "selected");
    assert(
      live.pools.some(
        (pool) => poolKey(pool) === poolKey(explicitDefault.pool),
      ),
    );
    scenarios.push(
      "A real pool outside the active deployment remains missing until its URL target is explicitly cleared",
    );
    evidence.unavailable = {
      legacy,
      legacyId,
      requestedLocation: poolKey(earlierPool),
      missing,
      clearedLocation: oldLocation.href,
      defaultPool: explicitDefault.pool,
      beforeReject,
    };

    assert.deepEqual(
      await fingerprints(),
      sources,
      "Acceptance ran one unchanged program and adapter snapshot",
    );
    await writeFile(
      resolve(directory, "result.json"),
      json({
        status: "passed",
        kernelSha256: sources[paths[0]],
        sourceFingerprints: sources,
        scenarios,
        evidence,
      }),
    );
    console.log(
      json({
        status: "passed",
        scenarios: scenarios.length,
        result: resolve(directory, "result.json"),
      }),
    );
  } catch (error) {
    await writeFile(
      resolve(directory, "result.json"),
      json({
        status: "failed",
        sourceFingerprints: sources,
        scenarios,
        evidence,
        error: error instanceof Error ? error.stack : String(error),
      }),
    );
    throw error;
  } finally {
    wallet?.stop();
    await environment.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
