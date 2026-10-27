import "../generated/dex_logic.js";
import { toFunctionSelector } from "viem";
import { arbitrageAbi, miniDexAbi } from "../generated/abis";
import type { TransactionDescriptor } from "../wallet/kernel";
import type { Exchange } from "../chain/types";

export type ReceiptFact = {
  index: number;
  source: string;
  kind: "swap" | "liquidity" | "transfer" | "arbitrage";
  from: string;
  to: string;
};
type Scope = { exchanges: Exchange[]; arbitrage: string };
type Observation = {
  successful: boolean;
  creation: boolean;
  target: string;
  facts: ReceiptFact[];
};
type Selection =
  | { kind: "none" | "reverted" | "multiple" }
  | { kind: "selected"; index: number };
export type RecoveredKind =
  "none" | "creation" | "swap" | "liquidity" | "arbitrage" | "reverted";

declare global {
  var DEXSwapReceipt: {
    select(input: string): string;
    classify(input: string): RecoveredKind;
    available(input: string): boolean;
    outputAsset(input: string): string;
  };
}

function scopeWire(scope: Scope) {
  return {
    exchanges: scope.exchanges.map((exchange) =>
      exchange.address.toLowerCase(),
    ),
    arbitrage: scope.arbitrage.toLowerCase(),
  };
}

export function transactionResultAvailable(
  scope: Scope,
  descriptor: TransactionDescriptor | null,
) {
  const selector = descriptor?.input.slice(0, 10);
  const method = [...miniDexAbi, ...arbitrageAbi].find(
    (item) => item.type === "function" && toFunctionSelector(item) === selector,
  );
  return globalThis.DEXSwapReceipt.available(
    JSON.stringify({
      ...scopeWire(scope),
      descriptorKnown: descriptor !== null,
      creation: descriptor?.to === null,
      target: descriptor?.to?.toLowerCase() ?? "",
      operation: method?.type === "function" ? method.name : "",
    }),
  );
}

export function recoveredTransactionKind(
  scope: Scope,
  observation: Observation,
) {
  return globalThis.DEXSwapReceipt.classify(
    JSON.stringify({ ...scopeWire(scope), ...observation }),
  );
}

export function selectSwapReceipt(
  scope: Scope,
  observation: Observation,
): Selection {
  return JSON.parse(
    globalThis.DEXSwapReceipt.select(
      JSON.stringify({
        ...scopeWire(scope),
        ...observation,
      }),
    ),
  ) as Selection;
}

export function swapOutputAsset(input: string, token0: string, token1: string) {
  return globalThis.DEXSwapReceipt.outputAsset(
    JSON.stringify({
      input: input.toLowerCase(),
      token0: token0.toLowerCase(),
      token1: token1.toLowerCase(),
    }),
  );
}
