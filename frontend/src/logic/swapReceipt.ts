import "../generated/dex_logic.js";
import type { Exchange, Token } from "../chain/types";
import { selectWrappedAddress } from "./wrapping";

export type ReceiptFact = {
  index: number;
  source: string;
  kind: "wrapping" | "pool-creation" | "transfer";
  from: string;
  to: string;
};
type Scope = { exchanges: Exchange[]; arbitrage: string; tokens?: Token[] };
type Observation = {
  successful: boolean;
  creation: boolean;
  target: string;
  owner: string;
  facts: ReceiptFact[];
};
type Selection =
  | { kind: "none" | "reverted" | "multiple" }
  | { kind: "selected"; index: number };

declare global {
  var DEXSwapReceipt: {
    outputAsset(input: string): string;
    selectWrapping(input: string): string;
    selectPoolCreation(input: string): string;
    continueCreatedPool(input: string): string;
    selectTokenFunding(input: string): string;
  };
}

function scopeWire(scope: Scope) {
  return {
    exchanges: scope.exchanges.map((exchange) =>
      exchange.address.toLowerCase(),
    ),
    arbitrage: scope.arbitrage.toLowerCase(),
    wrapped: selectWrappedAddress(scope.tokens ?? [])?.toLowerCase() ?? "",
  };
}

export function selectPoolCreationReceipt(
  scope: Scope,
  observation: Observation,
): Selection {
  return JSON.parse(
    globalThis.DEXSwapReceipt.selectPoolCreation(
      JSON.stringify({ ...scopeWire(scope), ...observation }),
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

export function selectWrappingReceipt(
  scope: Scope,
  observation: Observation,
): { kind: "none" | "reverted" | "multiple" } | { kind: "selected"; index: number; withdraw: boolean } {
  return JSON.parse(
    globalThis.DEXSwapReceipt.selectWrapping(
      JSON.stringify({ ...scopeWire(scope), ...observation }),
    ),
  );
}
