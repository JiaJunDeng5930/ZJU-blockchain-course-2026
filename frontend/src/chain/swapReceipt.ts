import {
  getAddress,
  parseEventLogs,
  zeroAddress,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { arbitrageAbi, miniDexAbi } from "../generated/abis";
import {
  recoveredTransactionKind,
  selectSwapReceipt,
  swapOutputAsset,
  type ReceiptFact,
} from "../logic/swapReceipt";
import { executionFeeWei } from "../logic/receipts";
import { importAsset } from "./assets";
import { liquidityReceiptFromReceipt } from "./liquidity";
import { arbitrageReceiptFromReceipt } from "./arbitrage";
import { wrappingReceiptFacts, wrappingReceiptFromReceipt } from "./wrapping";
import type { ExchangeClient } from "./client";
import type {
  PoolIdentity,
  RecoveredTransactionResult,
  SwapExecution,
  SwapReceiptDetails,
} from "./types";

type SwapEvent = ReturnType<typeof swapEvents>[number];
function swapEvents(receipt: TransactionReceipt) {
  return parseEventLogs({
    abi: miniDexAbi,
    eventName: "Swap",
    logs: receipt.logs,
    strict: true,
  });
}

function observation(receipt: TransactionReceipt) {
  const swaps = swapEvents(receipt);
  const liquidity = parseEventLogs({
    abi: miniDexAbi,
    eventName: ["LiquidityAdded", "LiquidityRemoved", "Transfer"],
    logs: receipt.logs,
  });
  const arbitrage = parseEventLogs({
    abi: arbitrageAbi,
    eventName: "ArbitrageExecuted",
    logs: receipt.logs,
  });
  const facts: ReceiptFact[] = [
    ...swaps.map((event, index) => ({
      index,
      source: event.address.toLowerCase(),
      kind: "swap" as const,
      from: zeroAddress,
      to: zeroAddress,
    })),
    ...liquidity.map((event, index) => ({
      index,
      source: event.address.toLowerCase(),
      kind:
        event.eventName === "Transfer"
          ? ("transfer" as const)
          : ("liquidity" as const),
      from:
        event.eventName === "Transfer"
          ? event.args.from.toLowerCase()
          : zeroAddress,
      to:
        event.eventName === "Transfer"
          ? event.args.to.toLowerCase()
          : zeroAddress,
    })),
    ...arbitrage.map((event, index) => ({
      index,
      source: event.address.toLowerCase(),
      kind: "arbitrage" as const,
      from: zeroAddress,
      to: zeroAddress,
    })),
    ...wrappingReceiptFacts(receipt),
  ];
  return {
    successful: receipt.status === "success",
    creation: receipt.contractAddress !== null,
    target: receipt.to?.toLowerCase() ?? "",
    owner: receipt.from.toLowerCase(),
    facts,
  };
}

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

async function swapReceiptFromReceipt(
  client: ExchangeClient,
  receipt: TransactionReceipt,
): Promise<SwapReceiptDetails | null> {
  const selection = selectSwapReceipt(client.deployment, observation(receipt));
  switch (selection.kind) {
    case "none":
      return null;
    case "reverted":
      // DEFENSE: a supplied hash can refer to an actually reverted exchange call.
      throw new Error(
        "The transaction reverted and has no confirmed swap result.",
      );
    case "multiple":
      // DEFENSE: a contract callback can perform more than one swap in the same transaction.
      throw new Error(
        "This receipt contains multiple swaps; one execution cannot represent it.",
      );
  }
  const event = swapEvents(receipt)[selection.index]!;
  const address = getAddress(event.address);
  const exchange = client.deployment.exchanges.find(
    (item) => getAddress(item.address) === address,
  )!;
  const [token0, token1] = await client.rpc.readContract({
    address,
    abi: miniDexAbi,
    functionName: "pools",
    args: [event.args.poolId],
    blockNumber: receipt.blockNumber,
  });
  const tokens = await Promise.all([
    importAsset(client, token0, receipt.blockNumber),
    importAsset(client, token1, receipt.blockNumber),
  ]);
  return {
    execution: swapExecutionFromEvent(
      { exchange, id: event.args.poolId, token0, token1 },
      receipt,
      event,
    ),
    tokens,
  };
}

export async function readSwapReceipt(client: ExchangeClient, hash: Hex) {
  return swapReceiptFromReceipt(
    client,
    await client.rpc.getTransactionReceipt({ hash }),
  );
}

export async function readTransactionResult(
  client: ExchangeClient,
  hash: Hex,
): Promise<RecoveredTransactionResult | null> {
  const receipt = await client.rpc.getTransactionReceipt({ hash });
  switch (recoveredTransactionKind(client.deployment, observation(receipt))) {
    case "none":
      return null;
    case "reverted":
      // DEFENSE: a manually supplied hash can be an on-chain reverted transaction.
      throw new Error(
        "The transaction reverted and has no confirmed operation result.",
      );
    case "creation":
      return { kind: "creation", address: receipt.contractAddress!, receipt };
    case "liquidity": {
      const details = await liquidityReceiptFromReceipt(client, receipt);
      return details === null ? null : { kind: "liquidity", details };
    }
    case "arbitrage": {
      const details = await arbitrageReceiptFromReceipt(client, receipt);
      return details === null ? null : { kind: "arbitrage", details };
    }
    case "swap": {
      const details = await swapReceiptFromReceipt(client, receipt);
      return details === null ? null : { kind: "swap", details };
    }
    case "wrapping": {
      const details = wrappingReceiptFromReceipt(client, receipt);
      return details === null ? null : { kind: "wrapping", details };
    }
  }
}
