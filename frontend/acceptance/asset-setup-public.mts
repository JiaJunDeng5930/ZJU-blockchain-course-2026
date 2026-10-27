import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  parseEventLogs,
  parseEther,
  zeroAddress,
  type Address,
  type TransactionReceipt,
} from "viem";
import { ExchangeClient } from "../src/chain/client";
import type { Deployment, Token } from "../src/chain/types";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, root, until } from "./support/chain.mts";

const same = (left: string, right: string) =>
  getAddress(left) === getAddress(right);
const serialize = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
const sourceFiles = [
  "frontend/src/generated/dex_logic.js",
  "frontend/src/chain/client.ts",
  "frontend/src/chain/assets.ts",
  "frontend/src/chain/wrapping.ts",
  "frontend/src/logic/assets.ts",
  "frontend/src/logic/wrapping.ts",
  "frontend/src/wallet/session.ts",
  "frontend/acceptance/asset-setup-public.mts",
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
const environment = await isolatedChain("asset-setup-public");
const { directory, accounts, rpc, read, artifact, deploy } = environment;
const scenarios: { scenario: string; outcome: string }[] = [];
const evidence: Record<string, unknown> = {
  status: "running",
  kernelSha256,
  sourceFingerprints,
  scenarios,
};
let wallet: WalletController | undefined;
const scenario = async (name: string, run: () => Promise<void>) => {
  await run();
  scenarios.push({ scenario: name, outcome: "passed" });
};
const quantity = async (method: string, params: unknown[]) =>
  BigInt((await rpc(method, params)) as string);
const blockNumber = () => quantity("eth_blockNumber", []);
const accountState = async (address: Address) => ({
  native: await quantity("eth_getBalance", [address, "latest"]),
  nonce: await quantity("eth_getTransactionCount", [address, "latest"]),
});
const tokenBalance = (token: string, account: Address) =>
  read.readContract({
    address: getAddress(token),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
const receiptsSince = async (start: bigint, sender: Address) => {
  const receipts: TransactionReceipt[] = [];
  const end = await blockNumber();
  for (let number = start + 1n; number <= end; number++) {
    const block = await read.getBlock({
      blockNumber: number,
      includeTransactions: true,
    });
    for (const transaction of block.transactions) {
      if (same(transaction.from, sender)) {
        receipts.push(
          await read.getTransactionReceipt({ hash: transaction.hash }),
        );
      }
    }
  }
  return receipts;
};
const poolEvents = parseAbi([
  "event PoolCreated(uint256 indexed poolId,address indexed token0,address indexed token1)",
]);

try {
  const testToken = await artifact("TestToken");
  const wrapped = await artifact("WrappedEther");
  const baseA = await deploy(testToken, ["Setup A", "STA"]);
  const baseB = await deploy(testToken, ["Setup B", "STB"]);
  const weth = await deploy(wrapped);
  const first = await deploy(await artifact("MiniDEX"), ["Setup DEX A"]);
  const second = await deploy(await artifact("MiniDEX"), ["Setup DEX B"]);
  const arbitrage = await deploy(await artifact("AtomicArbitrage"));
  const deployment: Deployment = {
    schemaVersion: 1,
    chainId: 31337,
    rpcUrl: environment.rpcUrl,
    tokens: [
      {
        address: baseA,
        name: "Setup A",
        symbol: "STA",
        kind: "faucet",
        decimals: 18,
      },
      {
        address: baseB,
        name: "Setup B",
        symbol: "STB",
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
      { address: first, name: "Setup DEX A" },
      { address: second, name: "Setup DEX B" },
    ],
    arbitrage,
    bytecodes: { TestToken: testToken.bytecode },
  };
  const client = new ExchangeClient(deployment);
  await client.verifyDeployment();
  wallet = new WalletController(client, { storage: null });
  await wallet.start();
  const controller = wallet;
  const owner = accounts[1];
  const other = accounts[2];
  const select = async (address: Address) => {
    controller.dispatch({ kind: "select-local", address });
    await until(
      () => controller.session(),
      (session) => !!session && same(session.address, address),
      "selected asset-setup wallet",
    );
  };
  const perform = (
    label: string,
    action: Parameters<WalletController["perform"]>[0]["perform"],
  ) => {
    const session = controller.session();
    assert(session);
    return controller.perform({ label, session, perform: action });
  };
  await select(owner);
  const base = deployment.tokens[0];
  await scenario(
    "Unfunded wallets prepare native gas and claim only their own ERC20",
    async () => {
      await rpc("hardhat_setBalance", [owner, "0x0"]);
      await rpc("hardhat_setBalance", [other, "0x0"]);
      const before = await accountState(owner);
      const beforeBlock = await blockNumber();
      assert.equal(before.native, 0n);
      assert.equal(await tokenBalance(base.address, owner), 0n);
      await perform("Claim setup ETH", (writer) => writer.claimEther());
      const funded = await accountState(owner);
      assert(funded.native > 0n);
      assert.equal(funded.nonce, before.nonce);
      assert.equal((await receiptsSince(beforeBlock, owner)).length, 0);
      assert.equal((await accountState(other)).native, 0n);
      await perform("Claim setup token", (writer) => writer.faucet(base));
      assert.equal(
        await tokenBalance(base.address, owner),
        parseEther("10000"),
      );
      assert.equal(await tokenBalance(base.address, other), 0n);
      await select(other);
      await perform("Prepare second wallet ETH", (writer) =>
        writer.claimEther(),
      );
      await perform("Second wallet token claim", (writer) =>
        writer.faucet(base),
      );
      assert.equal(
        await tokenBalance(base.address, other),
        parseEther("10000"),
      );
      assert.equal(
        await tokenBalance(base.address, owner),
        parseEther("10000"),
      );
      evidence.funding = {
        before,
        funded,
        other: await accountState(other),
        ownerToken: await tokenBalance(base.address, owner),
        otherToken: await tokenBalance(base.address, other),
      };
      await select(owner);
    },
  );

  let created!: Token;
  await scenario(
    "Created tokens start with zero supply and read-only import preserves identity",
    async () => {
      const start = await blockNumber();
      await perform("Create setup token", async (writer) => {
        const confirmation = await writer.createToken("Prepared Asset", "PREP");
        created = await client.importToken(confirmation.address);
      });
      assert(created);
      const receipts = await receiptsSince(start, owner);
      assert.equal(receipts.length, 1);
      const receipt = receipts[0];
      assert.equal(receipt.status, "success");
      assert(receipt.contractAddress);
      assert(same(receipt.contractAddress, created.address));
      assert.equal(created.name, "Prepared Asset");
      assert.equal(created.symbol, "PREP");
      assert.equal(created.decimals, 18);
      assert.equal(created.kind, "faucet");
      assert.equal(
        await read.readContract({
          address: getAddress(created.address),
          abi: erc20Abi,
          functionName: "name",
        }),
        created.name,
      );
      assert.equal(
        await read.readContract({
          address: getAddress(created.address),
          abi: erc20Abi,
          functionName: "symbol",
        }),
        created.symbol,
      );
      assert.equal(
        await read.readContract({
          address: getAddress(created.address),
          abi: erc20Abi,
          functionName: "decimals",
        }),
        18,
      );
      assert.equal(
        await read.readContract({
          address: getAddress(created.address),
          abi: erc20Abi,
          functionName: "totalSupply",
        }),
        0n,
      );
      assert.equal(await tokenBalance(created.address, owner), 0n);
      const beforeImport = await accountState(owner);
      const importBlock = await blockNumber();
      const imported = await client.importToken(created.address);
      assert(same(imported.address, created.address));
      assert.equal(imported.name, created.name);
      assert.equal(imported.symbol, created.symbol);
      assert.equal(imported.decimals, created.decimals);
      assert.deepEqual(await accountState(owner), beforeImport);
      assert.equal(await blockNumber(), importBlock);
      await perform("Fund created setup token", (writer) =>
        writer.faucet(created),
      );
      assert.equal(
        await tokenBalance(created.address, owner),
        parseEther("10000"),
      );
      assert.equal(await tokenBalance(created.address, other), 0n);
      evidence.createdToken = {
        created,
        imported,
        creationReceipt: receipt,
        initialSupply: "0",
        afterClaim: await tokenBalance(created.address, owner),
      };
    },
  );

  await scenario(
    "The selected DEX receives the correct new empty pool without minting a position",
    async () => {
      const start = await blockNumber();
      const tokens = [...deployment.tokens, created];
      const before = await client.snapshot(owner, tokens);
      await perform("Create setup pool on second DEX", (writer) =>
        writer.createPool(second, created.address, weth),
      );
      const receipts = await receiptsSince(start, owner);
      assert.equal(receipts.length, 1);
      const receipt = receipts[0];
      assert.equal(receipt.status, "success");
      const events = parseEventLogs({
        abi: poolEvents,
        logs: receipt.logs,
        eventName: "PoolCreated",
      }).filter((event) => same(event.address, second));
      assert.equal(events.length, 1);
      const event = events[0];
      assert(
        [event.args.token0, event.args.token1].some((address) =>
          same(address, created.address),
        ),
      );
      assert(
        [event.args.token0, event.args.token1].some((address) =>
          same(address, weth),
        ),
      );
      assert(BigInt(event.args.token0) < BigInt(event.args.token1));
      const after = await client.snapshot(owner, tokens);
      const pool = after.pools.find(
        (candidate) =>
          same(candidate.exchange.address, second) &&
          candidate.id === event.args.poolId,
      );
      assert(pool);
      assert(same(pool.token0, event.args.token0));
      assert(same(pool.token1, event.args.token1));
      assert.equal(pool.reserve0, 0n);
      assert.equal(pool.reserve1, 0n);
      assert.equal(pool.totalShares, 0n);
      assert.equal(
        after.pools.filter((candidate) =>
          same(candidate.exchange.address, first),
        ).length,
        before.pools.filter((candidate) =>
          same(candidate.exchange.address, first),
        ).length,
      );
      assert.equal(after.positions.length, before.positions.length);
      assert.equal(
        await tokenBalance(created.address, owner),
        parseEther("10000"),
      );
      assert.equal(await tokenBalance(weth, owner), 0n);
      evidence.createdPool = {
        receipt,
        event,
        pool,
        positions: after.positions.length,
      };
    },
  );

  await scenario(
    "Wrapping and unwrapping conserve native value and reject transactions without gas",
    async () => {
      const amount = parseEther("1");
      const before = await accountState(owner);
      const beforeWeth = await tokenBalance(weth, owner);
      const start = await blockNumber();
      await perform("Wrap setup ETH", (writer) => writer.wrap(amount, false));
      const wrappedReceipts = await receiptsSince(start, owner);
      assert.equal(wrappedReceipts.length, 1);
      const depositReceipt = wrappedReceipts[0];
      assert.equal(depositReceipt.status, "success");
      const deposit = await read.getTransaction({
        hash: depositReceipt.transactionHash,
      });
      assert(deposit.to && same(deposit.to, weth));
      assert.equal(deposit.value, amount);
      assert.equal(
        decodeFunctionData({ abi: wrapped.abi, data: deposit.input })
          .functionName,
        "deposit",
      );
      const minted = parseEventLogs({
        abi: erc20Abi,
        logs: depositReceipt.logs,
        eventName: "Transfer",
      }).filter(
        (event) =>
          same(event.address, weth) &&
          same(event.args.from, zeroAddress) &&
          same(event.args.to, owner),
      );
      assert.equal(minted.length, 1);
      assert.equal(minted[0].args.value, amount);
      const after = await accountState(owner);
      assert.equal(await tokenBalance(weth, owner), beforeWeth + amount);
      assert.equal(
        before.native - after.native,
        amount + depositReceipt.gasUsed * depositReceipt.effectiveGasPrice,
      );
      assert(after.native > 0n);
      assert.equal(after.nonce, before.nonce + 1n);

      const insufficientGas: Record<string, unknown>[] = [];
      for (const [label, value, withdraw] of [
        ["Wrap entire native balance", after.native, false],
        ["Unwrap without native gas", amount, true],
      ] as const) {
        if (withdraw) await rpc("hardhat_setBalance", [owner, "0x0"]);
        const beforeRejected = await accountState(owner);
        const tokenBeforeRejected = await tokenBalance(weth, owner);
        const rejectedBlock = await blockNumber();
        const result: { error?: string; succeeded: boolean } = {
          succeeded: false,
        };
        const outerError = await perform(label, async (writer) => {
          try {
            await writer.wrap(value, withdraw);
            result.succeeded = true;
          } catch (error) {
            result.error =
              error instanceof Error ? error.message : String(error);
            throw error;
          }
        }).then(
          () => null,
          (error: unknown) =>
            error instanceof Error ? error.message : String(error),
        );
        assert(result.error);
        assert.equal(outerError, result.error);
        assert.equal(result.succeeded, false);
        assert(controller.kernel.getSnapshot().error);
        assert.equal(controller.kernel.getSnapshot().pending, false);
        assert.deepEqual(await accountState(owner), beforeRejected);
        assert.equal(await tokenBalance(weth, owner), tokenBeforeRejected);
        assert.equal(await blockNumber(), rejectedBlock);
        insufficientGas.push({
          label,
          ...result,
          account: beforeRejected,
          weth: tokenBeforeRejected,
        });
      }
      await perform("Restore unwrap gas", (writer) => writer.claimEther());
      const beforeWithdraw = await accountState(owner);
      const withdrawAmount = parseEther("0.25");
      const withdrawStart = await blockNumber();
      await perform("Unwrap setup WETH", (writer) =>
        writer.wrap(withdrawAmount, true),
      );
      const withdrawReceipts = await receiptsSince(withdrawStart, owner);
      assert.equal(withdrawReceipts.length, 1);
      const withdrawalReceipt = withdrawReceipts[0];
      assert.equal(withdrawalReceipt.status, "success");
      const withdrawal = await read.getTransaction({
        hash: withdrawalReceipt.transactionHash,
      });
      const decodedWithdrawal = decodeFunctionData({
        abi: wrapped.abi,
        data: withdrawal.input,
      });
      assert(withdrawal.to && same(withdrawal.to, weth));
      assert.equal(withdrawal.value, 0n);
      assert.equal(decodedWithdrawal.functionName, "withdraw");
      assert.deepEqual(decodedWithdrawal.args, [withdrawAmount]);
      const burned = parseEventLogs({
        abi: erc20Abi,
        logs: withdrawalReceipt.logs,
        eventName: "Transfer",
      }).filter(
        (event) =>
          same(event.address, weth) &&
          same(event.args.from, owner) &&
          same(event.args.to, zeroAddress),
      );
      assert.equal(burned.length, 1);
      assert.equal(burned[0].args.value, withdrawAmount);
      const afterWithdraw = await accountState(owner);
      assert.equal(await tokenBalance(weth, owner), amount - withdrawAmount);
      assert.equal(
        afterWithdraw.native - beforeWithdraw.native,
        withdrawAmount -
          withdrawalReceipt.gasUsed * withdrawalReceipt.effectiveGasPrice,
      );
      assert.equal(afterWithdraw.nonce, beforeWithdraw.nonce + 1n);
      assert.equal(await tokenBalance(weth, other), 0n);
      evidence.wrapping = {
        before,
        after,
        depositReceipt,
        insufficientGas,
        beforeWithdraw,
        afterWithdraw,
        withdrawalReceipt,
        remainingWeth: await tokenBalance(weth, owner),
      };
    },
  );

  assert.deepEqual(
    await fingerprints(),
    sourceFingerprints,
    "Public SDK inputs changed during acceptance",
  );
  evidence.status = "passed";
  await writeFile(resolve(directory, "result.json"), serialize(evidence));
  console.log(
    JSON.stringify({
      status: "passed",
      scenarios: scenarios.length,
      kernelSha256,
      evidence: resolve(directory, "result.json"),
    }),
  );
} catch (error) {
  evidence.status = "failed";
  evidence.error = error instanceof Error ? error.stack : String(error);
  await writeFile(resolve(directory, "result.json"), serialize(evidence));
  throw error;
} finally {
  wallet?.stop();
  await environment.close();
}
