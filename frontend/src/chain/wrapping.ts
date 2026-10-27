import { getAddress, parseEventLogs, zeroAddress } from "viem";
import { wrappedEtherAbi } from "../generated/abis";
import { prepareWrapping, requireWrappedAddress } from "../logic/wrapping";
import type { ExchangeClient, SendTransaction } from "./client";
import type { WalletSession } from "../wallet/session";
import type { WrappingConfirmation } from "./types";
import { executionFeeWei } from "../logic/receipts";
import { wrappingSettlement } from "../logic/wrappingSettlement";

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
  const event = parseEventLogs({ abi: wrappedEtherAbi, eventName: "Transfer", logs: receipt.logs })
    .find((event) => getAddress(event.address) === address &&
      getAddress(event.args.from) === (request.withdraw ? session.address : zeroAddress) &&
      getAddress(event.args.to) === (request.withdraw ? zeroAddress : session.address))!;
  const principal = event.args.value;
  const gasCostWei = executionFeeWei(receipt);
  return {
    kind: request.withdraw ? "unwrap" : "wrap",
    token: address,
    owner: session.address,
    amount: principal,
    gasCostWei,
    ...wrappingSettlement(principal, request.withdraw, gasCostWei),
    receipt,
  };
}
