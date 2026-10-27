import "../generated/dex_logic.js";
import type { TransactionReceipt } from "viem";

declare global {
  var DEXReceiptFees: { executionFeeWei: (receipt: string) => string };
}

export function executionFeeWei(
  receipt: Pick<TransactionReceipt, "gasUsed" | "effectiveGasPrice">,
): bigint {
  return BigInt(globalThis.DEXReceiptFees.executionFeeWei(JSON.stringify({
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
  })));
}
