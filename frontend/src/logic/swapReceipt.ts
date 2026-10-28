import "../generated/dex_logic.js";
import { toFunctionSelector } from "viem";
import { arbitrageAbi, miniDexAbi, wrappedEtherAbi, testTokenAbi } from "../generated/abis";
import type { TransactionDescriptor } from "../wallet/kernel";
import type { Exchange, Token, FundingRecoveryContext } from "../chain/types";
import { selectWrappedAddress } from "./wrapping";

export type ReceiptFact = {
  index: number;
  source: string;
  kind: "swap" | "liquidity" | "transfer" | "arbitrage" | "wrapping" | "pool-creation";
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
export type RecoveredKind =
  "none" | "creation" | "swap" | "liquidity" | "arbitrage" | "wrapping" | "pool-creation" | "reverted";

declare global {
  var DEXSwapReceipt: {
    select(input: string): string;
    classify(input: string): RecoveredKind;
    available(input: string): boolean;
    outputAsset(input: string): string;
    selectWrapping(input: string): string;
    selectPoolCreation(input: string): string;
    continueCreatedPool(input: string): string;
    selectTokenFunding(input: string): string;
    nativeFundingCandidate(input: string): boolean;
    nativeFundingValue(input: string): string;
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

export function transactionResultAvailable(
  scope: Scope,
  descriptor: TransactionDescriptor | null,
  context?: FundingRecoveryContext,
) {
  const selector = descriptor?.input.slice(0, 10);
  const method = [...miniDexAbi, ...arbitrageAbi, ...wrappedEtherAbi, ...testTokenAbi].find(
    (item) => item.type === "function" && toFunctionSelector(item) === selector,
  );
  return globalThis.DEXSwapReceipt.available(
    JSON.stringify({
      ...scopeWire(scope),
      descriptorKnown: descriptor !== null,
      creation: descriptor?.to === null,
      authority: context?.authority ?? "",
      beneficiary: context?.beneficiary.toLowerCase() ?? "",
      target: descriptor?.to?.toLowerCase() ?? "",
      operation: method?.type === "function" ? method.name
        : descriptor?.input === "0x" ? "receive" : "",
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

export function selectPoolCreationReceipt(scope: Scope, observation: Observation): Selection {
  return JSON.parse(globalThis.DEXSwapReceipt.selectPoolCreation(
    JSON.stringify({ ...scopeWire(scope), ...observation }),
  )) as Selection;
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
  return JSON.parse(globalThis.DEXSwapReceipt.selectWrapping(
    JSON.stringify({ ...scopeWire(scope), ...observation }),
  ));
}
