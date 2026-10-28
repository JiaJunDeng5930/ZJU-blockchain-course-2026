import { getAddress, type Hex, type TransactionReceipt } from "viem";
import { testTokenRuntimeBytecode } from "../generated/abis";
import { runtimeCodeMatches } from "../logic/assets";
import { nativeFundingCandidate, nativeFundingValue } from "../logic/fundingReceipt";
import { importAsset } from "./assets";
import { nativeFundingConfirmation, tokenFundingConfirmation, tokenFundingEvent } from "./fundingConfirmation";
import type { ExchangeClient } from "./client";
import type { AssetFundingConfirmation, FundingRecoveryContext } from "./types";

export async function fundingReceiptFromReceipt(
  client: ExchangeClient, receipt: TransactionReceipt, context?: FundingRecoveryContext,
): Promise<AssetFundingConfirmation | null> {
  const mint = tokenFundingEvent(receipt);
  if (mint !== null) {
    const address = getAddress(mint.address);
    const code = await client.rpc.getCode({ address, blockNumber: receipt.blockNumber });
    // DEFENSE: arbitrary ERC20 contracts can emit the same mint-shaped event.
    if (!runtimeCodeMatches(code, testTokenRuntimeBytecode)) return null;
    const token = await importAsset(client, address, receipt.blockNumber);
    return tokenFundingConfirmation(token, receipt, mint);
  }
  if (!nativeFundingCandidate(receipt, context)) return null;
  const transaction = await client.rpc.getTransaction({ hash: receipt.transactionHash });
  const amount = nativeFundingValue(receipt, context, transaction.input, transaction.value);
  if (amount === null) return null;
  // KNOWN LIMITATION: test ETH grants assume ordinary wallet recipients; a
  // delegated account can forward its incoming value during the same call.
  return nativeFundingConfirmation(receipt, getAddress(receipt.to!), amount);
}

export async function readFundingReceipt(
  client: ExchangeClient, hash: Hex, context?: FundingRecoveryContext,
) {
  return fundingReceiptFromReceipt(client, await client.rpc.getTransactionReceipt({ hash }), context);
}
