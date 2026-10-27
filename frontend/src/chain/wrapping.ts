import { getAddress, parseEventLogs, type Hex, type TransactionReceipt } from "viem";
import { wrappedEtherAbi } from "../generated/abis";
import { prepareWrapping, requireWrappedAddress } from "../logic/wrapping";
import type { ExchangeClient, SendTransaction } from "./client";
import type { WalletSession } from "../wallet/session";
import type { WrappingConfirmation } from "./types";
import { executionFeeWei } from "../logic/receipts";
import { wrappingSettlement } from "../logic/wrappingSettlement";
import { selectWrappingReceipt, type ReceiptFact } from "../logic/swapReceipt";

function wrappingEvents(receipt: TransactionReceipt) {
  return parseEventLogs({ abi: wrappedEtherAbi, eventName: "Transfer", logs: receipt.logs, strict: true });
}

export function wrappingReceiptFacts(receipt: TransactionReceipt): ReceiptFact[] {
  return wrappingEvents(receipt).map((event, index) => ({
    index, source: event.address.toLowerCase(), kind: "wrapping",
    from: event.args.from.toLowerCase(), to: event.args.to.toLowerCase(),
  }));
}

export function wrappingReceiptFromReceipt(
  client: ExchangeClient,
  receipt: TransactionReceipt,
): WrappingConfirmation | null {
  // KNOWN LIMITATION: delegated-account callback transfers are outside this single conversion's effects.
  const selection = selectWrappingReceipt(client.deployment, {
    successful: receipt.status === "success", creation: receipt.contractAddress !== null,
    target: receipt.to?.toLowerCase() ?? "", owner: receipt.from.toLowerCase(),
    facts: wrappingReceiptFacts(receipt),
  });
  switch (selection.kind) {
    case "none": return null;
    case "reverted":
      // DEFENSE: a supplied history hash can refer to an on-chain reverted withdrawal.
      throw new Error("The transaction reverted and has no confirmed wrapping result.");
    case "multiple":
      // DEFENSE: a delegated account can perform another conversion while receiving withdrawal ETH.
      throw new Error("This receipt contains multiple conversions; one result cannot represent them.");
  }
  const event = wrappingEvents(receipt)[selection.index]!;
  const gasCostWei = executionFeeWei(receipt);
  return {
    kind: selection.withdraw ? "unwrap" : "wrap", token: getAddress(event.address),
    owner: getAddress(selection.withdraw ? event.args.from : event.args.to),
    amount: event.args.value, gasCostWei,
    ...wrappingSettlement(event.args.value, selection.withdraw, gasCostWei), receipt,
  };
}

export async function readWrappingReceipt(client: ExchangeClient, hash: Hex) {
  return wrappingReceiptFromReceipt(client, await client.rpc.getTransactionReceipt({ hash }));
}

export async function executeWrap(
  context: { client: ExchangeClient; session: WalletSession; send: SendTransaction },
  amount: bigint,
  withdraw: boolean,
): Promise<WrappingConfirmation> {
  const { client, session, send } = context;
  const token = requireWrappedAddress(client.deployment.tokens);
  const address = getAddress(token);
  const { number: blockNumber } = await client.rpc.getBlock({ blockTag: "latest" });
  const [native, wrapped] = await Promise.all([
    client.rpc.getBalance({ address: session.address, blockNumber }),
    client.rpc.readContract({ address, abi: wrappedEtherAbi, functionName: "balanceOf", args: [session.address], blockNumber }),
  ]);
  const observation = { connected: true, pending: false, token, native, wrapped };
  const provisional = prepareWrapping(observation, amount, withdraw);
  const call = provisional.withdraw
    ? { address, abi: wrappedEtherAbi, functionName: "withdraw" as const, args: [provisional.amount] as const }
    : { address, abi: wrappedEtherAbi, functionName: "deposit" as const, value: provisional.amount };
  const [gas, fees] = await Promise.all([
    provisional.withdraw
      ? client.rpc.estimateContractGas({ address, abi: wrappedEtherAbi, functionName: "withdraw", args: [provisional.amount], account: session.address })
      : client.rpc.estimateContractGas({ address, abi: wrappedEtherAbi, functionName: "deposit", value: provisional.amount, account: session.address }),
    client.rpc.estimateFeesPerGas({ type: "eip1559", chain: client.chain }),
  ]);
  const request = prepareWrapping(observation, amount, withdraw, gas, fees.maxFeePerGas);
  const receipt = await send(request.withdraw ? "Unwrap WETH" : "Wrap ETH", () => session.walletClient.writeContract({
    ...call,
    account: session.address,
    chain: client.chain,
    gas: request.gas,
    maxFeePerGas: request.feePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  }));
  const confirmation = wrappingReceiptFromReceipt(client, receipt);
  // DEFENSE: an incomplete RPC receipt must not turn the requested amount into evidence.
  if (confirmation === null) throw new Error("Confirmed conversion is missing its settlement event.");
  return confirmation;
}
