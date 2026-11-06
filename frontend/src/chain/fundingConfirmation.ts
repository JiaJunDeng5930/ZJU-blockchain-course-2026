import { parseEventLogs, type TransactionReceipt } from "viem";
import { testTokenAbi } from "../generated/abis";
import { selectTokenFunding } from "../logic/fundingReceipt";
import { executionFeeWei } from "../logic/receipts";
import type { AssetFundingConfirmation, Token } from "./types";

export function tokenFundingEvent(
  receipt: TransactionReceipt, expected?: { token: string; recipient: string },
) {
  const events = parseEventLogs({ abi: testTokenAbi, eventName: "Transfer", logs: receipt.logs });
  const selection = selectTokenFunding(receipt, events.map((event, index) => ({
    index, source: event.address.toLowerCase(), kind: "transfer",
    from: event.args.from.toLowerCase(), to: event.args.to.toLowerCase(),
  })), expected);
  switch (selection.kind) {
    case "none": return null;
    case "reverted":
      // DEFENSE: a reverted faucet receipt must not produce a successful token grant.
      throw new Error("The transaction reverted and has no confirmed funding result.");
    case "multiple":
      // DEFENSE: an external contract can emit several mint-shaped Transfer logs.
      throw new Error("Multiple mint events do not identify a single test-token grant.");
    case "selected": return events[selection.index];
  }
}

export function tokenFundingConfirmation(
  token: Token, receipt: TransactionReceipt,
  event: NonNullable<ReturnType<typeof tokenFundingEvent>>,
): Extract<AssetFundingConfirmation, { kind: "token" }> {
  return { kind: "token", token, recipient: event.args.to, amount: event.args.value,
    gasCostWei: executionFeeWei(receipt), receipt };
}

export function nativeFundingConfirmation(
  receipt: TransactionReceipt, recipient: string, amount: bigint,
): Extract<AssetFundingConfirmation, { kind: "native" }> {
  return { kind: "native", recipient, amount, gasCostWei: executionFeeWei(receipt), receipt };
}
