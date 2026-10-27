import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { getAddress, parseEventLogs, parseUnits, zeroAddress, type TransactionReceipt } from "viem";
import { ExchangeClient } from "../src/chain/client";
import type { Deployment, LiquidityConfirmation, Token, WrappingConfirmation } from "../src/chain/types";
import { positionView } from "../src/logic/liquidity";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, root, until } from "./support/chain.mts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) => JSON.stringify(value,
  (_key, v) => typeof v === "bigint" ? v.toString() : v, 2);

async function main() {
  const env = await isolatedChain("wrapping-settlement-public");
  const { directory, deploy, artifact, read, accounts, rpc } = env;
  let wallet: WalletController | undefined;
  let armReceiptFor: string | undefined;
  let unavailableReads = false;
  let rejectedReads = 0;
  const proxy = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      const items = Array.isArray(input) ? input : [input];
      if (unavailableReads && items.some(item => ["eth_call", "eth_getBalance"].includes(item.method))) {
        rejectedReads++;
        const error = (item: { id: unknown }) => ({ jsonrpc: "2.0", id: item.id,
          error: { code: -32000, message: "Wrapping balance observation temporarily unavailable" } });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(Array.isArray(input) ? items.map(error) : error(input)));
        return;
      }
      const upstream = await fetch(env.rpcUrl, { method: "POST",
        headers: { "content-type": "application/json" }, body });
      const output = await upstream.text();
      if (armReceiptFor && items.some(item => item.method === "eth_getTransactionReceipt")) {
        const decoded = JSON.parse(output);
        const responses = Array.isArray(decoded) ? decoded : [decoded];
        if (responses.some(item => item.result?.status === "0x1" && item.result.to && same(item.result.to, armReceiptFor!))) {
          unavailableReads = true;
          armReceiptFor = undefined;
        }
      }
      response.writeHead(upstream.status, { "content-type": "application/json" });
      response.end(output);
    } catch (error) {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(String(error));
    }
  });
  await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
  const address = proxy.address();
  assert(address && typeof address !== "string");
  const scenarios: string[] = [];
  const evidence: Record<string, unknown> = {};
  const fingerprints = async () => Object.fromEntries(await Promise.all([
    "frontend/src/generated/dex_logic.js", "frontend/src/chain/client.ts",
    "frontend/src/chain/wrapping.ts", "frontend/src/chain/types.ts",
    "frontend/src/logic/wrappingSettlement.ts", "frontend/src/logic/receipts.ts",
    "frontend/src/wallet/session.ts",
  ].map(async file => [file, createHash("sha256").update(await readFile(resolve(root, file))).digest("hex")])));
  let sources: Record<string, string> = {};
  try {
    sources = await fingerprints();
    if (process.env.DEX_EXPECTED_KERNEL_SHA256)
      assert.equal(sources["frontend/src/generated/dex_logic.js"], process.env.DEX_EXPECTED_KERNEL_SHA256);
    const base = await artifact("TestToken");
    const wrapped = await artifact("WrappedEther");
    const dex = await artifact("MiniDEX");
    const arb = await artifact("AtomicArbitrage");
    const first = await deploy(base, ["Wrapping base", "BASE"]);
    const second = await deploy(base, ["Other base", "OTHER"]);
    const weth = await deploy(wrapped);
    const harbor = await deploy(dex, ["Wrapped asset market"]);
    const summit = await deploy(dex, ["Other market"]);
    const arbitrage = await deploy(arb);
    const precision = (await env.fixtures("contracts/test/fixtures/PrecisionToken.sol")).PrecisionToken;
    const six = await deploy({ abi: precision.abi,
      bytecode: `0x${precision.evm.bytecode.object}` as `0x${string}` }, ["Six units", "SIX", 6]);
    const deployment: Deployment = {
      schemaVersion: 1, chainId: 31337, rpcUrl: `http://127.0.0.1:${address.port}`,
      tokens: [
        { address: first, name: "Wrapping base", symbol: "BASE", kind: "faucet", decimals: 18 },
        { address: second, name: "Other base", symbol: "OTHER", kind: "faucet", decimals: 18 },
        { address: weth, name: "Wrapped Ether", symbol: "WETH", kind: "wrapped", decimals: 18 },
      ],
      exchanges: [{ address: harbor, name: "Wrapped asset market" }, { address: summit, name: "Other market" }],
      arbitrage, bytecodes: { TestToken: base.bytecode },
    };
    const client = new ExchangeClient(deployment);
    await client.verifyDeployment();
    const imported = await client.importToken(six);
    assert.equal(imported.decimals, 6);
    const tokens: Token[] = [...deployment.tokens, imported];
    const actor = accounts[1];
    wallet = new WalletController(client, { storage: null });
    await wallet.start();
    wallet.dispatch({ kind: "select-local", address: actor });
    await until(() => wallet!.session(), value => !!value && same(value.address, actor), "selected wrapping actor");
    const perform = async (label: string, action: Parameters<WalletController["perform"]>[0]["perform"]) => {
      const session = wallet!.session();
      assert(session);
      await wallet!.perform({ label, session, perform: action });
    };
    const performWrap = async (amount: bigint, withdraw: boolean) => {
      unavailableReads = false;
      armReceiptFor = weth;
      let result: WrappingConfirmation | undefined;
      await perform(withdraw ? "Unwrap confirmed WETH" : "Wrap native ETH", async writer => {
        result = await writer.wrap(amount, withdraw);
      });
      assert(result);
      assert(unavailableReads, "RPC balance reads become unavailable after the successful wrapping receipt");
      return result;
    };
    const native = (blockNumber: bigint) => read.getBalance({ address: getAddress(actor), blockNumber });
    const wethBalance = (blockNumber: bigint) => read.readContract({ address: weth, abi: wrapped.abi,
      functionName: "balanceOf", args: [actor], blockNumber }) as Promise<bigint>;
    const checkWrapping = async (result: WrappingConfirmation, withdraw: boolean) => {
      const receipt = result.receipt;
      assert.equal(receipt.status, "success");
      assert.equal(result.kind, withdraw ? "unwrap" : "wrap");
      assert(same(result.token, weth) && same(result.owner, actor) && same(receipt.from, actor));
      assert(receipt.to && same(receipt.to, weth));
      const block = receipt.blockNumber;
      const [ethBefore, ethAfter, wethBefore, wethAfter, transaction, executionBlock] = await Promise.all([
        native(block - 1n), native(block), wethBalance(block - 1n), wethBalance(block),
        read.getTransaction({ hash: receipt.transactionHash }), read.getBlock({ blockNumber: block }),
      ]);
      assert.deepEqual(executionBlock.transactions, [receipt.transactionHash]);
      const transfer = parseEventLogs({ abi: wrapped.abi, eventName: "Transfer", logs: receipt.logs })
        .find(event => same(event.address, weth));
      assert(transfer);
      const args = transfer.args as { from: string; to: string; value: bigint };
      assert(same(args.from, withdraw ? actor : zeroAddress));
      assert(same(args.to, withdraw ? zeroAddress : actor));
      assert.equal(result.amount, args.value);
      assert.equal(transaction.value, withdraw ? 0n : args.value);
      assert.equal(result.nativeChangeWei, ethAfter - ethBefore,
        "Native effect is checked against historical account balances, not an estimated fee budget");
      assert.equal(result.wrappedChange, wethAfter - wethBefore);
      const entry = await until(() => wallet!.kernel.getSnapshot().journal.find(row =>
        row.state === "confirmed" && same(row.hash, receipt.transactionHash)), row => !!row, "confirmed wrapping journal entry");
      assert(entry && entry.state === "confirmed");
      assert.equal(result.gasCostWei, BigInt(entry.gas));
      const observedFee = withdraw ? args.value - (ethAfter - ethBefore) : ethBefore - ethAfter - transaction.value;
      assert.equal(result.gasCostWei, observedFee,
        "The observed native transfer principal is separated from the actual sender debit");
      assert(result.gasCostWei > 0n);
      assert.equal(parseEventLogs({ abi: wrapped.abi, eventName: "Approval", logs: receipt.logs }).length, 0);
      return { result, transaction, ethBefore, ethAfter, wethBefore, wethAfter, journalFeeWei: entry.gas };
    };

    const wrappedResult = await performWrap(parseUnits("2.75", 18), false);
    // The next public write follows immediately, without an observer RPC or a timing workaround.
    const tiny = await performWrap(1n, true);
    assert.equal(tiny.receipt.blockNumber, wrappedResult.receipt.blockNumber + 1n);
    evidence.wrap = await checkWrapping(wrappedResult, false);
    scenarios.push("Wrapping returns actual principal and value-plus-fee effects even when post-receipt reads fail");
    evidence.tinyUnwrap = await checkWrapping(tiny, true);
    assert.equal(tiny.amount, 1n);
    assert(tiny.nativeChangeWei < 0n, "Tiny gross ETH release can still leave a net ETH debit after gas");
    scenarios.push("An immediate one-wei unwrap uses freshly wrapped funds and reports its negative net native effect");

    unavailableReads = false;
    await env.admin.writeContract({ address: six, abi: precision.abi, functionName: "mint", args: [actor, parseUnits("1000", 6)] })
      .then(hash => read.waitForTransactionReceipt({ hash }));
    let created: Awaited<ReturnType<ReturnType<ExchangeClient["writer"]>["createPool"]>> | undefined;
    await perform("Create six-decimal token / WETH pool", async writer => {
      created = await writer.createPool(harbor, six, weth);
    });
    assert(created);
    const currentBlock = Number(BigInt(await rpc("eth_blockNumber") as string));
    const pool = (await client.pools(currentBlock)).find(p => same(p.exchange.address, harbor) && p.id === created!.poolId);
    assert(pool);
    const desired = same(pool.token0, six)
      ? [parseUnits("250", 6), parseUnits("0.5", 18)] as const
      : [parseUnits("0.5", 18), parseUnits("250", 6)] as const;
    let minted: LiquidityConfirmation | undefined;
    await perform("Add wrapped native liquidity", async writer => {
      minted = await writer.addLiquidity(pool, desired[0], desired[1], 50n);
    });
    assert(minted && minted.kind === "deposit");
    assert(same(await read.readContract({ address: harbor, abi: dex.abi, functionName: "ownerOf", args: [minted.positionId] }) as string, actor));
    const snapshot = await until(() => client.snapshot(actor, tokens), s =>
      s.positions.some(p => same(p.exchange.address, harbor) && p.id === minted!.positionId), "minted WETH pool position");
    const position = snapshot.positions.find(p => same(p.exchange.address, harbor) && p.id === minted!.positionId)!;
    const observedPool = snapshot.pools.find(p => same(p.exchange.address, harbor) && p.id === position.poolId)!;
    const amounts = positionView(observedPool, position).amounts;
    let redeemed: LiquidityConfirmation | undefined;
    await perform("Redeem WETH liquidity NFT", async writer => {
      redeemed = await writer.removeLiquidity(observedPool, position.id, amounts, 50n);
    });
    assert(redeemed && redeemed.kind === "redeem");
    const rb = redeemed.receipt.blockNumber;
    const wethReceived = await wethBalance(rb) - await wethBalance(rb - 1n);
    const reportedWeth = same(observedPool.token0, weth) ? redeemed.amount0 : redeemed.amount1;
    assert.equal(wethReceived, reportedWeth);
    assert(wethReceived > 0n);
    assert.equal(await native(rb) - await native(rb - 1n), -redeemed.gasCostWei,
      "Redeeming this ERC20 pool returns WETH; it does not unwrap into native ETH");
    const otherReceived = await read.readContract({ address: six, abi: precision.abi, functionName: "balanceOf", args: [actor], blockNumber: rb }) as bigint;
    const otherBefore = await read.readContract({ address: six, abi: precision.abi, functionName: "balanceOf", args: [actor], blockNumber: rb - 1n }) as bigint;
    assert.equal(otherReceived - otherBefore, same(observedPool.token0, six) ? redeemed.amount0 : redeemed.amount1);
    await assert.rejects(read.readContract({ address: harbor, abi: dex.abi, functionName: "ownerOf", args: [position.id] }));
    evidence.pool = { created, minted, redeemed, wethReceived, otherReceived, otherBefore };
    scenarios.push("Wrapped ETH funds a mixed-precision AMM pool, mints an NFT and returns WETH when that NFT is redeemed");

    const released = await performWrap(wethReceived, true);
    assert.equal(released.amount, wethReceived);
    evidence.redeemedUnwrap = await checkWrapping(released, true);
    assert(released.nativeChangeWei > 0n);
    scenarios.push("WETH recovered from liquidity can be unwrapped into native ETH with a separately observed execution fee");
    assert.equal(rejectedReads, 0, "No wrapping confirmation depends on balance or metadata reads after its receipt");
    assert.deepEqual(await fingerprints(), sources, "The accepted public adapters and kernel stayed frozen");
    await writeFile(resolve(directory, "result.json"), json({ status: "passed",
      kernelSha256: sources["frontend/src/generated/dex_logic.js"], sourceFingerprints: sources, scenarios, evidence }));
    console.log(json({ status: "passed", scenarios: scenarios.length, result: resolve(directory, "result.json") }));
  } catch (error) {
    await writeFile(resolve(directory, "result.json"), json({ status: "failed",
      kernelSha256: sources["frontend/src/generated/dex_logic.js"], sourceFingerprints: sources,
      scenarios, evidence, rejectedReads, error: error instanceof Error ? error.stack : String(error) }));
    throw error;
  } finally {
    wallet?.stop();
    proxy.closeAllConnections();
    await new Promise<void>(done => proxy.close(() => done()));
    await env.close();
  }
}
await main();
