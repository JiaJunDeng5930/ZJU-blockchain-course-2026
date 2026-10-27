import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createWalletClient, getAddress, http, maxUint256 } from "viem";
import { isolatedChain, root, until } from "./support/chain.mts";
import { ExchangeClient } from "../src/chain/client";
import { WalletController } from "../src/wallet/session";
import { AllowanceController } from "../src/chain/allowances";
import { AssetCatalog, catalogView } from "../src/logic/assets";
import { createSwapController } from "../src/logic/trade";
import { depositPreview, positionView } from "../src/logic/liquidity";
import { arbitragePreview, scanArbitrage } from "../src/logic/arbitrage";
import { formatUnits, formatPrice, positiveAmount } from "../src/logic/units";
import { formatAmount, reservePrice } from "../src/chain/amounts";
import type {
  ArbitrageResult,
  Deployment,
  Pool,
  Token,
} from "../src/chain/types";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const serialize = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry),
    2,
  );

async function main() {
  const environment = await isolatedChain("precision-public");
  const { directory, accounts, read, admin, deploy, artifact } = environment;
  const programHash = async () =>
    createHash("sha256")
      .update(
        await readFile(resolve(root, "frontend/src/generated/dex_logic.js")),
      )
      .digest("hex");
  const programSha256 = await programHash();
  const scenarios: { scenario: string; outcome: string }[] = [];
  const evidence: Record<string, unknown> = {
    status: "running",
    programSha256,
    scenarios,
  };
  let wallet: WalletController | undefined;
  let approvals: AllowanceController | undefined;
  const scenario = async (name: string, run: () => void | Promise<void>) => {
    await run();
    scenarios.push({ scenario: name, outcome: "passed" });
  };
  try {
    const base = await artifact("TestToken");
    const baseA = await deploy(base, ["Base A", "BSA"]);
    const baseB = await deploy(base, ["Base B", "BSB"]);
    const weth = await deploy(await artifact("WrappedEther"));
    const first = await deploy(await artifact("MiniDEX"), ["Precision DEX A"]);
    const second = await deploy(await artifact("MiniDEX"), ["Precision DEX B"]);
    const arbitrage = await deploy(await artifact("AtomicArbitrage"));
    const fixtures = await environment.fixtures(
      "contracts/test/fixtures/PrecisionToken.sol",
    );
    const precisionFixture = fixtures.PrecisionToken;
    const deployed = new Map<number, string>();
    for (const places of [0, 6, 8, 255]) {
      deployed.set(
        places,
        await deploy(
          {
            abi: precisionFixture.abi,
            bytecode: `0x${precisionFixture.evm.bytecode.object}`,
          },
          [`Precision ${places}`, `P${places}`, places],
        ),
      );
    }
    const hidden = fixtures.UnreadablePrecisionToken;
    const unreadable = await deploy({
      abi: hidden.abi,
      bytecode: `0x${hidden.evm.bytecode.object}`,
    });
    const deployment: Deployment = {
      schemaVersion: 1,
      chainId: 31337,
      rpcUrl: environment.rpcUrl,
      tokens: [
        {
          address: baseA,
          name: "Base A",
          symbol: "BSA",
          kind: "faucet",
          decimals: 18,
        },
        {
          address: baseB,
          name: "Base B",
          symbol: "BSB",
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
        { address: first, name: "Precision DEX A" },
        { address: second, name: "Precision DEX B" },
      ],
      arbitrage,
      bytecodes: { TestToken: base.bytecode },
    };
    // Simulate a deployment JSON generated before precision was added to its DTO.
    const legacy = JSON.parse(JSON.stringify(deployment));
    for (const token of legacy.tokens) delete token.decimals;
    const client = new ExchangeClient(legacy);
    await client.verifyDeployment();
    wallet = new WalletController(client, { storage: null });
    await wallet.start();
    wallet.dispatch({ kind: "select-local", address: accounts[1] });
    await until(
      () => wallet!.session(),
      (session) => !!session && same(session.address, accounts[1]),
      "selected precision wallet",
    );
    const controller = wallet;
    const owner = accounts[1];
    const ownerWallet = createWalletClient({
      account: owner,
      chain: environment.chain,
      transport: http(environment.rpcUrl),
    });
    const perform = (
      label: string,
      action: Parameters<WalletController["perform"]>[0]["perform"],
    ) => {
      const session = controller.session();
      assert(session);
      return controller.perform({ label, session, perform: action });
    };
    const tokens: Token[] = [...client.deployment.tokens];
    const byPrecision = new Map<number, Token>();
    await scenario(
      "Metadata is observed for imported precisions and missing metadata is never guessed",
      async () => {
        assert(
          client.deployment.tokens.every((token) => token.decimals === 18),
        );
        for (const [places, address] of deployed) {
          const token = await client.importToken(address);
          assert.equal(token.decimals, places);
          assert.equal(token.kind, "external");
          byPrecision.set(places, token);
          tokens.push(token);
        }
        await assert.rejects(() => client.importToken(unreadable));
        evidence.metadata = {
          defaults: client.deployment.tokens,
          imported: [...byPrecision.values()],
        };
      },
    );
    const six = byPrecision.get(6)!;
    const eight = byPrecision.get(8)!;
    const zero = byPrecision.get(0)!;
    const extreme = byPrecision.get(255)!;
    const eighteen = client.deployment.tokens.find((token) =>
      same(token.address, baseA),
    )!;
    await scenario(
      "The extracted unit interface preserves smallest units and rejects nonrepresentable amounts",
      () => {
        const examples = [
          { token: zero, text: "7", raw: 7n },
          { token: six, text: "0.000001", raw: 1n },
          { token: eight, text: "0.00000001", raw: 1n },
          { token: eighteen, text: "0.000000000000000001", raw: 1n },
          { token: extreme, text: `0.${"0".repeat(254)}1`, raw: 1n },
        ];
        for (const { token, text, raw } of examples) {
          assert.equal(positiveAmount(text, token.decimals), raw);
          assert.equal(formatUnits(raw, token.decimals), text);
          assert.equal(
            positiveAmount(formatUnits(raw, token.decimals), token.decimals),
            raw,
          );
          assert(
            !/^0(?:\.0*)?$/.test(formatAmount(raw, token.decimals)),
            "a positive amount must not be displayed as zero",
          );
        }
        assert.throws(() => positiveAmount("0.1", zero.decimals));
        assert.throws(() => positiveAmount("0.0000001", six.decimals));
        assert.throws(() => positiveAmount((maxUint256 + 1n).toString(), 0));
        assert.equal(positiveAmount(maxUint256.toString(), 0), maxUint256);
        evidence.units = examples;
      },
    );
    await scenario(
      "Saved catalog metadata is re-observed before a legacy token becomes usable",
      () => {
        const saved = JSON.stringify([
          {
            address: six.address,
            name: six.name,
            symbol: six.symbol,
            kind: "external",
          },
        ]);
        const catalog = new AssetCatalog(client.deployment.tokens, saved);
        const restored = catalogView(catalog.snapshot(), []);
        assert(
          !restored.tokens.some((token) => same(token.address, six.address)),
        );
        assert(
          restored.discovery.some((address) => same(address, six.address)),
        );
        catalog.register([six]);
        assert.equal(
          catalogView(catalog.snapshot(), []).tokens.find((token) =>
            same(token.address, six.address),
          )?.decimals,
          6,
        );
      },
    );
    for (const token of [six, eight, zero, extreme]) {
      const amount =
        token.decimals === 6
          ? 10_000_000_000_000_001n
          : token.decimals === 255
            ? 7n
            : positiveAmount("10000", token.decimals);
      const hash = await admin.writeContract({
        address: getAddress(token.address),
        abi: precisionFixture.abi,
        functionName: "mint",
        args: [owner, amount],
      });
      await read.waitForTransactionReceipt({ hash });
    }
    await perform("Prepare base test asset", (writer) =>
      writer.faucet(eighteen),
    );
    const funded = await client.snapshot(owner, tokens);
    assert.equal(funded.balances[six.address], 10_000_000_000_000_001n);
    assert.equal(
      formatUnits(funded.balances[six.address], 6),
      "10000000000.000001",
    );
    assert.equal(funded.balances[extreme.address], 7n);
    evidence.fundedBalances = funded.balances;
    assert(
      !/^0(?:\.0*)?$/.test(formatAmount(funded.balances[extreme.address], 255)),
    );
    await perform("Create mixed precision pool", (writer) =>
      writer.createPool(first, six.address, eighteen.address),
    );
    const findPair = async (
      exchange: string,
      tokenA: string,
      tokenB: string,
    ): Promise<Pool> => {
      const snapshot = await client.snapshot(owner, tokens);
      const found = snapshot.pools.find(
        (pool) =>
          same(pool.exchange.address, exchange) &&
          [pool.token0, pool.token1].some((address) => same(address, tokenA)) &&
          [pool.token0, pool.token1].some((address) => same(address, tokenB)),
      );
      assert(found);
      return found;
    };
    const findPool = (exchange: string) =>
      findPair(exchange, six.address, eighteen.address);
    const tokenFor = (address: string) => {
      const token = tokens.find((token) => same(token.address, address));
      assert(token);
      return token;
    };
    let pool = await findPool(first);
    const desired = (pool: Pool, firstText: string, secondText = firstText) =>
      [
        positiveAmount(firstText, tokenFor(pool.token0).decimals),
        positiveAmount(secondText, tokenFor(pool.token1).decimals),
      ] as const;
    await perform("Seed mixed pool", (writer) =>
      writer.addLiquidity(pool, ...desired(pool, "100"), 50n),
    );
    pool = await findPool(first);
    await scenario(
      "Mixed 6 and 18 decimal reserves express the same human price",
      () => {
        const token0 = tokenFor(pool.token0),
          token1 = tokenFor(pool.token1);
        assert.match(
          formatPrice(
            pool.reserve1,
            token1.decimals,
            pool.reserve0,
            token0.decimals,
          )!,
          /^1(?:\.0+)?$/,
        );
        assert.equal(reservePrice(pool, tokens), 1);
        evidence.initialPool = pool;
      },
    );
    await scenario(
      "A six-decimal swap carries the entered raw amount and matches the contract quote",
      async () => {
        const before = await client.snapshot(owner, tokens);
        const context = {
          pool,
          tokens,
          balances: before.balances,
          connected: true,
          pending: false,
        };
        const swap = createSwapController(pool.token0);
        swap.dispatch({ kind: "pay", value: six.address }, context);
        evidence.swapInitial = swap.view(context);
        evidence.swapMax = swap.dispatch({ kind: "max" }, context);
        assert.equal(
          swap.view(context).amountText,
          formatUnits(before.balances[six.address], 6),
        );
        swap.dispatch({ kind: "amount", value: "0.0000001" }, context);
        assert.equal(swap.view(context).canSubmit, false);
        swap.dispatch({ kind: "amount", value: "1" }, context);
        const view = swap.dispatch({ kind: "submit" }, context);
        assert.equal(view.effect?.kind, "swap");
        const effect = view.effect;
        assert(effect?.kind === "swap");
        assert.equal(effect.input, 1_000_000n);
        const expected = await client.quote(pool, six.address, 1_000_000n);
        assert.equal(effect.quoted, expected);
        await perform("Mixed precision swap", (writer) =>
          writer.swap(
            pool,
            effect.inputToken,
            effect.input,
            effect.quoted,
            effect.slippage,
          ),
        );
        const after = await client.snapshot(owner, tokens);
        assert.equal(
          before.balances[six.address] - after.balances[six.address],
          1_000_000n,
        );
        assert.equal(
          after.balances[eighteen.address] - before.balances[eighteen.address],
          expected,
        );
        evidence.swap = {
          before: before.balances,
          after: after.balances,
          input: 1_000_000n,
          output: expected,
          view,
        };
        pool = await findPool(first);
      },
    );
    await scenario(
      "Mixed precision liquidity input and NFT redemption agree with actual token deltas",
      async () => {
        const before = await client.snapshot(owner, tokens);
        const plan = depositPreview(
          pool,
          "10",
          "10",
          "0.5",
          before.balances[pool.token0],
          before.balances[pool.token1],
          tokens,
        );
        assert(plan.ok);
        assert.equal(
          plan.desired0,
          positiveAmount("10", tokenFor(pool.token0).decimals),
        );
        assert.equal(
          plan.desired1,
          positiveAmount("10", tokenFor(pool.token1).decimals),
        );
        await perform("Add mixed precision position", (writer) =>
          writer.addLiquidity(pool, plan.desired0, plan.desired1, 50n),
        );
        const added = await client.snapshot(owner, tokens);
        assert.equal(
          before.balances[pool.token0] - added.balances[pool.token0],
          plan.used0,
        );
        assert.equal(
          before.balances[pool.token1] - added.balances[pool.token1],
          plan.used1,
        );
        const position = added.positions.find(
          (position) =>
            !before.positions.some(
              (previous) =>
                previous.id === position.id &&
                same(previous.exchange.address, position.exchange.address),
            ),
        );
        assert(position);
        pool = await findPool(first);
        const shown = positionView(pool, position);
        await perform("Redeem mixed precision NFT", (writer) =>
          writer.removeLiquidity(pool, position.id, shown.amounts, 50n),
        );
        const removed = await client.snapshot(owner, tokens);
        assert.equal(
          removed.balances[pool.token0] - added.balances[pool.token0],
          shown.amounts[0],
        );
        assert.equal(
          removed.balances[pool.token1] - added.balances[pool.token1],
          shown.amounts[1],
        );
        assert(
          !removed.positions.some(
            (item) =>
              item.id === position.id &&
              same(item.exchange.address, position.exchange.address),
          ),
        );
        evidence.liquidity = {
          plan,
          shown,
          position,
          redeemedBalances: removed.balances,
        };
        pool = await findPool(first);
      },
    );
    await scenario(
      "Finite and unlimited six-decimal approvals are displayed in their own units and revoked",
      async () => {
        const manager = new AllowanceController(client, controller, tokens);
        approvals = manager;
        for (const value of [1_500_000n, maxUint256]) {
          const hash = await ownerWallet.writeContract({
            address: getAddress(six.address),
            abi: precisionFixture.abi,
            functionName: "approve",
            args: [getAddress(arbitrage), value],
          });
          await read.waitForTransactionReceipt({ hash });
          await manager.refresh();
          const row = manager
            .getSnapshot()
            .rows.find(
              (row) =>
                same(row.token, six.address) && same(row.spender, arbitrage),
            );
          assert(row);
          assert.equal(row.allowance, value.toString());
          assert.equal(row.unlimited, value === maxUint256);
          if (!row.unlimited)
            assert.match(
              formatAmount(BigInt(row.allowance!), six.decimals),
              /^1\.50*$/,
            );
          manager.review(six.address, arbitrage);
          await manager.confirm();
          assert.equal(manager.getSnapshot().action.kind, "verified");
          assert.equal(
            await read.readContract({
              address: getAddress(six.address),
              abi: precisionFixture.abi,
              functionName: "allowance",
              args: [owner, getAddress(arbitrage)],
            }),
            0n,
          );
        }
      },
    );
    await scenario(
      "A zero-decimal token trades with an eight-decimal token without fractional input",
      async () => {
        await perform("Create zero and eight precision pool", (writer) =>
          writer.createPool(first, zero.address, eight.address),
        );
        let integerPool = await findPair(first, zero.address, eight.address);
        await perform("Seed zero and eight precision pool", (writer) =>
          writer.addLiquidity(integerPool, ...desired(integerPool, "100"), 50n),
        );
        integerPool = await findPair(first, zero.address, eight.address);
        assert.equal(reservePrice(integerPool, tokens), 1);
        const before = await client.snapshot(owner, tokens);
        const context = {
          pool: integerPool,
          tokens,
          balances: before.balances,
          connected: true,
          pending: false,
        };
        const swap = createSwapController(integerPool.token0);
        swap.dispatch({ kind: "pay", value: zero.address }, context);
        swap.dispatch({ kind: "amount", value: "0.1" }, context);
        assert.equal(swap.view(context).canSubmit, false);
        swap.dispatch({ kind: "amount", value: "1" }, context);
        const effect = swap.dispatch({ kind: "submit" }, context).effect;
        assert(effect?.kind === "swap");
        assert.equal(effect.input, 1n);
        assert.equal(
          effect.quoted,
          await client.quote(integerPool, zero.address, 1n),
        );
        await perform("Zero to eight precision swap", (writer) =>
          writer.swap(
            integerPool,
            effect.inputToken,
            effect.input,
            effect.quoted,
            effect.slippage,
          ),
        );
        const after = await client.snapshot(owner, tokens);
        assert.equal(
          before.balances[zero.address] - after.balances[zero.address],
          1n,
        );
        assert.equal(
          after.balances[eight.address] - before.balances[eight.address],
          effect.quoted,
        );
        assert.equal(
          positiveAmount(formatUnits(effect.quoted, 8), 8),
          effect.quoted,
        );
        evidence.integerSwap = {
          input: effect.input,
          output: effect.quoted,
          pool: integerPool,
        };
      },
    );
    await scenario(
      "Atomic arbitrage uses six-decimal principal and profit across two exchanges",
      async () => {
        await perform("Create second mixed pool", (writer) =>
          writer.createPool(second, six.address, eighteen.address),
        );
        const other = await findPool(second);
        const a0 = positiveAmount(
          same(other.token0, six.address) ? "200" : "100",
          tokenFor(other.token0).decimals,
        );
        const a1 = positiveAmount(
          same(other.token1, six.address) ? "200" : "100",
          tokenFor(other.token1).decimals,
        );
        await perform("Seed second mixed pool", (writer) =>
          writer.addLiquidity(other, a0, a1, 50n),
        );
        const before = await client.snapshot(owner, tokens);
        pool = await findPool(first);
        const routes = scanArbitrage(
          pool,
          before.pools,
          six.address,
          before.block,
          tokens,
        );
        assert(routes.length > 0);
        const route = routes[0];
        assert(route.amountIn % 1_000_000n === 0n);
        assert(
          route.amountIn < 1_000_000_000n,
          "candidate principal must use six-decimal whole-token grid",
        );
        assert.equal(
          arbitragePreview(
            arbitrage,
            route,
            "0.000001",
            before.balances[six.address],
            six,
          ).canExecute,
          true,
        );
        assert.equal(
          arbitragePreview(
            arbitrage,
            route,
            "0.0000001",
            before.balances[six.address],
            six,
          ).canExecute,
          false,
        );
        let result: ArbitrageResult | undefined;
        await perform("Atomic mixed precision arbitrage", async (writer) => {
          result = await writer.arbitrage(route, "0.000001");
        });
        assert(result);
        const after = await client.snapshot(owner, tokens);
        assert(result.profit > 0n);
        assert.equal(
          after.balances[six.address] - before.balances[six.address],
          result.profit,
        );
        assert.equal(
          positiveAmount(formatUnits(result.profit, 6), 6),
          result.profit,
        );
        evidence.arbitrage = {
          route,
          result,
          balanceDelta:
            after.balances[six.address] - before.balances[six.address],
        };
      },
    );
    assert.equal(
      await programHash(),
      programSha256,
      "the bundle changed during acceptance",
    );
    evidence.status = "passed";
    await writeFile(resolve(directory, "result.json"), serialize(evidence));
    console.log(
      JSON.stringify({
        status: "passed",
        evidence: resolve(directory, "result.json"),
        scenarios: scenarios.length,
      }),
    );
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error instanceof Error ? error.stack : String(error);
    await writeFile(resolve(directory, "result.json"), serialize(evidence));
    throw error;
  } finally {
    approvals?.dispose();
    await environment.close();
  }
}

await main();
