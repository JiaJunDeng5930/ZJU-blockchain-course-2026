import "../generated/dex_logic.js";
import type { TransactionReceipt } from "viem";
import type { ReceiptFact } from "./swapReceipt";

export function selectTokenFunding(
  receipt: TransactionReceipt,
  facts: ReceiptFact[],
  expected?: { token: string; recipient: string },
):
  | { kind: "none" | "reverted" | "multiple" }
  | { kind: "selected"; index: number } {
  return JSON.parse(
    globalThis.DEXSwapReceipt.selectTokenFunding(
      JSON.stringify({
        successful: receipt.status === "success",
        target: receipt.to?.toLowerCase() ?? "",
        owner: receipt.from.toLowerCase(),
        authority: "",
        beneficiary: "",
        facts,
        expectedTarget:
          expected?.token.toLowerCase() ?? receipt.to?.toLowerCase() ?? "",
        expectedOwner:
          expected?.recipient.toLowerCase() ?? receipt.from.toLowerCase(),
      }),
    ),
  );
}
