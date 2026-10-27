import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAddress, maxUint256, parseEventLogs, parseUnits, type Abi } from "viem";
import { ExchangeClient } from "../src/chain/client";
import type { Deployment, Pool, SwapResult, Token } from "../src/chain/types";
import { createRoutedSwapController, type RoutedSwapPlan } from "../src/logic/routing";
import { swapSettlementView } from "../src/logic/swapSettlement";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, root, until } from "./support/chain.mts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) => JSON.stringify(value,
  (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);

async function main() {
  const environment = await isolatedChain("swap-settlement-public");
  const { directory, deploy, artifact, read, admin, accounts, rpc } = environment;
  let wallet: WalletController | undefined;
  const scenarios: string[] = [];
  const evidence: Record<string, unknown> = {};
  const fingerprints = async () => Object.fromEntries(await Promise.all([
    "frontend/src/generated/dex_logic.js", "frontend/src/chain/client.ts",
    "frontend/src/chain/types.ts", "frontend/src/logic/routing.ts",
    "frontend/src/logic/swapSettlement.ts", "frontend/src/logic/receipts.ts",
    "frontend/src/wallet/session.ts",
  ].map(async path => [path, createHash("sha256")
    .update(await readFile(resolve(root, path))).digest("hex")])));
  let sources: Record<string, string> = {};
  try {
    sources = await fingerprints();
    if (process.env.DEX_EXPECTED_KERNEL_SHA256)
      assert.equal(sources["frontend/src/generated/dex_logic.js"], process.env.DEX_EXPECTED_KERNEL_SHA256);
    const base = await artifact("TestToken");
    const wrapped = await artifact("WrappedEther");
    const dex = await artifact("MiniDEX");
    const arb = await artifact("AtomicArbitrage");
    const eighteen = await deploy(base, ["Settlement capital", "CAP"]);
    const other = await deploy(base, ["Other base", "OTHER"]);
    const weth = await deploy(wrapped);
    const harbor = await deploy(dex, ["Settlement market"]);
    const summit = await deploy(dex, ["Other market"]);
    const arbitrage = await deploy(arb);
    const precision = (await environment.fixtures("contracts/test/fixtures/PrecisionToken.sol")).PrecisionToken;
    const six = await deploy({ abi: precision.abi,
      bytecode: `0x${precision.evm.bytecode.object}` as `0x${string}` }, ["Six units", "SIX", 6]);
    const deployment: Deployment = {
      schemaVersion: 1, chainId: 31337, rpcUrl: environment.rpcUrl,
      tokens: [
        { address: eighteen, name: "Settlement capital", symbol: "CAP", kind: "faucet", decimals: 18 },
        { address: other, name: "Other base", symbol: "OTHER", kind: "faucet", decimals: 18 },
        { address: weth, name: "Wrapped Ether", symbol: "WETH", kind: "wrapped", decimals: 18 },
      ], exchanges: [{ address: harbor, name: "Settlement market" },
        { address: summit, name: "Other market" }],
      arbitrage, bytecodes: { TestToken: base.bytecode },
    };
    const client = new ExchangeClient(deployment);
    await client.verifyDeployment();
    const imported = await client.importToken(six);
    assert.equal(imported.decimals, 6);
    const tokens: Token[] = [...deployment.tokens, imported];
    const actor = accounts[1];
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
    await send(eighteen, base.abi, "faucet");
    await send(six, precision.abi, "mint", [accounts[0], parseUnits("10000", 6)]);
    await send(harbor, dex.abi, "createPool", [eighteen, six]);
    const initialPool = await activePool();
    for (const address of [eighteen, six]) await send(address, base.abi, "approve", [harbor, maxUint256]);
    const seed = [parseUnits("1000", 18), parseUnits("2000", 6)];
    const ordered = same(initialPool.token0, eighteen) ? seed : [seed[1], seed[0]];
    const latest = await read.getBlock();
    await send(harbor, dex.abi, "addLiquidity", [initialPool.id, ...ordered, 0n, 0n, latest.timestamp + 1200n]);
    await send(eighteen, base.abi, "transfer", [actor, parseUnits("100", 18)]);
    await send(six, precision.abi, "mint", [actor, parseUnits("200", 6)]);
    wallet = new WalletController(client, { storage: null });
    await wallet.start();
    wallet.dispatch({ kind: "select-local", address: actor });
    await until(() => wallet!.session(), value => !!value && same(value.address, actor), "settlement wallet");
    const tokenBalance = (token: string, blockNumber: bigint) => read.readContract({
      address: getAddress(token), abi: base.abi, functionName: "balanceOf",
      args: [actor], blockNumber,
    }) as Promise<bigint>;
    const native = (blockNumber: bigint) => read.getBalance({ address: actor, blockNumber });
    const quote = async (tokenIn: string, amount: string): Promise<RoutedSwapPlan> => {
      const snapshot = await client.snapshot(actor, tokens);
      const pool = snapshot.pools.find(p => same(p.exchange.address, harbor));
      assert(pool);
      const context = { tokens, pool, pools: snapshot.pools,
        exchanges: deployment.exchanges, balances: snapshot.balances,
        connected: true, pending: false, block: snapshot.block };
      const controller = createRoutedSwapController(pool.token0);
      controller.dispatch({ kind: "pay", value: tokenIn }, context);
      controller.dispatch({ kind: "amount", value: amount }, context);
      controller.dispatch({ kind: "slippage", value: "2" }, context);
      const effect = controller.dispatch({ kind: "submit" }, context).effect;
      assert(effect?.kind === "swap");
      assert(same(effect.inputToken, tokenIn));
      return effect;
    };
    const moveMarket = async (tokenIn: string, amountIn: bigint) => {
      const pool = await activePool();
      const block = await read.getBlock();
      return send(harbor, dex.abi, "swap", [pool.id, tokenIn, amountIn,
        0n, accounts[0], block.timestamp + 1200n]);
    };
    const execute = async (name: string, plan: RoutedSwapPlan,
      comparison: "same" | "more" | "less") => {
      const captured = { quoted: plan.quoted, minimum: plan.minimum, input: plan.input };
      const start = BigInt(await rpc("eth_blockNumber") as string);
      let result: SwapResult | undefined;
      const session = wallet!.session();
      assert(session);
      await wallet!.perform({ label: name, session, perform: async writer => {
        result = await writer.routedSwap(plan);
      } });
      assert(result);
      const receipt = result.receipt;
      assert.equal(receipt.status, "success");
      assert(same(receipt.from, actor));
      const event = parseEventLogs({ abi: dex.abi, eventName: "Swap", logs: receipt.logs })
        .find(log => same(log.address, harbor));
      assert(event);
      const args = event.args as { poolId: bigint; sender: string; tokenIn: string;
        amountIn: bigint; amountOut: bigint; recipient: string };
      assert(same(args.sender, actor) && same(args.recipient, actor));
      assert.equal(args.poolId, plan.pool.id);
      assert(same(args.tokenIn, plan.inputToken));
      assert.equal(args.amountIn, captured.input);
      assert.equal(result.amountIn, args.amountIn);
      assert.equal(result.amountOut, args.amountOut);
      assert.equal(plan.quoted, captured.quoted);
      assert.equal(plan.minimum, captured.minimum);
      assert.equal(result.quoted, captured.quoted);
      assert.equal(result.minimum, captured.minimum);
      assert(result.amountOut >= captured.minimum);
      const beforeBlock = receipt.blockNumber - 1n;
      const [inputBefore, inputAfter, outputBefore, outputAfter, ethBefore, ethAfter] = await Promise.all([
        tokenBalance(result.tokenIn, beforeBlock), tokenBalance(result.tokenIn, receipt.blockNumber),
        tokenBalance(result.tokenOut, beforeBlock), tokenBalance(result.tokenOut, receipt.blockNumber),
        native(beforeBlock), native(receipt.blockNumber),
      ]);
      const paid = inputBefore - inputAfter;
      const received = outputAfter - outputBefore;
      assert.equal(paid, result.amountIn);
      assert.equal(received, result.amountOut);
      const view = swapSettlementView(result, tokens);
      assert.equal(view.comparison, comparison);
      assert.equal(view.quoteDifference + captured.quoted, received,
        "Difference reconstructs actual received tokens from the captured quote");
      if (comparison === "same") assert.equal(received, captured.quoted);
      if (comparison === "more") assert(received > captured.quoted);
      if (comparison === "less") assert(received < captured.quoted);
      assert(view.executionPrice && !view.executionPrice.startsWith("<"));
      const inputPlaces = tokens.find(t => same(t.address, result!.tokenIn))!.decimals;
      const outputPlaces = tokens.find(t => same(t.address, result!.tokenOut))!.decimals;
      const displayed = parseUnits(view.executionPrice, 8);
      const denominator = paid * 10n ** BigInt(outputPlaces);
      const numerator = received * 10n ** BigInt(inputPlaces) * 10n ** 8n;
      assert(displayed * denominator <= numerator && numerator < (displayed + 1n) * denominator,
        "Displayed price brackets the actual human-unit receive/pay ratio within one display quantum");
      const transaction = await read.getTransaction({ hash: receipt.transactionHash });
      assert.equal(transaction.value, 0n);
      const block = await read.getBlock({ blockNumber: receipt.blockNumber });
      assert.deepEqual(block.transactions, [receipt.transactionHash]);
      assert.equal(result.gasCostWei, ethBefore - ethAfter,
        "Execution fee equals the actual ETH debit in the swap block, excluding approvals");
      const entry = await until(() => wallet!.kernel.getSnapshot().journal.find(row =>
        row.state === "confirmed" && same(row.hash, receipt.transactionHash)),
      row => !!row, "confirmed swap journal");
      assert(entry && entry.state === "confirmed");
      assert.equal(BigInt(entry.gas), result.gasCostWei);
      const approvalReceipts = [];
      for (let n = start + 1n; n < receipt.blockNumber; n++) {
        const earlier = await read.getBlock({ blockNumber: n });
        for (const hash of earlier.transactions) {
          const approvalReceipt = await read.getTransactionReceipt({ hash });
          const approvals = parseEventLogs({ abi: base.abi, eventName: "Approval", logs: approvalReceipt.logs });
          assert(approvals.some(log => {
            const fields = log.args as { owner: string; spender: string };
            return same(fields.owner, actor) && same(fields.spender, harbor);
          }), "The caller's preceding transactions in this window are actual ERC20 approvals");
          approvalReceipts.push(approvalReceipt);
        }
      }
      assert(approvalReceipts.length > 0);
      assert(await native(start) - ethAfter > result.gasCostWei,
        "The operation's overall debit also contains the separately paid approval fees");
      evidence[name] = { captured, plan, result, view, paid, received, ethBefore, ethAfter,
        approvalReceipts, journalFeeWei: entry.gas };
      scenarios.push(name);
    };
    await execute("Unchanged mixed-decimal market settles at the captured quote", await quote(six, "2.75"), "same");
    const improved = await quote(six, "3.125");
    await moveMarket(eighteen, parseUnits("1", 18));
    await execute("Opposite market trade improves receipt output without replacing the quote", improved, "more");
    const worse = await quote(eighteen, "1.125");
    await moveMarket(eighteen, parseUnits("0.5", 18));
    await execute("Same-direction market trade worsens output within the captured minimum", worse, "less");
    assert.deepEqual(await fingerprints(), sources, "Accepted source and kernel fingerprints remain frozen");
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
