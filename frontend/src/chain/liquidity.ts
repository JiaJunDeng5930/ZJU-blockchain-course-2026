import { importAsset } from "./assets";
import { executionFeeWei } from "../logic/receipts";
import { assertSupportedPool } from "../logic/assets";
import {
  getAddress,
  parseEventLogs,
  zeroAddress,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { selectLiquidityReceipt } from "../logic/liquidityReceipt";
import { miniDexAbi, testTokenAbi } from "../generated/abis";
import {
  prepareDepositWrite,
  prepareWithdrawWrite,
  prepareTransfer,
} from "../logic/liquidity";
import type { ExchangeClient, SendTransaction } from "./client";
import type { WalletSession } from "../wallet/session";
import type {
  LiquidityConfirmation,
  LiquidityReceiptDetails,
  Pool,
} from "./types";

type LiquidityLog =
  | {
      eventName: "LiquidityAdded";
      args: {
        poolId: bigint;
        positionId: bigint;
        provider: string;
        amount0: bigint;
        amount1: bigint;
        shares: bigint;
      };
    }
  | {
      eventName: "LiquidityRemoved";
      args: {
        poolId: bigint;
        positionId: bigint;
        owner: string;
        amount0: bigint;
        amount1: bigint;
        shares: bigint;
      };
    }
  | {
      eventName: "Transfer";
      args: { tokenId: bigint; from: string; to: string };
    };

function confirmationFromEvent(
  pool: Pool,
  receipt: TransactionReceipt,
  event: LiquidityLog,
): LiquidityConfirmation {
  const common = { pool, receipt, gasCostWei: executionFeeWei(receipt) };
  switch (event.eventName) {
    case "LiquidityAdded":
      return {
        ...common,
        kind: "deposit",
        positionId: event.args.positionId,
        owner: event.args.provider,
        amount0: event.args.amount0,
        amount1: event.args.amount1,
        shares: event.args.shares,
      };
    case "LiquidityRemoved":
      return {
        ...common,
        kind: "redeem",
        positionId: event.args.positionId,
        owner: event.args.owner,
        amount0: event.args.amount0,
        amount1: event.args.amount1,
        shares: event.args.shares,
      };
    case "Transfer":
      return {
        ...common,
        kind: "transfer",
        positionId: event.args.tokenId,
        from: event.args.from,
        to: event.args.to,
      };
  }
}

export async function readLiquidityReceipt(
  client: ExchangeClient,
  hash: Hex,
): Promise<LiquidityReceiptDetails | null> {
  return liquidityReceiptFromReceipt(
    client,
    await client.rpc.getTransactionReceipt({ hash }),
  );
}

export async function liquidityReceiptFromReceipt(
  client: ExchangeClient,
  receipt: TransactionReceipt,
): Promise<LiquidityReceiptDetails | null> {
  const events = parseEventLogs({
    abi: miniDexAbi,
    eventName: ["LiquidityAdded", "LiquidityRemoved", "Transfer"],
    logs: receipt.logs,
  });
  const kinds = {
    LiquidityAdded: "deposit",
    LiquidityRemoved: "redeem",
    Transfer: "transfer",
  } as const;
  const selection = selectLiquidityReceipt(
    receipt.status === "success",
    client.deployment.exchanges.map((exchange) =>
      getAddress(exchange.address).toLowerCase(),
    ),
    events.map((event, index) => ({
      index,
      exchange: getAddress(event.address).toLowerCase(),
      kind: kinds[event.eventName],
      from:
        event.eventName === "Transfer"
          ? event.args.from.toLowerCase()
          : zeroAddress,
      to:
        event.eventName === "Transfer"
          ? event.args.to.toLowerCase()
          : zeroAddress,
    })),
  );
  switch (selection.kind) {
    case "none":
      return null;
    case "reverted":
      // DEFENSE: a caller can request a genuine reverted transaction hash.
      throw new Error(
        "The transaction reverted and has no confirmed liquidity result.",
      );
    case "multiple":
      // DEFENSE: a contract recipient can execute another liquidity action in its ERC721 callback.
      throw new Error(
        "This receipt contains multiple liquidity actions; a single position result cannot represent it.",
      );
  }
  const event = events[selection.index]!;
  const address = getAddress(event.address);
  const exchange = client.deployment.exchanges.find(
    (item) => getAddress(item.address) === address,
  )!;
  const blockNumber = receipt.blockNumber;
  // A later transaction in the same block may already have burned this NFT.
  // Its indexed mint event preserves the pool identity independently of positions storage.
  const poolId =
    event.eventName === "Transfer"
      ? (
          await client.rpc.getContractEvents({
            address,
            abi: miniDexAbi,
            eventName: "LiquidityAdded",
            args: { positionId: event.args.tokenId },
            fromBlock: 0n,
            toBlock: blockNumber,
            strict: true,
          })
        )[0]!.args.poolId
      : event.args.poolId;
  const [token0, token1, reserve0, reserve1, totalShares, createdAt] =
    await client.rpc.readContract({
      address,
      abi: miniDexAbi,
      functionName: "pools",
      args: [poolId],
      blockNumber,
    });
  const pool: Pool = {
    exchange,
    id: poolId,
    token0,
    token1,
    reserve0,
    reserve1,
    totalShares,
    createdAt,
  };
  const tokens = await Promise.all([
    importAsset(client, token0, blockNumber),
    importAsset(client, token1, blockNumber),
  ]);
  return { confirmation: confirmationFromEvent(pool, receipt, event), tokens };
}

async function verifyPoolAssets(client: ExchangeClient, pool: Pool) {
  const assets = await Promise.all([
    importAsset(client, pool.token0),
    importAsset(client, pool.token1),
  ]);
  assertSupportedPool(pool, assets);
}

type Context = {
  client: ExchangeClient;
  session: WalletSession;
  send: SendTransaction;
};
export async function addLiquidity(
  context: Context,
  pool: Pool,
  amount0: bigint,
  amount1: bigint,
  slippage: bigint,
): Promise<LiquidityConfirmation> {
  const { client, session, send } = context;
  await verifyPoolAssets(client, pool);
  const owner = session.address,
    exchange = getAddress(pool.exchange.address);
  const [balance0, balance1, allowance0, allowance1, timestamp] =
    await Promise.all([
      client.token(pool.token0).read.balanceOf([owner]),
      client.token(pool.token1).read.balanceOf([owner]),
      client.token(pool.token0).read.allowance([owner, exchange]),
      client.token(pool.token1).read.allowance([owner, exchange]),
      client.transactionTimestamp(),
    ]);
  const prepareAt = (now: bigint) =>
    prepareDepositWrite(
      pool,
      amount0,
      amount1,
      balance0,
      balance1,
      slippage,
      now,
      allowance0,
      allowance1,
    );
  const approvalPlan = prepareAt(timestamp);
  if (approvalPlan.approve0)
    await send("Approve ERC20", () =>
      session.walletClient.writeContract({
        account: owner,
        chain: client.chain,
        address: getAddress(pool.token0),
        abi: testTokenAbi,
        functionName: "approve",
        args: [exchange, approvalPlan.desired0],
      }),
    );
  if (approvalPlan.approve1)
    await send("Approve ERC20", () =>
      session.walletClient.writeContract({
        account: owner,
        chain: client.chain,
        address: getAddress(pool.token1),
        abi: testTokenAbi,
        functionName: "approve",
        args: [exchange, approvalPlan.desired1],
      }),
    );
  // Approval confirmation can take many blocks. Keep the captured deposit
  // request and let the extracted planner bind its deadline to submission time.
  const plan = prepareAt(await client.transactionTimestamp());
  const receipt = await send("Add liquidity", () =>
    session.walletClient.writeContract({
      account: owner,
      chain: client.chain,
      address: exchange,
      abi: miniDexAbi,
      functionName: "addLiquidity",
      args: [
        pool.id,
        plan.desired0,
        plan.desired1,
        plan.minimum0,
        plan.minimum1,
        plan.deadline,
      ],
    }),
  );
  const event = parseEventLogs({
    abi: miniDexAbi,
    eventName: "LiquidityAdded",
    logs: receipt.logs,
  }).find(
    (log) =>
      getAddress(log.address) === exchange && log.args.poolId === pool.id,
  )!;
  return confirmationFromEvent(pool, receipt, event);
}
export async function removeLiquidity(
  context: Context,
  pool: Pool,
  id: bigint,
  amounts: readonly [bigint, bigint],
  slippage: bigint,
): Promise<LiquidityConfirmation> {
  const { client, session, send } = context;
  await verifyPoolAssets(client, pool);
  const exchange = getAddress(pool.exchange.address);
  const [owner, position, timestamp] = await Promise.all([
    client.rpc.readContract({
      address: exchange,
      abi: miniDexAbi,
      functionName: "ownerOf",
      args: [id],
    }),
    client.rpc.readContract({
      address: exchange,
      abi: miniDexAbi,
      functionName: "positions",
      args: [id],
    }),
    client.transactionTimestamp(),
  ]);
  const plan = prepareWithdrawWrite(
    pool,
    position[1],
    owner,
    session.address,
    slippage,
    timestamp,
    position[0],
    amounts,
  );
  const receipt = await send("Redeem position", () =>
    session.walletClient.writeContract({
      account: session.address,
      chain: client.chain,
      address: exchange,
      abi: miniDexAbi,
      functionName: "removeLiquidity",
      args: [id, plan.minimum0, plan.minimum1, plan.deadline],
    }),
  );
  const event = parseEventLogs({
    abi: miniDexAbi,
    eventName: "LiquidityRemoved",
    logs: receipt.logs,
  }).find(
    (log) =>
      getAddress(log.address) === exchange &&
      log.args.poolId === pool.id &&
      log.args.positionId === id,
  )!;
  return confirmationFromEvent(pool, receipt, event);
}
export async function transferPosition(
  context: Context,
  pool: Pool,
  id: bigint,
  recipient: string,
): Promise<LiquidityConfirmation> {
  const { client, session, send } = context;
  const exchange = getAddress(pool.exchange.address);
  const owner = await client.rpc.readContract({
    address: exchange,
    abi: miniDexAbi,
    functionName: "ownerOf",
    args: [id],
  });
  const plan = prepareTransfer(owner, session.address, recipient);
  if (!plan.ok) throw new Error(plan.error);
  const receipt = await send("Transfer position", () =>
    session.walletClient.writeContract({
      account: session.address,
      chain: client.chain,
      address: exchange,
      abi: miniDexAbi,
      functionName: "safeTransferFrom",
      args: [session.address, plan.recipient, id],
    }),
  );
  const event = parseEventLogs({
    abi: miniDexAbi,
    eventName: "Transfer",
    logs: receipt.logs,
  }).find(
    (log) => getAddress(log.address) === exchange && log.args.tokenId === id,
  )!;
  return confirmationFromEvent(pool, receipt, event);
}
