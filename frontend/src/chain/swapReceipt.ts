import { getAddress, type TransactionReceipt } from "viem";
import { miniDexAbi } from "../generated/abis";
import type { ParseEventLogsReturnType } from "viem";
import { swapOutputAsset } from "../logic/swapReceipt";
import { executionFeeWei } from "../logic/receipts";
import type { PoolIdentity, SwapExecution } from "./types";

type SwapEvent = ParseEventLogsReturnType<
  typeof miniDexAbi,
  "Swap",
  true
>[number];

export function swapExecutionFromEvent(
  pool: PoolIdentity,
  receipt: TransactionReceipt,
  event: SwapEvent,
): SwapExecution {
  return {
    pool: {
      exchange: pool.exchange,
      id: pool.id,
      token0: pool.token0,
      token1: pool.token1,
    },
    trader: event.args.sender,
    recipient: event.args.recipient,
    tokenIn: event.args.tokenIn,
    tokenOut: getAddress(
      swapOutputAsset(event.args.tokenIn, pool.token0, pool.token1),
    ),
    amountIn: event.args.amountIn,
    amountOut: event.args.amountOut,
    gasCostWei: executionFeeWei(receipt),
    receipt,
  };
}
