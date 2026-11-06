import {
  getAddress,
  parseEventLogs,
  zeroAddress,
  type TransactionReceipt,
} from "viem";
import { miniDexAbi } from "../generated/abis";
import {
  selectPoolCreationReceipt,
  type ReceiptFact,
} from "../logic/swapReceipt";
import type { PoolCreationConfirmation } from "./types";
import type { ExchangeClient } from "./client";

function poolCreationEvents(receipt: TransactionReceipt) {
  return parseEventLogs({
    abi: miniDexAbi,
    eventName: "PoolCreated",
    strict: true,
    logs: receipt.logs,
  });
}

function poolCreationReceiptFacts(
  receipt: TransactionReceipt,
): ReceiptFact[] {
  return poolCreationEvents(receipt).map((event, index) => ({
    index,
    source: event.address.toLowerCase(),
    kind: "pool-creation",
    from: zeroAddress,
    to: zeroAddress,
  }));
}

export function poolCreationReceiptFromReceipt(
  client: ExchangeClient,
  receipt: TransactionReceipt,
): PoolCreationConfirmation | null {
  const selection = selectPoolCreationReceipt(client.deployment, {
    successful: receipt.status === "success",
    creation: receipt.contractAddress !== null,
    target: receipt.to?.toLowerCase() ?? "",
    owner: receipt.from.toLowerCase(),
    facts: poolCreationReceiptFacts(receipt),
  });
  switch (selection.kind) {
    case "none":
      return null;
    case "reverted":
      // DEFENSE: an unsuccessful createPool receipt must not produce a confirmed pool identity.
      throw new Error(
        "The transaction reverted and has no confirmed pool creation.",
      );
    case "multiple":
      // DEFENSE: an ERC721 recipient can create multiple pools during its transfer callback.
      throw new Error(
        "This receipt contains multiple pool creations; one result cannot represent them.",
      );
  }
  const event = poolCreationEvents(receipt)[selection.index]!;
  const address = getAddress(event.address);
  return {
    kind: "pool",
    exchange: client.deployment.exchanges.find(
      (exchange) => getAddress(exchange.address) === address,
    )!,
    poolId: event.args.poolId,
    token0: getAddress(event.args.token0),
    token1: getAddress(event.args.token1),
    receipt,
  };
}
