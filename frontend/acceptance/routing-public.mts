import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  decodeFunctionData,
  getAddress,
  parseAbiItem,
  parseEventLogs,
} from "viem";
import { isolatedChain, root, until } from "./support/chain.mts";
import { ExchangeClient } from "../src/chain/client";
import { WalletController } from "../src/wallet/session";
import {
  createRoutedSwapController,
  type RoutedSwapPlan,
} from "../src/logic/routing";
import type {
  ChainSnapshot,
  Deployment,
  Pool,
  Token,
  SwapResult,
} from "../src/chain/types";

const swapEvent = parseAbiItem(
  "event Swap(uint256 indexed poolId, address indexed sender, address indexed tokenIn, uint256 amountIn, uint256 amountOut, address recipient)"
);

const same = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();
const poolIdentity = (pool: Pool) =>
  `${pool.exchange.address.toLowerCase()}:${pool.id}`;
const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, part) => (typeof part === "bigint" ? part.toString() : part),
    2
  );

type RpcWrite = { from: string; to: string; data: string; hash?: string };
async function recordingEndpoint(upstream: string) {
  const writes: RpcWrite[] = [];
  const state: { afterApproval: (() => Promise<void>) | null } = {
    afterApproval: null,
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const incoming = JSON.parse(Buffer.concat(chunks).toString());
    try {
      const entry =
        incoming.method === "eth_sendTransaction"
          ? ({ ...incoming.params[0] } as RpcWrite)
          : null;
      if (entry) writes.push(entry);
      const result = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(incoming),
      }).then((reply) => reply.json());
      if (entry && typeof result.result === "string")
        entry.hash = result.result;
      if (
        entry?.data.startsWith("0x095ea7b3") &&
        state.afterApproval &&
        !result.error
      ) {
        const hook = state.afterApproval;
        state.afterApproval = null;
        await hook();
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      // DEFENSE: a deliberate RPC/wallet hook failure must terminate its pending request.
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: incoming.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        })
      );
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  return {
    writes,
    state,
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done()))
      );
    },
  };
}

async function main() {
  const environment = await isolatedChain("routing-public");
  const proxy = await recordingEndpoint(environment.rpcUrl);
  const { directory, accounts, read, admin, deploy, artifact } = environment;
  const programHash = async () =>
    createHash("sha256")
      .update(
        await readFile(resolve(root, "frontend/src/generated/dex_logic.js"))
      )
      .digest("hex");
  const programSha256 = await programHash();
  const scenarios: { scenario: string; outcome: string }[] = [];
  const evidence: Record<string, unknown> = {
    status: "running",
    programSha256,
    sourceSha256: Object.fromEntries(
      await Promise.all(
        [
          "chain/client.ts",
          "chain/types.ts",
          "logic/routing.ts",
          "wallet/session.ts",
        ].map(async (path) => [
          path,
          createHash("sha256")
            .update(await readFile(resolve(root, "frontend/src", path)))
            .digest("hex"),
        ])
      )
    ),
    scenarios,
  };
  let wallet: WalletController | undefined;
  const scenario = async (name: string, action: () => void | Promise<void>) => {
    evidence.currentScenario = name;
    await action();
    assert.equal(
      await programHash(),
      programSha256,
      "the extracted program changed during acceptance"
    );
    scenarios.push({ scenario: name, outcome: "passed" });
    delete evidence.currentScenario;
  };
  try {
    const base = await artifact("TestToken");
    const dex = await artifact("MiniDEX");
    const baseA = await deploy(base, ["Routing Base A", "RBA"]);
    const baseB = await deploy(base, ["Routing Base B", "RBB"]);
    const weth = await deploy(await artifact("WrappedEther"));
    const first = await deploy(dex, ["Thin DEX"]);
    const second = await deploy(dex, ["Deep DEX"]);
    const third = await deploy(dex, ["Third DEX"]);
    const foreign = await deploy(dex, ["Unregistered DEX"]);
    const arbitrage = await deploy(await artifact("AtomicArbitrage"));
    const fixture = (
      await environment.fixtures("contracts/test/fixtures/PrecisionToken.sol")
    ).PrecisionToken;
    const sixAddress = await deploy(
      { abi: fixture.abi, bytecode: `0x${fixture.evm.bytecode.object}` },
      ["Routing Six", "RSIX", 6]
    );
    const deployment: Deployment = {
      schemaVersion: 1,
      chainId: 31337,
      rpcUrl: proxy.url,
      tokens: [
        {
          address: baseA,
          name: "Routing Base A",
          symbol: "RBA",
          kind: "faucet",
          decimals: 18,
        },
        {
          address: baseB,
          name: "Routing Base B",
          symbol: "RBB",
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
        { address: first, name: "Thin DEX" },
        { address: second, name: "Deep DEX" },
        { address: third, name: "Third DEX" },
      ],
      arbitrage,
      bytecodes: { TestToken: base.bytecode },
    };
    const client = new ExchangeClient(deployment);
    await client.verifyDeployment();
    wallet = new WalletController(client, { storage: null });
    await wallet.start();
    wallet.dispatch({ kind: "select-local", address: accounts[1] });
    await until(
      () => wallet!.session(),
      (value) => !!value && same(value.address, accounts[1]),
      "routing wallet"
    );
    const controller = wallet;
    const owner = accounts[1];
    const six = await client.importToken(sixAddress);
    const eighteen = client.deployment.tokens.find((token) =>
      same(token.address, baseA)
    )!;
    const tokens: Token[] = [...client.deployment.tokens, six];
    const perform = (
      label: string,
      action: Parameters<WalletController["perform"]>[0]["perform"]
    ) => {
      const session = controller.session();
      assert(session);
      return controller.perform({ label, session, perform: action });
    };
    const adminWrite = async (
      address: string,
      abi: typeof base.abi,
      functionName: string,
      args: readonly unknown[] = []
    ) => {
      const hash = await admin.writeContract({
        address: getAddress(address),
        abi,
        functionName,
        args,
      });
      const receipt = await read.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      return receipt;
    };
    await adminWrite(six.address, fixture.abi, "mint", [
      owner,
      1_000_000_000_000n,
    ]);
    await adminWrite(six.address, fixture.abi, "mint", [
      accounts[0],
      1_000_000_000_000n,
    ]);
    for (let count = 0; count < 3; count++)
      await perform("Prepare routing base", (writer) =>
        writer.faucet(eighteen)
      );
    await perform("Prepare alternate pair", (writer) =>
      writer.faucet(client.deployment.tokens[1])
    );
    await adminWrite(baseA, base.abi, "faucet");
    const findPair = (
      snapshot: ChainSnapshot,
      exchange: string,
      left = six.address,
      right = eighteen.address
    ) => {
      const pool = snapshot.pools.find(
        (pool) =>
          same(pool.exchange.address, exchange) &&
          [pool.token0, pool.token1].some((token) => same(token, left)) &&
          [pool.token0, pool.token1].some((token) => same(token, right))
      );
      assert(pool);
      return pool;
    };
    const snapshot = () => client.snapshot(owner, tokens);
    for (const exchange of [first, second, third])
      await perform("Create route pool", (writer) =>
        writer.createPool(exchange, six.address, eighteen.address)
      );
    await perform("Create alternate pool", (writer) =>
      writer.createPool(third, baseA, baseB)
    );
    const deposit = async (
      exchange: string,
      inputRaw: bigint,
      outputRaw: bigint,
      left = six.address,
      right = eighteen.address
    ) => {
      const pool = findPair(await snapshot(), exchange, left, right);
      const desired = same(pool.token0, left)
        ? ([inputRaw, outputRaw] as const)
        : ([outputRaw, inputRaw] as const);
      await perform("Seed route pool", (writer) =>
        writer.addLiquidity(pool, ...desired, 50n)
      );
    };
    await deposit(first, 100_000_000n, 110n * 10n ** 18n);
    await deposit(second, 10_000_000_000n, 10_000n * 10n ** 18n);
    await deposit(third, 100n * 10n ** 18n, 100n * 10n ** 18n, baseA, baseB);
    const context = (
      data: ChainSnapshot,
      pool = findPair(data, first),
      pools: readonly Pool[] = data.pools
    ) => ({
      tokens,
      pool,
      pools,
      exchanges: client.deployment.exchanges,
      balances: data.balances,
      connected: true,
      pending: false,
      block: data.block,
    });
    const draftFor = (data: ChainSnapshot, amount: string) => {
      const ctx = context(data);
      const draft = createRoutedSwapController(ctx.pool.token0);
      draft.dispatch({ kind: "pay", value: six.address }, ctx);
      draft.dispatch({ kind: "amount", value: amount }, ctx);
      return { draft, ctx };
    };
    const swaps = (writes: RpcWrite[]) =>
      writes
        .filter((write) =>
          client.deployment.exchanges.some((exchange) =>
            same(exchange.address, write.to)
          )
        )
        .map((write) => ({
          ...write,
          decoded: decodeFunctionData({
            abi: dex.abi,
            data: write.data as `0x${string}`,
          }),
        }))
        .filter((write) => write.decoded.functionName === "swap");
    const balances = async () => ({
      input: await client.token(six.address).read.balanceOf([owner]),
      output: await client.token(eighteen.address).read.balanceOf([owner]),
    });

    await scenario(
      "Pairs remain selectable without an amount, and quotes do not require a wallet",
      async () => {
        const data = await snapshot();
        const ctx = context(data);
        const draft = createRoutedSwapController(ctx.pool.token0);
        const empty = draft.view(ctx);
        assert.equal(empty.pairs.length, 2);
        assert.equal(
          empty.pairs.filter((pair) =>
            [pair.token0, pair.token1].some((token) => same(token, six.address))
          ).length,
          1
        );
        assert(
          empty.pairs.some((pair) =>
            [pair.token0, pair.token1].every(
              (token) => same(token, baseA) || same(token, baseB)
            )
          )
        );
        assert.equal(empty.output, undefined);
        const anonymous = { ...ctx, connected: false, balances: undefined };
        draft.dispatch({ kind: "pay", value: six.address }, anonymous);
        draft.dispatch({ kind: "amount", value: "1" }, anonymous);
        const view = draft.view(anonymous);
        assert(view.route);
        assert(view.output && view.output > 0n);
        const before = proxy.writes.length;
        assert.equal(
          draft.dispatch({ kind: "submit" }, anonymous).effect?.kind,
          "wallet"
        );
        assert.equal(proxy.writes.length, before);
        const poor = await client.snapshot(accounts[2], tokens);
        const poorContext = { ...ctx, balances: poor.balances };
        assert.equal(draft.view(poorContext).output, view.output);
        assert.equal(draft.view(poorContext).canSubmit, false);
        assert.notEqual(
          draft.dispatch({ kind: "submit" }, poorContext).effect?.kind,
          "swap"
        );
        evidence.directory = { pairs: empty.pairs, anonymous: view };
      }
    );

    await scenario(
      "Small and large inputs select different pools by contract output rather than spot price",
      async () => {
        const data = await snapshot();
        const thin = findPair(data, first);
        const deep = findPair(data, second);
        const quotes = {
          smallThin: await client.quote(
            thin,
            six.address,
            1_000_000n,
            data.block
          ),
          smallDeep: await client.quote(
            deep,
            six.address,
            1_000_000n,
            data.block
          ),
          largeThin: await client.quote(
            thin,
            six.address,
            50_000_000n,
            data.block
          ),
          largeDeep: await client.quote(
            deep,
            six.address,
            50_000_000n,
            data.block
          ),
        };
        assert(quotes.smallThin > quotes.smallDeep);
        assert(quotes.largeDeep > quotes.largeThin);
        const { draft, ctx } = draftFor(data, "1");
        assert.equal(poolIdentity(draft.view(ctx).route!), poolIdentity(thin));
        assert.equal(draft.view(ctx).output, quotes.smallThin);
        draft.dispatch({ kind: "amount", value: "50" }, ctx);
        const view = draft.view(ctx);
        assert.equal(view.mode, "auto");
        assert.equal(poolIdentity(view.route!), poolIdentity(deep));
        assert.equal(view.output, quotes.largeDeep);
        evidence.amountSensitiveQuotes = quotes;
      }
    );

    const verifyExecution = async (
      result: SwapResult,
      plan: RoutedSwapPlan,
      before: { input: bigint; output: bigint },
      after: { input: bigint; output: bigint }
    ) => {
      assert.equal(result.receipt.status, "success");
      assert.equal(poolIdentity(result.pool), poolIdentity(plan.pool));
      assert(same(result.tokenIn, plan.inputToken));
      assert(same(result.tokenOut, plan.outputToken));
      assert.equal(result.quoted, plan.quoted);
      assert.equal(result.minimum, plan.minimum);
      const receipt = await read.getTransactionReceipt({
        hash: result.receipt.transactionHash,
      });
      assert.equal(receipt.status, "success");
      assert.equal(result.receipt.blockHash, receipt.blockHash);
      assert.equal(result.receipt.blockNumber, receipt.blockNumber);
      assert(same(receipt.from, owner));
      assert(receipt.to && same(receipt.to, plan.pool.exchange.address));
      const events = parseEventLogs({
        abi: [swapEvent],
        eventName: "Swap",
        logs: receipt.logs,
      }).filter((event) => same(event.address, plan.pool.exchange.address));
      assert.equal(events.length, 1);
      const event = events[0].args;
      assert.equal(event.poolId, plan.pool.id);
      assert(same(String(event.sender), owner));
      assert(same(String(event.recipient), owner));
      assert(same(String(event.tokenIn), result.tokenIn));
      assert.equal(result.amountIn, event.amountIn);
      assert.equal(result.amountOut, event.amountOut);
      assert.equal(result.amountIn, before.input - after.input);
      assert.equal(result.amountOut, after.output - before.output);
      assert.equal(result.amountIn, plan.input);
      assert(result.amountOut >= plan.minimum);
      return { result, event, before, after };
    };

    await scenario(
      "Automatic execution spends the precise mixed-decimal input in the selected pool",
      async () => {
        const before = await snapshot();
        const { draft, ctx } = draftFor(before, "50");
        const view = draft.view(ctx);
        const effect = draft.dispatch({ kind: "submit" }, ctx).effect;
        assert(effect?.kind === "swap");
        assert.equal(effect.input, 50_000_000n);
        assert.equal(effect.minimum, view.minimum);
        assert.equal(effect.block, before.block);
        assert.equal(
          poolIdentity(effect.pool),
          poolIdentity(findPair(before, second))
        );
        const funds = await balances();
        const start = proxy.writes.length;
        let execution: SwapResult | undefined;
        await perform("Automatic routed swap", async (writer) => {
          execution = await writer.routedSwap(effect);
        });
        const after = await snapshot();
        const final = await balances();
        assert(execution);
        assert(same(execution.tokenIn, six.address));
        assert(same(execution.tokenOut, eighteen.address));
        const actualExecution = await verifyExecution(
          execution,
          effect,
          funds,
          final
        );
        const sent = swaps(proxy.writes.slice(start));
        assert.equal(sent.length, 1);
        assert.equal(execution.receipt.transactionHash, sent[0].hash);
        assert(same(sent[0].to, effect.pool.exchange.address));
        assert.equal(sent[0].decoded.args?.[0], effect.pool.id);
        assert(same(String(sent[0].decoded.args?.[1]), six.address));
        assert.equal(sent[0].decoded.args?.[2], effect.input);
        assert.equal(sent[0].decoded.args?.[3], view.minimum);
        assert.equal(funds.input - final.input, effect.input);
        assert.equal(final.output - funds.output, effect.quoted);
        const thinBefore = findPair(before, first);
        const thinAfter = findPair(after, first);
        assert.equal(thinAfter.reserve0, thinBefore.reserve0);
        assert.equal(thinAfter.reserve1, thinBefore.reserve1);
        evidence.automaticExecution = {
          effect,
          minimum: view.minimum,
          sent,
          before: funds,
          after: final,
          actualExecution,
        };
      }
    );

    await scenario(
      "A captured route and its pending display do not change while approval changes another market",
      async () => {
        const before = await snapshot();
        const { draft, ctx } = draftFor(before, "1");
        const view = draft.view(ctx);
        const effect = draft.dispatch({ kind: "submit" }, ctx).effect;
        assert(effect?.kind === "swap");
        assert(same(effect.pool.exchange.address, first));
        assert.equal(effect.minimum, view.minimum);
        const captured = json(effect);
        const start = proxy.writes.length;
        let changed: unknown;
        proxy.state.afterApproval = async () => {
          const deep = findPair(await snapshot(), second);
          await adminWrite(baseA, base.abi, "approve", [
            second,
            5_000n * 10n ** 18n,
          ]);
          await adminWrite(second, dex.abi, "swap", [
            deep.id,
            baseA,
            5_000n * 10n ** 18n,
            0n,
            accounts[0],
            (await client.transactionTimestamp()) + 1200n,
          ]);
          const updated = await snapshot();
          const thinQuote = await client.quote(
            findPair(updated, first),
            six.address,
            effect.input,
            updated.block
          );
          const deepQuote = await client.quote(
            findPair(updated, second),
            six.address,
            effect.input,
            updated.block
          );
          assert(deepQuote > thinQuote);
          const operationPending = controller.kernel.getSnapshot().pending;
          assert(operationPending);
          const pending = draft.view({
            ...context(updated),
            pending: operationPending,
          });
          assert.equal(poolIdentity(pending.route!), poolIdentity(effect.pool));
          assert.equal(pending.output, effect.quoted);
          assert.equal(json(effect), captured);
          changed = { thinQuote, deepQuote, pending };
        };
        await perform("Captured routed swap", async (writer) => {
          await writer.routedSwap(effect);
        });
        assert(
          changed,
          "the approval boundary must actually have been exercised"
        );
        const sent = swaps(proxy.writes.slice(start));
        assert.equal(sent.length, 1);
        assert(same(sent[0].to, first));
        assert.equal(sent[0].decoded.args?.[3], view.minimum);
        assert.equal(json(effect), captured);
        const fresh = await snapshot();
        assert(
          same(draft.view(context(fresh)).route!.exchange.address, second)
        );
        evidence.capturedRoute = { effect, changed, sent };
      }
    );

    await scenario(
      "Manual selection is honored even when another pool offers more output",
      async () => {
        const before = await snapshot();
        const { draft, ctx } = draftFor(before, "1");
        assert(same(draft.view(ctx).route!.exchange.address, second));
        const manual = draft
          .view(ctx)
          .routes.find((route) => same(route.pool.exchange.address, first));
        assert(manual);
        draft.dispatch({ kind: "route", value: manual.key }, ctx);
        const view = draft.view(ctx);
        assert.equal(view.mode, "manual");
        assert(same(view.route!.exchange.address, first));
        assert.equal(
          view.output,
          await client.quote(
            findPair(before, first),
            six.address,
            1_000_000n,
            before.block
          )
        );
        assert(
          (await client.quote(
            findPair(before, second),
            six.address,
            1_000_000n,
            before.block
          )) > view.output!
        );
        const effect = draft.dispatch({ kind: "submit" }, ctx).effect;
        assert(effect?.kind === "swap");
        const start = proxy.writes.length;
        await perform("Explicit manual routed swap", async (writer) => {
          await writer.routedSwap(effect);
        });
        const after = await snapshot();
        const sent = swaps(proxy.writes.slice(start));
        assert.equal(sent.length, 1);
        assert(same(sent[0].to, first));
        assert.equal(
          findPair(after, second).reserve0,
          findPair(before, second).reserve0
        );
        assert.equal(
          findPair(after, second).reserve1,
          findPair(before, second).reserve1
        );
        evidence.manualExecution = { effect, sent };
      }
    );

    await scenario(
      "An 18-decimal payment reports actual output after its chosen market improves during approval",
      async () => {
        const data = await snapshot();
        const { draft, ctx } = draftFor(data, "1");
        draft.dispatch({ kind: "reverse" }, ctx);
        draft.dispatch({ kind: "amount", value: "1" }, ctx);
        const effect = draft.dispatch({ kind: "submit" }, ctx).effect;
        assert(effect?.kind === "swap");
        assert(same(effect.inputToken, eighteen.address));
        assert(same(effect.outputToken, six.address));
        assert.equal(effect.input, 10n ** 18n);
        const reverseBalances = async () => ({
          input: await client.token(eighteen.address).read.balanceOf([owner]),
          output: await client.token(six.address).read.balanceOf([owner]),
        });
        const before = await reverseBalances();
        let marketChanged = false;
        proxy.state.afterApproval = async () => {
          await adminWrite(six.address, fixture.abi, "approve", [
            effect.pool.exchange.address,
            1_000_000n,
          ]);
          await adminWrite(effect.pool.exchange.address, dex.abi, "swap", [
            effect.pool.id,
            six.address,
            1_000_000n,
            0n,
            accounts[0],
            (await client.transactionTimestamp()) + 1200n,
          ]);
          marketChanged = true;
        };
        let execution: SwapResult | undefined;
        await perform(
          "Reverse routed swap with changed actual output",
          async (writer) => {
            execution = await writer.routedSwap(effect);
          }
        );
        assert(
          marketChanged,
          "the real approval boundary must change the selected market"
        );
        assert(execution);
        const actualExecution = await verifyExecution(
          execution,
          effect,
          before,
          await reverseBalances()
        );
        assert(
          execution.amountOut > effect.quoted,
          "actual received evidence must differ from the captured draft quote"
        );
        evidence.changedActualExecution = actualExecution;
      }
    );

    await scenario(
      "Reverse and Max use the actual receiving asset and exact wallet balance",
      async () => {
        const data = await snapshot();
        const { draft, ctx } = draftFor(data, "1");
        draft.dispatch({ kind: "reverse" }, ctx);
        assert(same(draft.view(ctx).inputToken, eighteen.address));
        assert(same(draft.view(ctx).outputToken, six.address));
        draft.dispatch({ kind: "max" }, ctx);
        const view = draft.view(ctx);
        assert.equal(view.amount, data.balances[eighteen.address]);
        assert(view.route);
        assert.equal(
          view.output,
          await client.quote(
            view.route,
            eighteen.address,
            view.amount!,
            data.block
          )
        );
        evidence.reverseMax = view;
      }
    );

    await scenario(
      "Unfunded, unrelated, unregistered and unverified routes never produce a write",
      async () => {
        await adminWrite(foreign, dex.abi, "createPool", [six.address, baseA]);
        const outside = new ExchangeClient({
          ...deployment,
          rpcUrl: environment.rpcUrl,
          exchanges: [{ address: foreign, name: "Unregistered DEX" }],
        });
        await outside.verifyDeployment();
        const foreignPool = findPair(
          await outside.snapshot(owner, tokens),
          foreign
        );
        await adminWrite(six.address, fixture.abi, "approve", [
          foreign,
          100_000_000n,
        ]);
        await adminWrite(baseA, base.abi, "approve", [
          foreign,
          1_000n * 10n ** 18n,
        ]);
        const amounts = same(foreignPool.token0, six.address)
          ? [100_000_000n, 1_000n * 10n ** 18n]
          : [1_000n * 10n ** 18n, 100_000_000n];
        await adminWrite(foreign, dex.abi, "addLiquidity", [
          foreignPool.id,
          ...amounts,
          0n,
          0n,
          (await client.transactionTimestamp()) + 1200n,
        ]);
        const data = await snapshot();
        const externalData = await outside.snapshot(owner, tokens);
        assert.equal(externalData.block, data.block);
        const empty = findPair(data, third);
        const wrong = findPair(data, third, baseA, baseB);
        assert.equal(empty.reserve0, 0n);
        assert(wrong.reserve0 > 0n);
        const full = context(data);
        const manualDraft = createRoutedSwapController(full.pool.token0);
        manualDraft.dispatch({ kind: "pay", value: six.address }, full);
        manualDraft.dispatch({ kind: "amount", value: "1" }, full);
        assert(manualDraft.view(full).output);
        const unfunded = manualDraft
          .view(full)
          .routes.find((route) => same(route.pool.exchange.address, third));
        assert(unfunded);
        manualDraft.dispatch({ kind: "route", value: unfunded.key }, full);
        assert.equal(manualDraft.view(full).mode, "manual");
        assert(
          manualDraft.view(full).message || !manualDraft.view(full).funded,
          "an unfunded manual pool must expose its unavailability"
        );
        assert.equal(manualDraft.view(full).output, undefined);
        assert.notEqual(
          manualDraft.dispatch({ kind: "submit" }, full).effect?.kind,
          "swap"
        );
        const candidates = [empty, wrong, findPair(externalData, foreign)];
        const ctx = context(data, empty, candidates);
        const draft = createRoutedSwapController(empty.token0);
        draft.dispatch({ kind: "pay", value: six.address }, ctx);
        draft.dispatch({ kind: "amount", value: "1" }, ctx);
        const writes = proxy.writes.length;
        assert.equal(draft.view(ctx).output, undefined);
        assert.equal(draft.view(ctx).canSubmit, false);
        assert.notEqual(
          draft.dispatch({ kind: "submit" }, ctx).effect?.kind,
          "swap"
        );
        const unverified = {
          ...context(data),
          tokens: client.deployment.tokens,
        };
        assert.equal(draft.view(unverified).output, undefined);
        assert.equal(draft.view(unverified).canSubmit, false);
        assert.notEqual(
          draft.dispatch({ kind: "submit" }, unverified).effect?.kind,
          "swap"
        );
        assert.equal(proxy.writes.length, writes);
        evidence.unavailable = {
          view: draft.view(ctx),
          unverified: draft.view(unverified),
        };
      }
    );

    await scenario(
      "Pair changes discard a foreign manual choice and equal quotes retain snapshot order",
      async () => {
        for (const exchange of [first, second]) {
          await perform("Create tie pair", (writer) =>
            writer.createPool(exchange, baseA, baseB)
          );
          await deposit(
            exchange,
            100n * 10n ** 18n,
            100n * 10n ** 18n,
            baseA,
            baseB
          );
        }
        const data = await snapshot();
        const { draft, ctx } = draftFor(data, "1");
        const manual = draft
          .view(ctx)
          .routes.find((route) => same(route.pool.exchange.address, second));
        assert(manual);
        draft.dispatch({ kind: "route", value: manual.key }, ctx);
        assert.equal(draft.view(ctx).mode, "manual");
        const next = context(data, findPair(data, first, baseA, baseB));
        assert.equal(draft.view(next).mode, "auto");
        draft.dispatch({ kind: "pay", value: baseA }, next);
        draft.dispatch({ kind: "amount", value: "1" }, next);
        const tied = [first, second, third].map((exchange) =>
          findPair(data, exchange, baseA, baseB)
        );
        const quotes = await Promise.all(
          tied.map((pool) => client.quote(pool, baseA, 10n ** 18n, data.block))
        );
        assert(quotes.every((value) => value === quotes[0]));
        const expected = data.pools.find((pool) =>
          tied.some(
            (candidate) => poolIdentity(candidate) === poolIdentity(pool)
          )
        )!;
        for (let count = 0; count < 3; count++) {
          assert.equal(
            poolIdentity(draft.view(next).route!),
            poolIdentity(expected)
          );
          assert.equal(draft.view(next).output, quotes[0]);
        }
        evidence.tie = { quotes, selected: draft.view(next).route };
      }
    );

    await scenario(
      "Changing wallets after approval cannot continue the old routed operation",
      async () => {
        const data = await snapshot();
        const { draft, ctx } = draftFor(data, "1");
        const effect = draft.dispatch({ kind: "submit" }, ctx).effect;
        assert(effect?.kind === "swap");
        const allowance = await client
          .token(six.address)
          .read.allowance([owner, getAddress(effect.pool.exchange.address)]);
        assert.equal(allowance, 0n);
        const before = await snapshot();
        const start = proxy.writes.length;
        let switched = false;
        proxy.state.afterApproval = async () => {
          controller.dispatch({ kind: "select-local", address: accounts[2] });
          await until(
            () => controller.session(),
            (value) => !!value && same(value.address, accounts[2]),
            "new wallet after approval"
          );
          switched = true;
        };
        let interruption: string | null = null;
        try {
          await perform("Interrupted routed swap", async (writer) => {
            await writer.routedSwap(effect);
          });
        } catch (error) {
          // DEFENSE: the public wallet may surface the expected identity interruption as a rejected promise.
          interruption = error instanceof Error ? error.message : String(error);
        }
        assert(switched);
        assert.equal(swaps(proxy.writes.slice(start)).length, 0);
        const outcome = controller.kernel.getSnapshot();
        assert(
          interruption ||
            outcome.activity.kind === "interrupted" ||
            outcome.error,
          "the interrupted operation must not be presented as completed"
        );
        const after = await snapshot();
        for (const pool of before.pools) {
          const current = after.pools.find(
            (item) => poolIdentity(item) === poolIdentity(pool)
          );
          assert(current);
          assert.equal(current.reserve0, pool.reserve0);
          assert.equal(current.reserve1, pool.reserve1);
        }
        evidence.walletInterruption = {
          effect,
          interruption,
          writes: proxy.writes.slice(start),
          journal: controller.kernel.getSnapshot().journal,
        };
      }
    );
    evidence.status = "passed";
    evidence.walletWrites = proxy.writes;
    await writeFile(resolve(directory, "result.json"), json(evidence) + "\n");
    console.log(
      JSON.stringify({
        status: "passed",
        evidence: resolve(directory, "result.json"),
        scenarios: scenarios.length,
      })
    );
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error instanceof Error ? error.stack : String(error);
    evidence.walletWrites = proxy.writes;
    await writeFile(resolve(directory, "result.json"), json(evidence) + "\n");
    throw error;
  } finally {
    await proxy.close();
    await environment.close();
  }
}

await main();
