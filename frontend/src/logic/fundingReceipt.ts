import "../generated/dex_logic.js";
import type { TransactionReceipt } from "viem";
import type { FundingRecoveryContext } from "../chain/types";
import type { ReceiptFact } from "./swapReceipt";

function observation(receipt: TransactionReceipt, context?: FundingRecoveryContext) {
  return {
    successful: receipt.status === "success",
    target: receipt.to?.toLowerCase() ?? "",
    owner: receipt.from.toLowerCase(),
    authority: context?.authority ?? "",
    beneficiary: context?.beneficiary.toLowerCase() ?? "",
  };
}

export function selectTokenFunding(
  receipt: TransactionReceipt, facts: ReceiptFact[], expected?: { token: string; recipient: string },
):
  { kind: "none" | "reverted" | "multiple" } | { kind: "selected"; index: number } {
  return JSON.parse(globalThis.DEXSwapReceipt.selectTokenFunding(
    JSON.stringify({ ...observation(receipt), facts,
      expectedTarget: expected?.token.toLowerCase() ?? receipt.to?.toLowerCase() ?? "",
      expectedOwner: expected?.recipient.toLowerCase() ?? receipt.from.toLowerCase(),
    }),
  ));
}

export function nativeFundingCandidate(receipt: TransactionReceipt, context?: FundingRecoveryContext) {
  return globalThis.DEXSwapReceipt.nativeFundingCandidate(
    JSON.stringify(observation(receipt, context)),
  );
}

export function nativeFundingValue(
  receipt: TransactionReceipt, context: FundingRecoveryContext | undefined,
  input: string, value: bigint,
): bigint | null {
  const result = JSON.parse(globalThis.DEXSwapReceipt.nativeFundingValue(
    JSON.stringify({ ...observation(receipt, context), input, amount: value.toString() }),
  )) as { kind: "none" } | { kind: "selected"; amount: string };
  return result.kind === "selected" ? BigInt(result.amount) : null;
}
