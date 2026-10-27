import { importAsset } from "./assets";
import { executionFeeWei } from "../logic/receipts";
import { assertSupportedPool } from "../logic/assets";
import { getAddress, parseEventLogs } from "viem";
import { miniDexAbi, testTokenAbi } from "../generated/abis";
import {
  prepareDepositWrite,
  prepareWithdrawWrite,
  prepareTransfer,
} from "../logic/liquidity";
import type { ExchangeClient, SendTransaction } from "./client";
import type { WalletSession } from "../wallet/session";
import type { LiquidityConfirmation, Pool } from "./types";

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
  return {
    kind: "deposit",
    pool,
    positionId: event.args.positionId,
    owner: event.args.provider,
    amount0: event.args.amount0,
    amount1: event.args.amount1,
    shares: event.args.shares,
    gasCostWei: executionFeeWei(receipt),
    receipt,
  };
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
  return {
    kind: "redeem",
    pool,
    positionId: event.args.positionId,
    owner: event.args.owner,
    amount0: event.args.amount0,
    amount1: event.args.amount1,
    shares: event.args.shares,
    gasCostWei: executionFeeWei(receipt),
    receipt,
  };
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
  return {
    kind: "transfer",
    pool,
    positionId: event.args.tokenId,
    from: event.args.from,
    to: event.args.to,
    gasCostWei: executionFeeWei(receipt),
    receipt,
  };
}
