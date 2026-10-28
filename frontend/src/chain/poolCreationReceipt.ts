import {
  getAddress,
  parseEventLogs,
  zeroAddress,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { miniDexAbi } from "../generated/abis";
import {
  selectPoolCreationReceipt,
  type ReceiptFact,
} from "../logic/swapReceipt";
import type { ExchangeClient } from "./client";
import type { PoolCreationConfirmation } from "./types";

function poolCreationEvents(receipt: TransactionReceipt) {
  return parseEventLogs({
    abi: miniDexAbi,
    eventName: "PoolCreated",
    strict: true,
    logs: receipt.logs,
  });
}

export function poolCreationReceiptFacts(
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
      // DEFENSE: a supplied hash can refer to a mined, reverted createPool call.
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

export async function readPoolCreationReceipt(
  client: ExchangeClient,
  hash: Hex,
) {
  return poolCreationReceiptFromReceipt(
    client,
    await client.rpc.getTransactionReceipt({ hash }),
  );
}
