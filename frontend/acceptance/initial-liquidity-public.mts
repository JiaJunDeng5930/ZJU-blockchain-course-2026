import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  getAddress,
  parseEventLogs,
  parseUnits,
  zeroAddress,
  type Abi,
} from "viem";
import { ExchangeClient } from "../src/chain/client";
import type {
  Deployment,
  LiquidityConfirmation,
  Pool,
  Token,
} from "../src/chain/types";
import { depositPreview } from "../src/logic/liquidity";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, root, until } from "./support/chain.mts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) =>
  JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v, 2);

async function main() {
  const environment = await isolatedChain("initial-liquidity-public");
  const { directory, deploy, artifact, read, admin, accounts, rpc } = environment;
  let wallet: WalletController | undefined;
  const scenarios: string[] = [];
  const evidence: Record<string, unknown> = {};
  const fingerprints = async () => Object.fromEntries(await Promise.all([
    "frontend/src/generated/dex_logic.js",
    "frontend/src/chain/client.ts",
    "frontend/src/chain/liquidity.ts",
    "frontend/src/chain/types.ts",
    "frontend/src/logic/liquidity.ts",
    "frontend/src/wallet/session.ts",
  ].map(async (path) => [path, createHash("sha256")
    .update(await readFile(resolve(root, path))).digest("hex")])));
  const sources = await fingerprints();
  try {
    const base = await artifact("TestToken");
    const wrapped = await artifact("WrappedEther");
    const dex = await artifact("MiniDEX");
    const arb = await artifact("AtomicArbitrage");
    const first = await deploy(base, ["Bootstrap base", "BOOT"]);
    const second = await deploy(base, ["Bootstrap other", "OTHER"]);
    const weth = await deploy(wrapped);
    const harbor = await deploy(dex, ["Bootstrap first"]);
    const summit = await deploy(dex, ["Bootstrap second"]);
    const arbitrage = await deploy(arb);
    const precision = (await environment.fixtures(
      "contracts/test/fixtures/PrecisionToken.sol",
    )).PrecisionToken;
    const precisionArtifact = {
      abi: precision.abi,
      bytecode: `0x${precision.evm.bytecode.object}` as `0x${string}`,
    };
    const zeroA = await deploy(precisionArtifact, ["Whole first", "WHOLE", 0]);
    const zeroB = await deploy(precisionArtifact, ["Whole second", "WHOLE", 0]);
    const six = await deploy(precisionArtifact, ["Six decimals", "SIX", 6]);
    const deployment: Deployment = {
      schemaVersion: 1,
      chainId: 31337,
      rpcUrl: environment.rpcUrl,
      tokens: [
        { address: first, name: "Bootstrap base", symbol: "BOOT", kind: "faucet", decimals: 18 },
        { address: second, name: "Bootstrap other", symbol: "OTHER", kind: "faucet", decimals: 18 },
        { address: weth, name: "Wrapped Ether", symbol: "WETH", kind: "wrapped", decimals: 18 },
      ],
      exchanges: [
        { address: harbor, name: "Bootstrap first" },
        { address: summit, name: "Bootstrap second" },
      ],
      arbitrage,
      bytecodes: { TestToken: base.bytecode },
    };
    const client = new ExchangeClient(deployment);
    await client.verifyDeployment();
    const imported = await Promise.all([zeroA, zeroB, six].map((a) => client.importToken(a)));
    const tokens: Token[] = [...deployment.tokens, ...imported];
    const actor = accounts[1];
    const send = async (address: string, abi: Abi, functionName: string, args: readonly unknown[]) => {
      const hash = await admin.writeContract({
        address: getAddress(address), abi, functionName, args,
      });
      const receipt = await read.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      return receipt;
    };
    for (const address of [zeroA, zeroB, six]) {
      await send(address, precision.abi, "mint", [actor, 10n ** 30n]);
    }
    wallet = new WalletController(client, { storage: null });
    await wallet.start();
    wallet.dispatch({ kind: "select-local", address: actor });
    await until(() => wallet!.session(), (s) => !!s && same(s.address, actor), "bootstrap wallet");
    const perform = async (
      label: string,
      action: Parameters<WalletController["perform"]>[0]["perform"],
    ) => {
      const session = wallet!.session();
      assert(session);
      await wallet!.perform({ label, session, perform: action });
    };
    await perform("Fund normal precision capital", (writer) => writer.faucet(deployment.tokens[0]));
    for (const exchange of deployment.exchanges) {
      await perform("Create whole-token pool", (writer) =>
        writer.createPool(exchange.address, zeroA, zeroB));
    }
    await perform("Create mixed-precision pool", (writer) =>
      writer.createPool(deployment.exchanges[0].address, six, first));
    const find = async (exchange: string, tokenA: string, tokenB: string) => {
      const snapshot = await client.snapshot(actor, tokens);
      const pool = snapshot.pools.find((p) => same(p.exchange.address, exchange) &&
        [tokenA, tokenB].every((a) => same(a, p.token0) || same(a, p.token1)));
      assert(pool);
      return { pool, snapshot };
    };
    const allowance = async (token: string, spender: string) => read.readContract({
      address: getAddress(token), abi: precision.abi, functionName: "allowance", args: [actor, spender],
    });
    const locked = await read.readContract({
      address: harbor, abi: dex.abi, functionName: "MINIMUM_LIQUIDITY",
    }) as bigint;
    assert.equal(locked, 1000n, "The public bootstrap policy is 1000 pool shares");
    {
      const { pool, snapshot } = await find(harbor, zeroA, zeroB);
      const preview = depositPreview(pool, "1000", "1000", "0.5",
        snapshot.balances[pool.token0], snapshot.balances[pool.token1], tokens);
      assert.equal(preview.ok, false);
      const nonce = await rpc("eth_getTransactionCount", [actor, "latest"]);
      const approvals = await Promise.all([pool.token0, pool.token1].map((t) => allowance(t, harbor)));
      await assert.rejects(() => perform("Reject deposit swallowed by the lock", (writer) =>
        writer.addLiquidity(pool, 1000n, 1000n, 50n)));
      assert.equal(await rpc("eth_getTransactionCount", [actor, "latest"]), nonce);
      assert.deepEqual(await Promise.all([pool.token0, pool.token1].map((t) => allowance(t, harbor))), approvals);
      assert.equal((await find(harbor, zeroA, zeroB)).pool.totalShares, 0n);
      scenarios.push("A deposit no larger than the permanent lock sends no approval or mint transaction");
      evidence.rejection = { preview, nonce, approvals };
    }
    const exercise = async (
      label: string, exchange: string, a: string, b: string,
      textByAddress: Record<string, string>,
      expected?: { shares: bigint; total: bigint; lock: bigint; claim: bigint },
    ) => {
      const { pool, snapshot } = await find(exchange, a, b);
      const text = (address: string) => {
        const entry = Object.entries(textByAddress).find(([key]) => same(key, address));
        assert(entry);
        return entry[1];
      };
      const token = (address: string) => {
        const found = tokens.find((t) => same(t.address, address));
        assert(found);
        return found;
      };
      const preview = depositPreview(pool, text(pool.token0), text(pool.token1), "0.5",
        snapshot.balances[pool.token0], snapshot.balances[pool.token1], tokens);
      assert(preview.ok);
      if (expected) {
        assert.equal(preview.shares, expected.shares);
        assert.equal(preview.totalSharesAfter, expected.total);
        assert.equal(preview.newLockedShares, expected.lock);
        assert.deepEqual([preview.redeemable0, preview.redeemable1], [expected.claim, expected.claim]);
      }
      let minted: LiquidityConfirmation | undefined;
      await perform(label, async (writer) => {
        minted = await writer.addLiquidity(pool,
          parseUnits(text(pool.token0), token(pool.token0).decimals),
          parseUnits(text(pool.token1), token(pool.token1).decimals), 50n);
      });
      assert(minted && minted.kind === "deposit");
      assert.equal(minted.shares, preview.shares);
      assert(same(minted.pool.exchange.address, exchange));
      assert.equal(minted.pool.id, pool.id);
      const add = parseEventLogs({ abi: dex.abi, logs: minted.receipt.logs,
        eventName: "LiquidityAdded", strict: true });
      assert.equal(add.length, 1);
      const added = add[0].args as { poolId: bigint; positionId: bigint; shares: bigint; amount0: bigint; amount1: bigint };
      assert.equal(added.positionId, minted.positionId);
      assert.equal(added.shares, preview.shares);
      const afterMint = await find(exchange, a, b);
      assert.equal(afterMint.pool.totalShares, preview.totalSharesAfter);
      assert.equal(afterMint.pool.totalShares - pool.totalShares - minted.shares,
        preview.newLockedShares, "Newly locked shares match the observed supply increment");
      const owner = await read.readContract({ address: getAddress(exchange), abi: dex.abi,
        functionName: "ownerOf", args: [minted.positionId] }) as string;
      assert(same(owner, actor));
      const transfers = parseEventLogs({ abi: dex.abi, logs: minted.receipt.logs,
        eventName: "Transfer", strict: true });
      assert(transfers.some((log) => {
        const args = log.args as { from: string; to: string; tokenId: bigint };
        return same(args.from, zeroAddress) && same(args.to, actor) && args.tokenId === minted!.positionId;
      }));
      const beforeBurn = afterMint.snapshot.balances;
      let redeemed: LiquidityConfirmation | undefined;
      await perform("Redeem the quoted new NFT", async (writer) => {
        redeemed = await writer.removeLiquidity(afterMint.pool, minted!.positionId,
          [preview.redeemable0, preview.redeemable1], 0n);
      });
      assert(redeemed && redeemed.kind === "redeem");
      assert.deepEqual([redeemed.amount0, redeemed.amount1], [preview.redeemable0, preview.redeemable1]);
      const final = await find(exchange, a, b);
      assert.equal(final.snapshot.balances[pool.token0] - beforeBurn[pool.token0], preview.redeemable0);
      assert.equal(final.snapshot.balances[pool.token1] - beforeBurn[pool.token1], preview.redeemable1);
      assert.equal(final.pool.totalShares, locked);
      await assert.rejects(() => read.readContract({ address: getAddress(exchange), abi: dex.abi,
        functionName: "ownerOf", args: [minted!.positionId] }));
      scenarios.push(label);
      evidence[label] = { pool, preview, minted, redeemed, finalPool: final.pool };
      return { minted, final };
    };
    const firstMint = await exercise(
      "Whole-token bootstrap discloses a 1000/1001 lock and a 1/1 NFT claim",
      harbor, zeroA, zeroB, { [zeroA]: "1001", [zeroB]: "1001" },
      { shares: 1n, total: 1001n, lock: 1000n, claim: 1n },
    );
    assert.equal(firstMint.final.pool.reserve0, 1000n);
    assert.equal(firstMint.final.pool.reserve1, 1000n);
    await exercise("A subsequent deposit adds no new permanent lock", harbor, zeroA, zeroB,
      { [zeroA]: "1001", [zeroB]: "1001" },
      { shares: 1001n, total: 2001n, lock: 0n, claim: 1001n });
    const beforeOtherDex = (await find(harbor, zeroA, zeroB)).pool;
    const other = await exercise("Identically numbered NFT claims remain scoped to their DEX",
      summit, zeroA, zeroB, { [zeroA]: "2001", [zeroB]: "2001" },
      { shares: 1001n, total: 2001n, lock: 1000n, claim: 1001n });
    assert.equal(other.minted.positionId, firstMint.minted.positionId);
    assert.deepEqual((await find(harbor, zeroA, zeroB)).pool, beforeOtherDex);
    await exercise("Six/eighteen-decimal projections match actual mint and immediate redemption",
      harbor, six, first, { [six]: "23.456789", [first]: "17.123456789123456789" });
    assert.deepEqual(await fingerprints(), sources, "Acceptance ran one unchanged source and kernel snapshot");
    await writeFile(resolve(directory, "result.json"), json({
      status: "passed", programSha256: sources["frontend/src/generated/dex_logic.js"],
      sourceFingerprints: sources, scenarios, evidence,
    }));
    console.log(json({ status: "passed", scenarios: scenarios.length, result: resolve(directory, "result.json") }));
  } catch (error) {
    await writeFile(resolve(directory, "result.json"), json({
      status: "failed", sourceFingerprints: sources, scenarios, evidence,
      error: error instanceof Error ? error.stack : String(error),
    }));
    throw error;
  } finally {
    wallet?.stop();
    await environment.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
