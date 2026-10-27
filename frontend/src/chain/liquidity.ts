import { importAsset } from "./assets";
import { assertSupportedPool } from "../logic/assets";
import { getAddress } from "viem";
import { miniDexAbi, testTokenAbi } from "../generated/abis";
import {
  prepareDepositWrite,
  prepareWithdrawWrite,
  prepareTransfer,
} from "../logic/liquidity";
import type { ExchangeClient, SendTransaction } from "./client";
import type { WalletSession } from "../wallet/session";
import type { Pool } from "./types";

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
) {
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
  const plan = prepareDepositWrite(
    pool,
    amount0,
    amount1,
    balance0,
    balance1,
    slippage,
    timestamp,
    allowance0,
    allowance1,
  );
  if (plan.approve0)
    await send("Approve ERC20", () =>
      session.walletClient.writeContract({
        account: owner,
        chain: client.chain,
        address: getAddress(pool.token0),
        abi: testTokenAbi,
        functionName: "approve",
        args: [exchange, plan.desired0],
      }),
    );
  if (plan.approve1)
    await send("Approve ERC20", () =>
      session.walletClient.writeContract({
        account: owner,
        chain: client.chain,
        address: getAddress(pool.token1),
        abi: testTokenAbi,
        functionName: "approve",
        args: [exchange, plan.desired1],
      }),
    );
  return send("Add liquidity", () =>
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
}
export async function removeLiquidity(
  context: Context,
  pool: Pool,
  id: bigint,
  amounts: readonly [bigint, bigint],
  slippage: bigint,
) {
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
  return send("Redeem position", () =>
    session.walletClient.writeContract({
      account: session.address,
      chain: client.chain,
      address: exchange,
      abi: miniDexAbi,
      functionName: "removeLiquidity",
      args: [id, plan.minimum0, plan.minimum1, plan.deadline],
    }),
  );
}
export async function transferPosition(
  context: Context,
  pool: Pool,
  id: bigint,
  recipient: string,
) {
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
  return send("Transfer position", () =>
    session.walletClient.writeContract({
      account: session.address,
      chain: client.chain,
      address: exchange,
      abi: miniDexAbi,
      functionName: "safeTransferFrom",
      args: [session.address, plan.recipient, id],
    }),
  );
}
