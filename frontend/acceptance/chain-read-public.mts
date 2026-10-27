import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  MutationObserver,
  onlineManager,
  QueryObserver,
} from "@tanstack/react-query";
import { erc20Abi, getAddress, type Address } from "viem";
import { ExchangeClient } from "../src/chain/client";
import { createChainQueryClient } from "../src/chain/queryClient";
import type { ChainSnapshot, Deployment } from "../src/chain/types";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, root, until } from "./support/chain.mts";

const serialize = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
const sourceFiles = [
  "frontend/src/generated/dex_logic.js",
  "frontend/src/chain/queryClient.ts",
  "frontend/src/chain/client.ts",
  "frontend/src/chain/assets.ts",
  "frontend/src/wallet/session.ts",
  "frontend/acceptance/chain-read-public.mts",
  "frontend/acceptance/support/chain.mts",
];
const fingerprints = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(resolve(root, path)))
          .digest("hex"),
      ]),
    ),
  );
const sourceFingerprints = await fingerprints();
const kernelSha256 = sourceFingerprints[sourceFiles[0]];
if (process.env.DEX_EXPECTED_KERNEL_SHA256) {
  assert.equal(kernelSha256, process.env.DEX_EXPECTED_KERNEL_SHA256);
}
const environment = await isolatedChain("chain-read-public");
const { directory, rpcUrl, accounts, read, rpc, artifact, deploy } =
  environment;
const scenarios: { scenario: string; outcome: string }[] = [];
const evidence: Record<string, unknown> = {
  status: "running",
  kernelSha256,
  sourceFingerprints,
  scenarios,
};
const scenario = async (name: string, run: () => Promise<void>) => {
  await run();
  scenarios.push({ scenario: name, outcome: "passed" });
};
const methods: string[] = [];
let unavailable = false;
const proxy = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const decoded = JSON.parse(body);
    for (const item of Array.isArray(decoded) ? decoded : [decoded]) {
      methods.push(item.method);
    }
    if (unavailable) {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("The isolated RPC gateway is unavailable.");
      return;
    }
    const forwarded = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    response.writeHead(forwarded.status, {
      "content-type": "application/json",
    });
    response.end(await forwarded.text());
  } catch (error) {
    response.writeHead(502, { "content-type": "text/plain" });
    response.end(String(error));
  }
});
const queryClient = createChainQueryClient();
queryClient.mount();
let wallet: WalletController | undefined;
let observer: QueryObserver<ChainSnapshot> | undefined;
let unsubscribe: (() => void) | undefined;
const previousOnline = onlineManager.isOnline();
const nonce = async (address: Address) =>
  BigInt((await rpc("eth_getTransactionCount", [address, "latest"])) as string);
const blockNumber = async () =>
  Number(BigInt((await rpc("eth_blockNumber")) as string));

try {
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const tokenArtifact = await artifact("TestToken");
  const tokenA = await deploy(tokenArtifact, ["Read A", "RDA"]);
  const tokenB = await deploy(tokenArtifact, ["Read B", "RDB"]);
  const weth = await deploy(await artifact("WrappedEther"));
  const exchange = await deploy(await artifact("MiniDEX"), ["Read DEX"]);
  const arbitrage = await deploy(await artifact("AtomicArbitrage"));
  const deployment: Deployment = {
    schemaVersion: 1,
    chainId: 31337,
    rpcUrl: proxyUrl,
    tokens: [
      {
        address: tokenA,
        name: "Read A",
        symbol: "RDA",
        decimals: 18,
        kind: "faucet",
      },
      {
        address: tokenB,
        name: "Read B",
        symbol: "RDB",
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
    exchanges: [{ address: exchange, name: "Read DEX" }],
    arbitrage,
    bytecodes: { TestToken: tokenArtifact.bytecode },
  };
  const client = new ExchangeClient(deployment);
  await client.verifyDeployment();
  const owner = accounts[1];
  const token = deployment.tokens[0];
  const connect = async () => {
    wallet = new WalletController(client, { storage: null });
    await wallet.start();
    wallet.dispatch({ kind: "select-local", address: owner });
    await until(
      () => wallet?.session(),
      (session) => !!session && getAddress(session.address) === owner,
      "the read-fixture wallet is selected",
    );
    return wallet;
  };
  const prepared = await connect();
  const preparedSession = prepared.session();
  assert(preparedSession);
  await prepared.perform({
    label: "Prepare a real balance for read recovery",
    session: preparedSession,
    perform: (writer) => writer.faucet(token),
  });
  await prepared.perform({
    label: "Prepare a real pool for read recovery",
    session: preparedSession,
    perform: (writer) => writer.createPool(exchange, tokenA, tokenB),
  });
  prepared.stop();
  const initialBalance = await read.readContract({
    address: tokenA,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
  assert(initialBalance > 0n);
  const nonceBeforeReads = await nonce(owner);
  const readsStart = methods.length;
  const observations: unknown[] = [];
  unavailable = true;
  observer = new QueryObserver<ChainSnapshot>(queryClient, {
    queryKey: ["chain", "public-read-recovery", owner],
    queryFn: () => client.snapshot(owner, deployment.tokens),
  });
  unsubscribe = observer.subscribe((result) => {
    observations.push({
      status: result.status,
      fetchStatus: result.fetchStatus,
      block: result.data?.block,
      hasData: result.data !== undefined,
      error: result.error?.message,
    });
  });
  const active = observer;

  await scenario(
    "Initial RPC failure is observable and manual retry recovers",
    async () => {
      const failed = await until(
        () => active.getCurrentResult(),
        (result) => result.isError && !result.isFetching,
        "initial failure settles instead of loading forever",
      );
      assert.equal(failed.data, undefined);
      assert(failed.error);
      assert.equal(failed.isPending, false);
      unavailable = false;
      const recovered = await active.refetch({ throwOnError: true });
      assert(recovered.isSuccess && recovered.data);
      assert.equal(recovered.data.block, await blockNumber());
      assert.equal(recovered.data.pools.length, 1);
      assert.equal(
        getAddress(recovered.data.pools[0].exchange.address),
        exchange,
      );
      assert.equal(recovered.data.balances[token.address], initialBalance);
      evidence.initialRecovery = {
        error: failed.error.message,
        block: recovered.data.block,
        balance: recovered.data.balances[token.address],
        pool: recovered.data.pools[0],
      };
    },
  );

  await scenario(
    "A failed refresh preserves its successful data until explicit recovery",
    async () => {
      const previous = active.getCurrentResult().data;
      assert(previous);
      unavailable = true;
      const failed = await active.refetch();
      assert(failed.isError && failed.error);
      assert.equal(failed.isFetching, false);
      assert.equal(failed.data, previous);
      assert.equal(failed.data.block, previous.block);
      assert.equal(failed.data.balances[token.address], initialBalance);
      unavailable = false;
      await rpc("evm_mine");
      const recovered = await active.refetch({ throwOnError: true });
      assert(recovered.isSuccess && recovered.data);
      assert.equal(recovered.error, null);
      assert(recovered.data.block > previous.block);
      assert.equal(recovered.data.block, await blockNumber());
      assert.equal(recovered.data.balances[token.address], initialBalance);
      assert.equal(await nonce(owner), nonceBeforeReads);
      assert(
        !methods
          .slice(readsStart)
          .some((method) =>
            ["eth_sendTransaction", "eth_sendRawTransaction"].includes(method),
          ),
        "read recovery must not send account transactions",
      );
      evidence.refreshRecovery = {
        retainedBlock: previous.block,
        recoveredBlock: recovered.data.block,
        nonceBefore: nonceBeforeReads,
        nonceAfter: await nonce(owner),
        methods: [...new Set(methods.slice(readsStart))],
      };
    },
  );

  await scenario(
    "An offline browser hint does not pause local reads or a real wallet mutation",
    async () => {
      const connected = await connect();
      const session = connected.session();
      assert(session);
      const previous = active.getCurrentResult().data;
      assert(previous);
      await rpc("evm_mine");
      onlineManager.setOnline(false);
      const pendingRead = active.refetch();
      const newRead = await until(
        () => active.getCurrentResult(),
        (result) =>
          result.isError ||
          (result.isSuccess &&
            !!result.data &&
            result.data.block > previous.block),
        "localhost read finishes while the browser still reports offline",
      );
      await pendingRead;
      assert(newRead.isSuccess);
      assert.equal(onlineManager.isOnline(), false);
      assert.equal(newRead.fetchStatus, "idle");
      assert(newRead.data);
      const startBlock = await blockNumber();
      const beforeNonce = await nonce(owner);
      const mutation = new MutationObserver(queryClient, {
        mutationFn: () =>
          connected.perform({
            label: "Claim through the production query client while offline",
            session,
            perform: (writer) => writer.faucet(token),
          }),
      });
      let mutationError: unknown;
      const completed = mutation.mutate().catch((error: unknown) => {
        mutationError = error;
      });
      await until(
        () => mutation.getCurrentResult(),
        (result) => result.isSuccess || result.isError,
        "the real mutation settles without an online event",
      );
      await completed;
      assert.equal(mutationError, undefined);
      assert.equal(onlineManager.isOnline(), false);
      assert.equal(mutation.getCurrentResult().isPaused, false);
      assert.equal(await nonce(owner), beforeNonce + 1n);
      const afterBalance = await read.readContract({
        address: tokenA,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      });
      assert(afterBalance > initialBalance);
      const receipts = [];
      for (
        let block = startBlock + 1;
        block <= (await blockNumber());
        block++
      ) {
        const mined = await read.getBlock({
          blockNumber: BigInt(block),
          includeTransactions: true,
        });
        for (const transaction of mined.transactions) {
          if (getAddress(transaction.from) === owner) {
            receipts.push(
              await read.getTransactionReceipt({ hash: transaction.hash }),
            );
          }
        }
      }
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].status, "success");
      assert.equal(getAddress(receipts[0].to!), tokenA);
      evidence.offlineHint = {
        onlineHint: onlineManager.isOnline(),
        block: newRead.data.block,
        nonceBefore: beforeNonce,
        nonceAfter: await nonce(owner),
        balanceBefore: initialBalance,
        balanceAfter: afterBalance,
        receipt: receipts[0],
      };
    },
  );
  evidence.observations = observations;
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  unavailable = false;
  unsubscribe?.();
  observer?.destroy();
  queryClient.unmount();
  onlineManager.setOnline(previousOnline);
  queryClient.clear();
  wallet?.stop();
  const after = await fingerprints();
  evidence.sourceDrift = sourceFiles.filter(
    (path) => sourceFingerprints[path] !== after[path],
  );
  if ((evidence.sourceDrift as string[]).length) {
    evidence.status = "failed";
    process.exitCode = 1;
  }
  await writeFile(resolve(directory, "result.json"), serialize(evidence));
  await new Promise<void>((done, reject) => {
    proxy.close((error) => (error ? reject(error) : done()));
    proxy.closeAllConnections();
  });
  await environment.close();
  console.log(
    serialize({
      status: evidence.status,
      scenarios,
      error: evidence.error,
      result: resolve(directory, "result.json"),
      kernelSha256,
    }),
  );
}
