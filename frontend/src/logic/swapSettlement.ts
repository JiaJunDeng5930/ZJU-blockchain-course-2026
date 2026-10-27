import "../generated/dex_logic.js";
import { tokenDecimals } from "../chain/amounts";
import type { SwapResult, Token } from "../chain/types";

declare global {
  var DEXSwapSettlement: { summarize: (input: string) => string };
}

export function swapSettlementView(result: SwapResult, tokens: readonly Token[]) {
  const value = JSON.parse(globalThis.DEXSwapSettlement.summarize(JSON.stringify({
    amountIn: result.amountIn.toString(),
    amountOut: result.amountOut.toString(),
    quoted: result.quoted.toString(),
    inputPlaces: tokenDecimals(tokens, result.tokenIn).toString(),
    outputPlaces: tokenDecimals(tokens, result.tokenOut).toString(),
  }))) as {
    executionPrice: string | null;
    quoteDifference: string;
    comparison: "same" | "more" | "less";
  };
  return { ...value, quoteDifference: BigInt(value.quoteDifference) };
}
