import "../generated/dex_logic.js";
import { toFunctionSelector } from "viem";
import { miniDexAbi } from "../generated/abis";
import type { TransactionDescriptor } from "../wallet/kernel";
import type { Exchange } from "../chain/types";

export type LiquidityReceiptFact = {
  index: number;
  exchange: string;
  kind: "deposit" | "redeem" | "transfer";
  from: string;
  to: string;
};
type Selection =
  | { kind: "none" | "multiple" | "reverted" }
  | { kind: "selected"; index: number };

declare global {
  var DEXLiquidityReceipt: {
    select: (observation: string) => string;
    available: (observation: string) => boolean;
  };
}

export function liquidityReceiptAvailable(
  exchanges: Exchange[],
  descriptor: TransactionDescriptor | null,
): boolean {
  const selector = descriptor?.input.slice(0, 10);
  const method = miniDexAbi.find(
    (item) => item.type === "function" && toFunctionSelector(item) === selector,
  );
  return globalThis.DEXLiquidityReceipt.available(
    JSON.stringify({
      exchanges: exchanges.map((exchange) => exchange.address.toLowerCase()),
      descriptorKnown: descriptor !== null,
      target: descriptor?.to?.toLowerCase() ?? "",
      operation: method?.type === "function" ? method.name : "",
    }),
  );
}

export function selectLiquidityReceipt(
  successful: boolean,
  exchanges: string[],
  events: LiquidityReceiptFact[],
): Selection {
  return JSON.parse(
    globalThis.DEXLiquidityReceipt.select(
      JSON.stringify({
        successful,
        exchanges,
        events,
      }),
    ),
  ) as Selection;
}
