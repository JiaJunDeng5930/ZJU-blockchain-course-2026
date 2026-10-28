import { getAddress, parseEventLogs, zeroAddress } from "viem";
import type { ExchangeClient, SendTransaction } from "./client";
import { executionFeeWei } from "../logic/receipts";
import { poolCreationReceiptFromReceipt } from "./poolCreationReceipt";
import type { WalletSession } from "../wallet/session";
import type {
  AssetCreationConfirmation,
  AssetFundingConfirmation,
  PoolCreationConfirmation,
  Token,
  TokenCreationConfirmation,
} from "./types";
import {
  miniDexAbi,
  testTokenAbi,
  testTokenBytecode,
  testTokenRuntimeBytecode,
} from "../generated/abis";
import {
  assetEnvironment,
  canonicalAssetAddress,
  createPoolPlan,
  deploymentAddress,
  deploymentPlan,
  faucetPlan,
  recognizeAsset,
} from "../logic/assets";
export type AssetContext = {
  client: ExchangeClient;
  session: WalletSession;
  send: SendTransaction;
};

export async function importAsset(
  client: ExchangeClient,
  raw: string,
  atBlock?: bigint,
): Promise<Token> {
  const address = getAddress(canonicalAssetAddress(raw));
  const blockNumber = atBlock ?? await client.rpc.getBlockNumber();
  const token = client.token(address);
  const [name, symbol, decimals, code] = await Promise.all([
    token.read.name({ blockNumber }),
    token.read.symbol({ blockNumber }),
    token.read.decimals({ blockNumber }),
    client.rpc.getCode({ address, blockNumber }),
  ]);
  return recognizeAsset({
    address,
    name,
    symbol,
    decimals: decimals.toString(),
    code: code ?? "",
    expectedCode: testTokenRuntimeBytecode,
  });
}
export async function createAsset(
  { client, session, send }: AssetContext,
  name: string,
  symbol: string,
): Promise<TokenCreationConfirmation> {
  const plan = deploymentPlan(name, symbol);
  const receipt = await send("Deploy ERC20", () =>
    session.walletClient.deployContract({
      account: session.address,
      chain: client.chain,
      abi: testTokenAbi,
      bytecode: testTokenBytecode,
      args: [plan.name, plan.symbol],
    }),
  );
  return {
    kind: "token",
    address: getAddress(deploymentAddress(receipt.contractAddress)),
    name: plan.name,
    symbol: plan.symbol,
    receipt,
  };
}
export async function createAssetPool(
  { client, session, send }: AssetContext,
  exchange: string,
  token0: string,
  token1: string,
): Promise<PoolCreationConfirmation> {
  const [first, second, block] = await Promise.all([
    importAsset(client, token0),
    importAsset(client, token1),
    client.rpc.getBlockNumber(),
  ]);
  const pools = await client.pools(Number(block));
  const plan = createPoolPlan(
    assetEnvironment(
      client.deployment.exchanges,
      [first, second],
      pools,
      true,
      false,
    ),
    exchange,
    first.address,
    second.address,
  );
  const receipt = await send("Create pool", () =>
    session.walletClient.writeContract({
      account: session.address,
      chain: client.chain,
      address: getAddress(plan.exchange),
      abi: miniDexAbi,
      functionName: "createPool",
      args: [getAddress(plan.first), getAddress(plan.second)],
    }),
  );
  const confirmation = poolCreationReceiptFromReceipt(client, receipt);
  // DEFENSE: an authentic successful createPool receipt must identify its pool in the target DEX's event.
  if (!confirmation)
    throw new Error(
      "Confirmed pool creation has no PoolCreated event from its exchange.",
    );
  return confirmation;
}
export async function claimAsset(
  { client, session, send }: AssetContext,
  token: Token,
): Promise<AssetFundingConfirmation> {
  const verified = await importAsset(client, token.address);
  const plan = faucetPlan(verified);
  const receipt = await send(`Claim ${verified.symbol}`, () =>
    session.walletClient.writeContract({
      account: session.address,
      chain: client.chain,
      address: getAddress(plan.address),
      abi: testTokenAbi,
      functionName: "faucet",
    }),
  );
  const mint = parseEventLogs({ abi: testTokenAbi, eventName: "Transfer", logs: receipt.logs })
    .find((event) => getAddress(event.address) === getAddress(verified.address) &&
      event.args.from === zeroAddress && getAddress(event.args.to) === session.address)!;
  return { kind: "token", token: verified, recipient: session.address,
    amount: mint.args.value, gasCostWei: executionFeeWei(receipt), receipt };
}

import { errorMessage } from "./amounts";
import {
  AssetForms,
  type AssetEnvironment,
  type AssetEvent,
} from "../logic/assets";
import type { Writer } from "./client";
type AssetFormsContext = {
  client: ExchangeClient;
  controller: AssetForms;
  environment: AssetEnvironment;
  run: (label: string, perform: (writer: Writer) => Promise<void>) => void;
  registerToken: (token: Token) => void;
  onCreated: (confirmation: AssetCreationConfirmation) => void;
};
export function dispatchAssetEvent(
  context: AssetFormsContext,
  event: AssetEvent,
): void {
  const effect = context.controller.dispatch(context.environment, event);
  if (effect === null) return;
  switch (effect.kind) {
    case "deploy":
      context.run("Deploy ERC20", async (writer) =>
        context.onCreated(await writer.createToken(effect.name, effect.symbol)),
      );
      return;
    case "pool":
      context.run("Create pool", async (writer) =>
        context.onCreated(
          await writer.createPool(effect.exchange, effect.first, effect.second),
        ),
      );
      return;
    case "register":
      context.registerToken(effect.token);
      return;
    case "read":
      void context.client.importToken(effect.request.address).then(
        (token) =>
          dispatchAssetEvent(context, {
            kind: "imported",
            id: effect.request.id,
            token,
          }),
        (error: unknown) =>
          dispatchAssetEvent(context, {
            kind: "failed",
            id: effect.request.id,
            message: errorMessage(error),
          }),
      );
  }
}
