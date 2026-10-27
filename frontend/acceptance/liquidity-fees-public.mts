import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAddress, maxUint256, parseEventLogs, parseUnits, type Abi,
  type TransactionReceipt } from "viem";
import { ExchangeClient } from "../src/chain/client";
import type { Deployment, LiquidityConfirmation, Pool, Token } from "../src/chain/types";
import { positionView } from "../src/logic/liquidity";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, root, until } from "./support/chain.mts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) => JSON.stringify(value,
  (_key, v) => typeof v === "bigint" ? v.toString() : v, 2);

async function main() {
  const environment = await isolatedChain("liquidity-fees-public");
  const { directory, deploy, artifact, read, admin, accounts, rpc } = environment;
  let wallet: WalletController | undefined;
  const scenarios: string[] = [];
  const evidence: Record<string, unknown> = {};
  const fingerprints = async () => Object.fromEntries(await Promise.all([
    "frontend/src/generated/dex_logic.js", "frontend/src/chain/client.ts",
    "frontend/src/chain/liquidity.ts", "frontend/src/chain/types.ts",
    "frontend/src/logic/receipts.ts", "frontend/src/logic/liquidity.ts",
    "frontend/src/wallet/session.ts",
  ].map(async file => [file, createHash("sha256")
    .update(await readFile(resolve(root, file))).digest("hex")])));
  let sources: Record<string, string> = {};
  try {
    sources = await fingerprints();
    if (process.env.DEX_EXPECTED_KERNEL_SHA256)
      assert.equal(sources["frontend/src/generated/dex_logic.js"], process.env.DEX_EXPECTED_KERNEL_SHA256);
    const base = await artifact("TestToken");
    const wrapped = await artifact("WrappedEther");
    const dex = await artifact("MiniDEX");
    const arb = await artifact("AtomicArbitrage");
    const first = await deploy(base, ["Fee capital", "CAP"]);
    const second = await deploy(base, ["Other base", "OTHER"]);
    const weth = await deploy(wrapped);
    const harbor = await deploy(dex, ["Receipt fee market"]);
    const summit = await deploy(dex, ["Other fee market"]);
    const arbitrage = await deploy(arb);
    const precision = (await environment.fixtures("contracts/test/fixtures/PrecisionToken.sol")).PrecisionToken;
    const six = await deploy({ abi: precision.abi,
      bytecode: `0x${precision.evm.bytecode.object}` as `0x${string}` }, ["Six units", "SIX", 6]);
    const deployment: Deployment = {
      schemaVersion: 1, chainId: 31337, rpcUrl: environment.rpcUrl,
      tokens: [
        { address: first, name: "Fee capital", symbol: "CAP", kind: "faucet", decimals: 18 },
        { address: second, name: "Other base", symbol: "OTHER", kind: "faucet", decimals: 18 },
        { address: weth, name: "Wrapped Ether", symbol: "WETH", kind: "wrapped", decimals: 18 },
      ],
      exchanges: [{ address: harbor, name: "Receipt fee market" },
        { address: summit, name: "Other fee market" }],
      arbitrage, bytecodes: { TestToken: base.bytecode },
    };
    const client = new ExchangeClient(deployment);
    await client.verifyDeployment();
    const imported = await client.importToken(six);
    assert.equal(imported.decimals, 6);
    const tokens: Token[] = [...deployment.tokens, imported];
    const actor = accounts[1];
    const recipient = accounts[2];
    const send = async (address: string, abi: Abi, functionName: string, args: readonly unknown[] = []) => {
      const hash = await admin.writeContract({ address: getAddress(address), abi, functionName, args });
      const receipt = await read.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      return receipt;
    };
    const activePool = async () => {
      const block = Number(BigInt(await rpc("eth_blockNumber") as string));
      const pool = (await client.pools(block)).find(p => same(p.exchange.address, harbor));
      assert(pool);
      return pool;
    };
    const native = (owner: string, blockNumber: bigint) =>
      read.getBalance({ address: getAddress(owner), blockNumber });
    const balances = (pool: Pool, owner: string, blockNumber: bigint) => Promise.all(
      [pool.token0, pool.token1].map(address => read.readContract({
        address: getAddress(address), abi: base.abi, functionName: "balanceOf",
        args: [getAddress(owner)], blockNumber,
      }) as Promise<bigint>));
    const dexEvent = (receipt: TransactionReceipt, eventName: string) => {
      const event = parseEventLogs({ abi: dex.abi, eventName, logs: receipt.logs })
        .find(log => same(log.address, harbor));
      assert(event, `Receipt must contain ${eventName} from its DEX`);
      return event.args as Record<string, bigint | string>;
    };
    const checkFee = async (result: LiquidityConfirmation, payer: string) => {
      const receipt = result.receipt;
      assert.equal(receipt.status, "success");
      assert(same(receipt.from, payer));
      const transaction = await read.getTransaction({ hash: receipt.transactionHash });
      assert.equal(transaction.value, 0n, "Only ETH gas leaves the caller in these contract operations");
      const block = await read.getBlock({ blockNumber: receipt.blockNumber });
      assert.deepEqual(block.transactions, [receipt.transactionHash],
        "The observation block contains exactly the executed operation");
      const [before, after] = await Promise.all([
        native(payer, receipt.blockNumber - 1n), native(payer, receipt.blockNumber),
      ]);
      assert.equal(typeof result.gasCostWei, "bigint");
      assert(result.gasCostWei > 0n);
      assert.equal(result.gasCostWei, before - after,
        "Reported execution fee equals actual historical ETH debit, without recomputing receipt gas multiplication");
      const entry = await until(() => wallet!.kernel.getSnapshot().journal.find(row =>
        row.state === "confirmed" && same(row.hash, receipt.transactionHash)),
      row => !!row, "confirmed journal entry for liquidity receipt");
      assert(entry && entry.state === "confirmed");
      assert.equal(BigInt(entry.gas), result.gasCostWei,
        "The wallet journal and liquidity result agree on this receipt's fee");
      return { payer, before, after, gasCostWei: result.gasCostWei,
        journalFeeWei: entry.gas, receipt };
    };

    await send(first, base.abi, "faucet");
    await send(six, precision.abi, "mint", [accounts[0], parseUnits("2000", 6)]);
    await send(harbor, dex.abi, "createPool", [first, six]);
    let pool = await activePool();
    for (const address of [first, six])
      await send(address, base.abi, "approve", [harbor, maxUint256]);
    const seed = [parseUnits("1000", 18), parseUnits("2000", 6)];
    const seedAmounts = same(pool.token0, first) ? seed : [seed[1], seed[0]];
    const latest = await read.getBlock();
    await send(harbor, dex.abi, "addLiquidity", [pool.id, ...seedAmounts,
      0n, 0n, latest.timestamp + 1200n]);
    await send(first, base.abi, "transfer", [actor, parseUnits("10", 18)]);
    await send(six, precision.abi, "mint", [actor, parseUnits("20", 6)]);
    wallet = new WalletController(client, { storage: null });
    await wallet.start();
    const select = async (owner: string) => {
      wallet!.dispatch({ kind: "select-local", address: owner });
      await until(() => wallet!.session(), value => !!value && same(value.address, owner), "selected liquidity actor");
    };
    const perform = async (label: string,
      action: Parameters<WalletController["perform"]>[0]["perform"]) => {
      const session = wallet!.session();
      assert(session);
      await wallet!.perform({ label, session, perform: action });
    };
    await select(actor);
    pool = await activePool();
    const begin = BigInt(await rpc("eth_blockNumber") as string);
    const beforeAll = await native(actor, begin);
    const desired = [parseUnits("2.5", 18), parseUnits("5", 6)];
    const orderedDesired = same(pool.token0, first) ? desired : [desired[1], desired[0]];
    let minted: LiquidityConfirmation | undefined;
    await perform("Mint mixed-precision LP NFT with explicit approvals", async writer => {
      minted = await writer.addLiquidity(pool, orderedDesired[0], orderedDesired[1], 50n);
    });
    assert(minted && minted.kind === "deposit");
    const mintFee = await checkFee(minted, actor);
    const approvalEvents = await read.getContractEvents({
      address: [getAddress(first), getAddress(six)], abi: base.abi, eventName: "Approval",
      fromBlock: begin + 1n, toBlock: minted.receipt.blockNumber - 1n,
    });
    const actualApprovals = approvalEvents.filter(event => {
      const args = event.args as { owner?: string; spender?: string };
      return args.owner && args.spender && same(args.owner, actor) && same(args.spender, harbor);
    });
    assert.equal(actualApprovals.length, 2, "Both token approvals are real preceding transactions");
    const approvalFeeWei = beforeAll - mintFee.before;
    assert(approvalFeeWei > 0n);
    assert.equal(beforeAll - mintFee.after, approvalFeeWei + minted.gasCostWei);
    const mintBefore = await balances(pool, actor, minted.receipt.blockNumber - 1n);
    const mintAfter = await balances(pool, actor, minted.receipt.blockNumber);
    const mintEvent = dexEvent(minted.receipt, "LiquidityAdded");
    assert.equal(mintEvent.amount0, minted.amount0);
    assert.equal(mintEvent.amount1, minted.amount1);
    assert.equal(mintBefore[0] - mintAfter[0], minted.amount0);
    assert.equal(mintBefore[1] - mintAfter[1], minted.amount1);
    assert.deepEqual([minted.amount0, minted.amount1], orderedDesired,
      "Mixed-decimal token quantities are independent of ETH fees");
    assert(same(await read.readContract({ address: harbor, abi: dex.abi,
      functionName: "ownerOf", args: [minted.positionId] }) as string, actor));
    evidence.deposit = { ...mintFee, approvalEvents: actualApprovals,
      approvalFeeWei, beforeAll, mintBefore, mintAfter, result: minted };
    scenarios.push("Mint execution fee excludes its two preceding ERC20 approvals and preserves mixed-unit deposits");

    pool = await activePool();
    let transferred: LiquidityConfirmation | undefined;
    await perform("Transfer LP NFT to another funded account", async writer => {
      transferred = await writer.transferPosition(pool, minted!.positionId, recipient);
    });
    assert(transferred && transferred.kind === "transfer");
    const transferFee = await checkFee(transferred, actor);
    const transferEvent = dexEvent(transferred.receipt, "Transfer");
    assert(same(String(transferEvent.from), actor));
    assert(same(String(transferEvent.to), recipient));
    assert.equal(transferEvent.tokenId, minted.positionId);
    assert(same(transferred.from, actor) && same(transferred.to, recipient));
    const transferBlock = transferred.receipt.blockNumber;
    const receiverBefore = await native(recipient, transferBlock - 1n);
    assert.equal(await native(recipient, transferBlock), receiverBefore,
      "NFT recipient does not pay the sender's transaction fee");
    for (const owner of [actor, recipient])
      assert.deepEqual(await balances(pool, owner, transferBlock), await balances(pool, owner, transferBlock - 1n),
        "Transferring the NFT does not transfer its underlying ERC20 assets");
    assert(same(await read.readContract({ address: harbor, abi: dex.abi,
      functionName: "ownerOf", args: [minted.positionId] }) as string, recipient));
    evidence.transfer = { ...transferFee, receiverBefore, result: transferred };
    scenarios.push("NFT transfer fee is paid by its sender, while recipient ETH and underlying tokens stay unchanged");

    await select(recipient);
    const snapshot = await until(() => client.snapshot(recipient, tokens), value =>
      value.positions.some(position => position.id === minted!.positionId && same(position.exchange.address, harbor)
        && same(position.owner, recipient)), "transferred NFT in the new owner's public snapshot");
    const position = snapshot.positions.find(p => p.id === minted!.positionId && same(p.exchange.address, harbor))!;
    pool = snapshot.pools.find(p => same(p.exchange.address, harbor) && p.id === position.poolId)!;
    assert(pool);
    const request = positionView(pool, position).amounts;
    let redeemed: LiquidityConfirmation | undefined;
    await perform("New owner redeems the transferred NFT", async writer => {
      redeemed = await writer.removeLiquidity(pool, position.id, request, 50n);
    });
    assert(redeemed && redeemed.kind === "redeem");
    const redeemFee = await checkFee(redeemed, recipient);
    const redeemBlock = redeemed.receipt.blockNumber;
    const redeemBefore = await balances(pool, recipient, redeemBlock - 1n);
    const redeemAfter = await balances(pool, recipient, redeemBlock);
    const redeemEvent = dexEvent(redeemed.receipt, "LiquidityRemoved");
    assert.equal(redeemEvent.amount0, redeemed.amount0);
    assert.equal(redeemEvent.amount1, redeemed.amount1);
    assert.equal(redeemAfter[0] - redeemBefore[0], redeemed.amount0);
    assert.equal(redeemAfter[1] - redeemBefore[1], redeemed.amount1);
    assert(same(redeemed.owner, recipient));
    assert.deepEqual(await balances(pool, actor, redeemBlock), await balances(pool, actor, redeemBlock - 1n),
      "The old owner receives neither redeemed token");
    assert.equal(await native(actor, redeemBlock), await native(actor, redeemBlock - 1n),
      "The old owner does not pay the new owner's redemption fee");
    await assert.rejects(read.readContract({ address: harbor, abi: dex.abi,
      functionName: "ownerOf", args: [position.id] }));
    evidence.redeem = { ...redeemFee, redeemBefore, redeemAfter, result: redeemed };
    scenarios.push("Redemption reports the new owner's ETH fee separately from both received token amounts and burns the NFT");
    assert.deepEqual(await fingerprints(), sources, "The accepted public adapters and kernel stayed frozen");
    await writeFile(resolve(directory, "result.json"), json({ status: "passed",
      kernelSha256: sources["frontend/src/generated/dex_logic.js"], sourceFingerprints: sources, scenarios, evidence }));
    console.log(json({ status: "passed", scenarios: scenarios.length, result: resolve(directory, "result.json") }));
  } catch (error) {
    await writeFile(resolve(directory, "result.json"), json({ status: "failed",
      kernelSha256: sources["frontend/src/generated/dex_logic.js"], sourceFingerprints: sources,
      scenarios, evidence, error: error instanceof Error ? error.stack : String(error) }));
    throw error;
  } finally {
    wallet?.stop();
    await environment.close();
  }
}
await main();
