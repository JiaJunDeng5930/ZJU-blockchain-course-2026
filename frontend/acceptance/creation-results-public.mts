import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  erc20Abi,
  getAddress,
  parseEventLogs,
  parseEther,
  type Address,
} from "viem";
import { ExchangeClient } from "../src/chain/client";
import type {
  Deployment,
  LiquidityConfirmation,
  PoolCreationConfirmation,
  TokenCreationConfirmation,
} from "../src/chain/types";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, root, until } from "./support/chain.mts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
const sourceFiles = [
  "frontend/src/generated/dex_logic.js",
  "frontend/src/chain/client.ts",
  "frontend/src/chain/assets.ts",
  "frontend/src/chain/types.ts",
  "frontend/src/wallet/session.ts",
  "frontend/acceptance/creation-results-public.mts",
];
const fingerprints = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (p) => [
        p,
        createHash("sha256")
          .update(await readFile(resolve(root, p)))
          .digest("hex"),
      ]),
    ),
  );

async function main() {
  const env = await isolatedChain("creation-results-public");
  const { directory, artifact, deploy, accounts, read, rpc, admin } = env;
  const sources = await fingerprints();
  const scenarios: string[] = [];
  const evidence: Record<string, unknown> = {};
  let wallet: WalletController | undefined;
  let blockCreatedMetadata = false;
  let createdAddress: string | undefined;
  let unavailablePool: string | undefined;
  let blockedMetadataReads = 0;
  let miningPaused = false;
  const proxy = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const requests = JSON.parse(body);
      const items = Array.isArray(requests) ? requests : [requests];
      if (
        items.some(
          (item) =>
            item.method === "eth_call" &&
            ((blockCreatedMetadata &&
              createdAddress &&
              same(item.params[0].to, createdAddress)) ||
              (unavailablePool && same(item.params[0].to, unavailablePool))),
        )
      ) {
        blockedMetadataReads++;
        response.writeHead(503, { "content-type": "text/plain" });
        response.end(
          "The requested asset or pool observation is temporarily unavailable.",
        );
        return;
      }
      const forwarded = await fetch(env.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const text = await forwarded.text();
      const results = JSON.parse(text);
      for (const item of Array.isArray(results) ? results : [results]) {
        if (item.result?.hash && typeof item.result.input === "string")
          evidence.observedTransaction = item.result;
      }
      if (blockCreatedMetadata)
        for (const item of Array.isArray(results) ? results : [results]) {
          if (item.result?.contractAddress && item.result.status === "0x1")
            createdAddress = getAddress(item.result.contractAddress);
        }
      response.writeHead(forwarded.status, {
        "content-type": "application/json",
      });
      response.end(text);
    } catch (error) {
      // DEFENSE: the isolated upstream may close while its proxy is being disposed.
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(String(error));
    }
  });
  try {
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const tokenArtifact = await artifact("TestToken");
    const dexArtifact = await artifact("MiniDEX");
    const first = await deploy(tokenArtifact, ["Creation first", "CRT"]);
    const second = await deploy(tokenArtifact, ["Creation second", "CRT"]);
    const wrapped = await deploy(await artifact("WrappedEther"));
    const harbor = await deploy(dexArtifact, ["Creation Harbor"]);
    const summit = await deploy(dexArtifact, ["Creation Summit"]);
    const arbitrage = await deploy(await artifact("AtomicArbitrage"));
    const deployment: Deployment = {
      schemaVersion: 1,
      chainId: 31337,
      rpcUrl: proxyUrl,
      tokens: [
        {
          address: first,
          name: "Creation first",
          symbol: "CRT",
          kind: "faucet",
          decimals: 18,
        },
        {
          address: second,
          name: "Creation second",
          symbol: "CRT",
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
        { address: harbor, name: "Creation Harbor" },
        { address: summit, name: "Creation Summit" },
      ],
      arbitrage,
      bytecodes: { TestToken: tokenArtifact.bytecode },
    };
    const client = new ExchangeClient(deployment);
    evidence.phase = "verify deployment";
    await client.verifyDeployment();
    wallet = new WalletController(client, { storage: null });
    evidence.phase = "connect wallet";
    await wallet.start();
    const actor = accounts[1];
    wallet.dispatch({ kind: "select-local", address: actor });
    await until(
      () => wallet!.session(),
      (s) => !!s && same(s.address, actor),
      "creation wallet",
    );
    const perform = (
      label: string,
      action: Parameters<WalletController["perform"]>[0]["perform"],
    ) => {
      const session = wallet!.session();
      assert(session);
      return wallet!.perform({ label, session, perform: action });
    };
    const nonce = () => read.getTransactionCount({ address: actor });
    const balance = (token: string) =>
      read.readContract({
        address: getAddress(token),
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [actor],
      });

    const ids = new Set(
      wallet.kernel.getSnapshot().journal.map((row) => row.id),
    );
    let creation!: TokenCreationConfirmation;
    blockCreatedMetadata = true;
    const before = await nonce();
    evidence.phase = "create token";
    await perform(
      "Create without waiting for token metadata",
      async (writer) => {
        creation = await writer.createToken("Same-symbol created asset", "CRT");
      },
    );
    assert.equal(creation.kind, "token");
    assert.equal(creation.receipt.status, "success");
    assert(same(creation.receipt.from, actor));
    assert.equal(creation.receipt.to, null);
    assert(creation.receipt.contractAddress);
    assert(same(creation.address, creation.receipt.contractAddress));
    assert.equal(creation.name, "Same-symbol created asset");
    assert.equal(creation.symbol, "CRT");
    assert.equal(blockedMetadataReads, 0);
    assert.equal(await nonce(), before + 1);
    const row = wallet.kernel
      .getSnapshot()
      .journal.find((row) => !ids.has(row.id));
    assert(row);
    assert.equal(row.state, "confirmed");
    const afterCreation = await nonce();
    evidence.phase = "failed metadata read";
    await assert.rejects(client.importToken(creation.address));
    assert(blockedMetadataReads > 0);
    assert.equal(
      wallet.kernel.getSnapshot().journal.find((r) => r.id === row.id)!.state,
      "confirmed",
    );
    blockCreatedMetadata = false;
    const imported = await client.importToken(creation.address);
    assert(same(imported.address, creation.address));
    assert.equal(imported.name, creation.name);
    assert.equal(imported.symbol, creation.symbol);
    assert.equal(imported.decimals, 18);
    assert.equal(imported.kind, "faucet");
    assert.equal(
      await read.readContract({
        address: getAddress(imported.address),
        abi: erc20Abi,
        functionName: "totalSupply",
      }),
      0n,
    );
    assert.equal(await balance(imported.address), 0n);
    assert.equal(await nonce(), afterCreation);
    evidence.creation = {
      confirmation: creation,
      metadataFailures: blockedMetadataReads,
      imported,
      history: row,
    };
    scenarios.push(
      "Confirmed deployment survives metadata failure; same-address retry reads without another creation",
    );

    const confirmations: PoolCreationConfirmation[] = [];
    for (const exchange of deployment.exchanges) {
      let result!: PoolCreationConfirmation;
      const historyIds: Set<string> = new Set(
        wallet.kernel.getSnapshot().journal.map((entry) => entry.id),
      );
      await perform("Create identified empty pool", async (writer) => {
        result = await writer.createPool(
          exchange.address,
          creation.address,
          first,
        );
      });
      assert.equal(result.kind, "pool");
      assert.equal(result.receipt.status, "success");
      assert(same(result.receipt.from, actor));
      assert(result.receipt.to && same(result.receipt.to, exchange.address));
      assert(same(result.exchange.address, exchange.address));
      assert.equal(result.exchange.name, exchange.name);
      const events = parseEventLogs({
        abi: dexArtifact.abi,
        logs: result.receipt.logs,
        eventName: "PoolCreated",
        strict: true,
      }).filter((log) => same(log.address, exchange.address));
      assert.equal(events.length, 1);
      const args = events[0].args as {
        poolId: bigint;
        token0: string;
        token1: string;
      };
      assert.equal(result.poolId, args.poolId);
      assert(
        same(result.token0, args.token0) && same(result.token1, args.token1),
      );
      assert.deepEqual(
        [result.token0.toLowerCase(), result.token1.toLowerCase()].sort(),
        [creation.address.toLowerCase(), first.toLowerCase()].sort(),
      );
      confirmations.push(result);
      const afterPool = await nonce();
      unavailablePool = exchange.address;
      await assert.rejects(
        client.snapshot(actor, [...deployment.tokens, imported]),
      );
      assert.equal(result.receipt.status, "success");
      assert.equal(
        wallet.kernel
          .getSnapshot()
          .journal.find((entry) => !historyIds.has(entry.id))?.state,
        "confirmed",
      );
      assert.equal(await nonce(), afterPool);
      unavailablePool = undefined;
    }
    assert.equal(confirmations[0].poolId, confirmations[1].poolId);
    assert(
      !same(
        confirmations[0].exchange.address,
        confirmations[1].exchange.address,
      ),
    );
    const tokens = [...deployment.tokens, imported];
    const empty = await client.snapshot(actor, tokens);
    for (const result of confirmations) {
      const pool = empty.pools.find(
        (p) =>
          same(p.exchange.address, result.exchange.address) &&
          p.id === result.poolId,
      );
      assert(pool);
      assert(
        same(pool.token0, result.token0) && same(pool.token1, result.token1),
      );
      assert.equal(pool.reserve0, 0n);
      assert.equal(pool.reserve1, 0n);
      assert.equal(pool.totalShares, 0n);
    }
    await perform("Claim created asset", (writer) => writer.faucet(imported));
    await perform("Claim paired asset", (writer) =>
      writer.faucet(deployment.tokens[0]),
    );
    const target = empty.pools.find(
      (p) =>
        same(p.exchange.address, harbor) && p.id === confirmations[0].poolId,
    )!;
    let deposit!: LiquidityConfirmation;
    await perform("Fund exactly the confirmed pool", async (writer) => {
      deposit = await writer.addLiquidity(
        target,
        parseEther("10"),
        parseEther("10"),
        50n,
      );
    });
    assert.equal(deposit.kind, "deposit");
    assert(same(deposit.pool.exchange.address, harbor));
    const funded = await client.snapshot(actor, tokens);
    assert(
      funded.pools.find(
        (p) => same(p.exchange.address, harbor) && p.id === target.id,
      )!.totalShares > 0n,
    );
    assert.equal(
      funded.pools.find(
        (p) => same(p.exchange.address, summit) && p.id === target.id,
      )!.totalShares,
      0n,
    );
    evidence.pools = { confirmations, deposit, snapshotBlock: funded.block };
    scenarios.push(
      "Same-ID cross-exchange receipts survive later pool read failure and identify the first liquidity target",
    );

    let invalid: TokenCreationConfirmation | undefined;
    const beforeInvalid = await nonce();
    await assert.rejects(
      perform("Invalid token cannot confirm", async (writer) => {
        invalid = await writer.createToken("", "BAD");
      }),
    );
    assert.equal(invalid, undefined);
    assert.equal(await nonce(), beforeInvalid);
    await rpc("evm_setAutomine", [false]);
    miningPaused = true;
    let raced: PoolCreationConfirmation | undefined;
    let settled: { ok: boolean; error?: string } | undefined;
    const operation = perform("Racing pool creation", async (writer) => {
      raced = await writer.createPool(harbor, creation.address, wrapped);
    }).then(
      () => {
        settled = { ok: true };
      },
      (error) => {
        settled = { ok: false, error: String(error) };
      },
    );
    const pending = await until(
      async () =>
        (await rpc("eth_pendingTransactions")) as {
          hash: Address;
          from: string;
          to: string;
          gasPrice: string;
        }[],
      (rows) => rows.some((t) => same(t.from, actor) && same(t.to, harbor)),
      "pending pool creation",
    );
    const attempted = pending.find(
      (t) => same(t.from, actor) && same(t.to, harbor),
    )!;
    const competing = await admin.writeContract({
      address: harbor,
      abi: dexArtifact.abi,
      functionName: "createPool",
      args: [creation.address, wrapped],
      gas: 500_000n,
      gasPrice: BigInt(attempted.gasPrice) * 2n,
    });
    await rpc("evm_mine");
    const outcome = await until(
      () => settled,
      (result) => !!result,
      "raced creation receipt",
    );
    await operation;
    await rpc("evm_setAutomine", [true]);
    miningPaused = false;
    assert(outcome);
    assert.equal(outcome.ok, false);
    assert.equal(raced, undefined);
    const reverted = await read.getTransactionReceipt({ hash: attempted.hash });
    const winner = await read.getTransactionReceipt({ hash: competing });
    assert.equal(winner.status, "success");
    assert.equal(reverted.status, "reverted");
    evidence.rejected = {
      invalidNonceUnchanged: true,
      outcome,
      reverted,
      competing: winner,
    };
    scenarios.push(
      "Rejected validation and actual raced transaction revert return no successful creation result",
    );

    assert.deepEqual(await fingerprints(), sources);
    const result = {
      status: "passed",
      kernelSha256: sources[sourceFiles[0]],
      sourceFingerprints: sources,
      scenarios,
      ...evidence,
    };
    await writeFile(resolve(directory, "result.json"), json(result) + "\n");
    console.log(
      json({
        status: result.status,
        scenarios: scenarios.length,
        result: resolve(directory, "result.json"),
      }),
    );
  } catch (error) {
    await writeFile(
      resolve(directory, "result.json"),
      json({
        status: "failed",
        error: String(error),
        kernelSha256: sources[sourceFiles[0]],
        sourceFingerprints: sources,
        scenarios,
        ...evidence,
      }) + "\n",
    );
    throw error;
  } finally {
    // DEFENSE: a failed race assertion can leave a real transaction queued in this isolated node.
    if (miningPaused) {
      await rpc("evm_setAutomine", [true]);
      await rpc("evm_mine");
    }
    wallet?.stop();
    await new Promise<void>((done) => proxy.close(() => done()));
    await env.close();
  }
}
await main();
