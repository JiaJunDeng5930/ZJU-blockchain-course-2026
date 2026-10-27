import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  formatUnits,
  getAddress,
  maxUint256,
  parseAbiItem,
  parseEventLogs,
  parseUnits,
  zeroAddress,
  type Abi,
} from "viem";
import { ExchangeClient } from "../src/chain/client";
import type { Deployment, LiquidityConfirmation, Pool, Token } from "../src/chain/types";
import { depositBalancePreview, depositPreview } from "../src/logic/liquidity";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, root, until } from "./support/chain.mts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) => JSON.stringify(value,
  (_key, v) => typeof v === "bigint" ? v.toString() : v, 2);

async function main() {
  const environment = await isolatedChain("liquidity-balances-public");
  const { directory, deploy, artifact, read, admin, accounts, rpc } = environment;
  let wallet: WalletController | undefined;
  const scenarios: string[] = [];
  const evidence: Record<string, unknown> = {};
  const fingerprints = async () => Object.fromEntries(await Promise.all([
    "frontend/src/generated/dex_logic.js",
    "frontend/src/logic/liquidity.ts",
    "frontend/src/chain/client.ts",
    "frontend/src/chain/liquidity.ts",
    "frontend/src/chain/types.ts",
    "frontend/src/wallet/session.ts",
  ].map(async (file) => [file, createHash("sha256")
    .update(await readFile(resolve(root, file))).digest("hex")])));
  const sources = await fingerprints();
  try {
    if (process.env.DEX_EXPECTED_KERNEL_SHA256) {
      assert.equal(sources["frontend/src/generated/dex_logic.js"],
        process.env.DEX_EXPECTED_KERNEL_SHA256);
    }
    const base = await artifact("TestToken");
    const wrapped = await artifact("WrappedEther");
    const dex = await artifact("MiniDEX");
    const arb = await artifact("AtomicArbitrage");
    const first = await deploy(base, ["Unused base", "BASE"]);
    const second = await deploy(base, ["Unused other", "OTHER"]);
    const weth = await deploy(wrapped);
    const harbor = await deploy(dex, ["Balance market"]);
    const summit = await deploy(dex, ["Unpriced market"]);
    const arbitrage = await deploy(arb);
    const precision = (await environment.fixtures(
      "contracts/test/fixtures/PrecisionToken.sol",
    )).PrecisionToken;
    const precisionArtifact = {
      abi: precision.abi,
      bytecode: `0x${precision.evm.bytecode.object}` as `0x${string}`,
    };
    const high = await deploy(precisionArtifact, ["Eighteen", "HIGH", 18]);
    const low = await deploy(precisionArtifact, ["Six", "LOW", 6]);
    const wholeA = await deploy(precisionArtifact, ["Whole A", "WHOLE", 0]);
    const wholeB = await deploy(precisionArtifact, ["Whole B", "WHOLE", 0]);
    const deployment: Deployment = {
      schemaVersion: 1,
      chainId: 31337,
      rpcUrl: environment.rpcUrl,
      tokens: [
        { address: first, name: "Unused base", symbol: "BASE", kind: "faucet", decimals: 18 },
        { address: second, name: "Unused other", symbol: "OTHER", kind: "faucet", decimals: 18 },
        { address: weth, name: "Wrapped Ether", symbol: "WETH", kind: "wrapped", decimals: 18 },
      ],
      exchanges: [
        { address: harbor, name: "Balance market" },
        { address: summit, name: "Unpriced market" },
      ],
      arbitrage,
      bytecodes: { TestToken: base.bytecode },
    };
    const client = new ExchangeClient(deployment);
    await client.verifyDeployment();
    const imported = await Promise.all([high, low, wholeA, wholeB].map(a => client.importToken(a)));
    const tokens: Token[] = [...deployment.tokens, ...imported];
    const actor = accounts[1];
    const send = async (address: string, abi: Abi, functionName: string, args: readonly unknown[]) => {
      const hash = await admin.writeContract({ address: getAddress(address), abi, functionName, args });
      const receipt = await read.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      return receipt;
    };
    const poolFor = async (exchange: string, a: string, b: string) => {
      const block = Number(BigInt(await rpc("eth_blockNumber") as string));
      const pool = (await client.pools(block)).find(p => same(p.exchange.address, exchange)
        && [a, b].every(t => same(t, p.token0) || same(t, p.token1)));
      assert(pool);
      return pool;
    };
    const balances = async (pool: Pool, owner = actor) => Promise.all(
      [pool.token0, pool.token1].map(address => read.readContract({
        address: getAddress(address), abi: precision.abi,
        functionName: "balanceOf", args: [owner],
      }) as Promise<bigint>),
    );
    const allowances = async (pool: Pool) => Promise.all(
      [pool.token0, pool.token1].map(address => read.readContract({
        address: getAddress(address), abi: precision.abi,
        functionName: "allowance", args: [actor, pool.exchange.address],
      }) as Promise<bigint>),
    );
    const seed = async (a: string, b: string, amountA: bigint, amountB: bigint) => {
      await send(harbor, dex.abi, "createPool", [a, b]);
      const pool = await poolFor(harbor, a, b);
      for (const [address, amount] of [[a, amountA], [b, amountB]] as const) {
        await send(address, precision.abi, "mint", [accounts[0], amount]);
        await send(address, precision.abi, "approve", [harbor, maxUint256]);
      }
      const amount0 = same(pool.token0, a) ? amountA : amountB;
      const amount1 = same(pool.token1, b) ? amountB : amountA;
      const latest = await read.getBlock();
      await send(harbor, dex.abi, "addLiquidity", [pool.id, amount0, amount1,
        0n, 0n, latest.timestamp + 1200n]);
    };
    await seed(high, low, parseUnits("1000", 18), parseUnits("2000", 6));
    const emptyWhole = await send(summit, dex.abi, "createPool", [wholeA, wholeB]);
    await send(harbor, dex.abi, "createPool", [wholeA, wholeB]);
    const orderedWhole = await poolFor(harbor, wholeA, wholeB);
    for (const [address, amount] of [[orderedWhole.token0, 3000n], [orderedWhole.token1, 2001n]] as const) {
      await send(address, precision.abi, "mint", [accounts[0], amount]);
      await send(address, precision.abi, "approve", [harbor, maxUint256]);
    }
    const latest = await read.getBlock();
    await send(harbor, dex.abi, "addLiquidity", [orderedWhole.id, 3000n, 2001n,
      0n, 0n, latest.timestamp + 1200n]);
    await send(high, precision.abi, "mint", [actor, parseUnits("7.123456789012345678", 18)]);
    await send(low, precision.abi, "mint", [actor, parseUnits("3.5", 6)]);
    await send(orderedWhole.token0, precision.abi, "mint", [actor, 10n]);
    await send(orderedWhole.token1, precision.abi, "mint", [actor, 4n]);
    wallet = new WalletController(client, { storage: null });
    await wallet.start();
    wallet.dispatch({ kind: "select-local", address: actor });
    await until(() => wallet!.session(), s => !!s && same(s.address, actor), "balance wallet");
    const perform = async (label: string,
      action: Parameters<WalletController["perform"]>[0]["perform"]) => {
      const session = wallet!.session();
      assert(session);
      await wallet!.perform({ label, session, perform: action });
    };

    {
      const empty = await poolFor(summit, wholeA, wholeB);
      const active = await poolFor(harbor, wholeA, wholeB);
      const [b0, b1] = await balances(active);
      const anonymous = await client.snapshot(undefined, tokens);
      const zeroBalances = await balances(active, accounts[2]);
      const before = { block: await rpc("eth_blockNumber"),
        nonce: await rpc("eth_getTransactionCount", [actor, "latest"]),
        allowances: await allowances(active), emptyAllowances: await allowances(empty) };
      const rejected = [
        depositBalancePreview(empty, "0.5", b0, b1),
        depositBalancePreview(active, "0.5", anonymous.balances[active.token0], anonymous.balances[active.token1]),
        depositBalancePreview(active, "0.5", zeroBalances[0], zeroBalances[1]),
        depositBalancePreview(active, "not a tolerance", b0, b1),
      ];
      assert(rejected.every(d => !d.ok));
      assert(rejected.every(d => d.error), "Unavailable budget actions explain why no plan exists");
      assert.equal(await rpc("eth_blockNumber"), before.block);
      assert.equal(await rpc("eth_getTransactionCount", [actor, "latest"]), before.nonce);
      assert.deepEqual(await allowances(active), before.allowances);
      assert.deepEqual(await allowances(empty), before.emptyAllowances);
      assert.equal((await poolFor(summit, wholeA, wholeB)).totalShares, 0n);
      scenarios.push("Empty pools require explicit pricing and unknown, zero or invalid budgets cannot authorize a deposit");
      evidence.rejected = { before, rejected, emptyPool: empty, creation: emptyWhole.transactionHash };
    }

    const exercise = async (label: string, a: string, b: string,
      expected?: { used: readonly [bigint, bigint]; shares: bigint }) => {
      const pool = await poolFor(harbor, a, b);
      const before = await balances(pool);
      const preview = depositBalancePreview(pool, "0.5", before[0], before[1]);
      assert(preview.ok);
      assert.deepEqual([preview.desired0, preview.desired1], before,
        "The public quote preserves both original wallet limits");
      const precisionFor = (address: string) => {
        const token = tokens.find(t => same(t.address, address));
        assert(token);
        return token.decimals;
      };
      const reentered = depositPreview(pool,
        formatUnits(preview.desired0, precisionFor(pool.token0)),
        formatUnits(preview.desired1, precisionFor(pool.token1)),
        "0.5", before[0], before[1], tokens);
      assert(reentered.ok);
      assert.deepEqual(reentered, preview, "Exact balance strings survive the normal deposit entrypoint");
      assert(preview.unused0 > 0n || preview.unused1 > 0n);
      const firstBlock = BigInt(await rpc("eth_blockNumber") as string);
      let minted: LiquidityConfirmation | undefined;
      await perform(label, async writer => {
        minted = await writer.addLiquidity(pool, preview.desired0, preview.desired1, 50n);
      });
      assert(minted && minted.kind === "deposit");
      const event = parseEventLogs({ abi: dex.abi, eventName: "LiquidityAdded",
        logs: minted.receipt.logs.filter(log => same(log.address, harbor)), strict: true });
      assert.equal(event.length, 1);
      const args = event[0].args as { poolId: bigint; positionId: bigint; provider: string;
        amount0: bigint; amount1: bigint; shares: bigint };
      assert.equal(args.poolId, pool.id);
      assert.equal(args.positionId, minted.positionId);
      assert(same(args.provider, actor));
      assert.deepEqual([args.amount0, args.amount1], [preview.used0, preview.used1]);
      assert.equal(args.shares, preview.shares);
      if (expected) {
        assert.deepEqual([args.amount0, args.amount1], expected.used);
        assert.equal(args.shares, expected.shares);
      }
      const after = await balances(pool);
      const funded = await poolFor(harbor, a, b);
      assert.deepEqual(after, [preview.unused0, preview.unused1]);
      assert.equal(before[0] - after[0], args.amount0);
      assert.equal(before[1] - after[1], args.amount1);
      assert.equal(funded.reserve0 - pool.reserve0, args.amount0);
      assert.equal(funded.reserve1 - pool.reserve1, args.amount1);
      assert.equal(funded.totalShares - pool.totalShares, args.shares);
      for (const [index, address] of [pool.token0, pool.token1].entries()) {
        const transfers: { args: unknown }[] = parseEventLogs({ abi: precision.abi, eventName: "Transfer",
          logs: minted.receipt.logs.filter(log => same(log.address, address)), strict: true });
        const payment = transfers.find(log => {
          const transfer = log.args as { from: string; to: string; value: bigint };
          return same(transfer.from, actor) && same(transfer.to, harbor);
        });
        assert(payment);
        assert.equal((payment.args as { value: bigint }).value, [args.amount0, args.amount1][index]);
        const approvals: { args: { value?: bigint } }[] = await read.getLogs({ address: getAddress(address),
          event: parseAbiItem("event Approval(address indexed owner,address indexed spender,uint256 value)"),
          args: { owner: actor, spender: harbor }, fromBlock: firstBlock + 1n,
          toBlock: minted.receipt.blockNumber });
        assert.equal(approvals.length, 1);
        assert.equal(approvals[0].args.value, [preview.desired0, preview.desired1][index],
          "Authorization retains the captured wallet budget while actual pool use is event-backed");
      }
      assert.deepEqual(await allowances(pool),
        [preview.desired0 - args.amount0, preview.desired1 - args.amount1],
        "Unused authorization is the captured budget less the actual transfer");
      assert(same(await read.readContract({ address: harbor, abi: dex.abi,
        functionName: "ownerOf", args: [minted.positionId] }) as string, actor));
      let redeemed: LiquidityConfirmation | undefined;
      await perform("Redeem the budget-funded NFT", async writer => {
        redeemed = await writer.removeLiquidity(funded, minted!.positionId,
          [preview.redeemable0, preview.redeemable1], 0n);
      });
      assert(redeemed && redeemed.kind === "redeem");
      const final = await balances(pool);
      assert.deepEqual([redeemed.amount0, redeemed.amount1], [preview.redeemable0, preview.redeemable1]);
      assert.deepEqual(final, [after[0] + redeemed.amount0, after[1] + redeemed.amount1]);
      const removed = parseEventLogs({ abi: dex.abi, eventName: "LiquidityRemoved",
        logs: redeemed.receipt.logs.filter(log => same(log.address, harbor)), strict: true });
      assert.equal(removed.length, 1);
      const burned = parseEventLogs({ abi: dex.abi, eventName: "Transfer",
        logs: redeemed.receipt.logs.filter(log => same(log.address, harbor)), strict: true });
      assert(burned.some(log => {
        const transfer = log.args as { from: string; to: string; tokenId: bigint };
        return same(transfer.from, actor) && same(transfer.to, zeroAddress)
          && transfer.tokenId === minted!.positionId;
      }));
      await assert.rejects(() => read.readContract({ address: harbor, abi: dex.abi,
        functionName: "ownerOf", args: [minted!.positionId] }));
      scenarios.push(label);
      evidence[label] = { pool, before, preview, minted, after, funded, redeemed, final };
    };
    await exercise("Mixed 18/6-decimal wallet budgets preserve unused funds through NFT mint and redemption", high, low);
    await exercise("Whole-unit budget limits survive non-divisible pool ratios without a second rounding pass",
      wholeA, wholeB, { used: [5n, 4n], shares: 4n });
    assert.deepEqual(await fingerprints(), sources, "The accepted kernel and adapters stayed frozen");
    await writeFile(resolve(directory, "result.json"), json({ status: "passed",
      kernelSha256: sources["frontend/src/generated/dex_logic.js"],
      sourceFingerprints: sources, scenarios, evidence }));
    console.log(json({ status: "passed", scenarios: scenarios.length, result: resolve(directory, "result.json") }));
  } catch (error) {
    await writeFile(resolve(directory, "result.json"), json({ status: "failed", sources, scenarios, evidence,
      error: error instanceof Error ? error.stack : String(error) }));
    throw error;
  } finally {
    wallet?.stop();
    await environment.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
