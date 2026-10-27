import "../generated/dex_logic.js";
import { getAddress } from "viem";
import type { Exchange, Pool, Token } from "../chain/types";

type AssetsRuntime = {
  poolSelection(value: string): string;
  poolAssetsSupported(value: string): boolean;
  runtimeCodeMatches(actual: string, expected: string): boolean;
  unsupportedPoolError: string;
  poolPrice(
    first: string,
    second: string,
    decimals0: string,
    decimals1: string,
    symbol0: string,
    symbol1: string
  ): string;
  initialCatalog(deployed: string, saved: string): string;
  registerCatalog(state: string, additions: string): string;
  catalogView(state: string, markets: string): string;
  storageError(state: string, message: string): string;
  initialForms(environment: string): string;
  stepForms(state: string, environment: string, event: string): string;
  formsView(state: string, environment: string): string;
  canonicalAddress(raw: string): string;
  metadata(value: string): string;
  deployment(name: string, symbol: string): string;
  pool(value: string): string;
  faucet(token: string): string;
  deployed(name: string, symbol: string, token: string): string;
  receipt(address: string): string;
};
declare global {
  var DEXAssets: AssetsRuntime;
}
const encode = JSON.stringify;
const marketRecords = (pools: Pool[]) =>
  pools.map((pool) => ({
    exchange: pool.exchange.address,
    token0: pool.token0,
    token1: pool.token1,
  }));
export type AssetEnvironment = {
  exchanges: string[];
  tokens: string[];
  markets: { exchange: string; token0: string; token1: string }[];
  connected: boolean;
  pending: boolean;
};
export const assetEnvironment = (
  exchanges: Exchange[],
  tokens: Token[],
  pools: Pool[],
  connected: boolean,
  pending: boolean
): AssetEnvironment => ({
  exchanges: exchanges.map((exchange) => exchange.address),
  tokens: tokens.map((token) => token.address),
  markets: marketRecords(pools),
  connected,
  pending,
});
export type DeploymentPlan = { kind: "deploy"; name: string; symbol: string };
export type PoolPlan = {
  kind: "pool";
  exchange: string;
  first: string;
  second: string;
};
export type FaucetPlan = { kind: "faucet"; address: string };
export type AssetEffect =
  | DeploymentPlan
  | PoolPlan
  | { kind: "read"; request: { id: string; address: string } }
  | { kind: "register"; token: Token }
  | null;
export type AssetField =
  | "name"
  | "symbol"
  | "address"
  | "exchange"
  | "first"
  | "second";
export type AssetEvent =
  | { kind: "edit"; field: AssetField; value: string }
  | { kind: "import" | "deploy" | "pool" }
  | { kind: "imported"; id: string; token: Token }
  | { kind: "failed"; id: string; message: string };
export type AssetFormsView = {
  draft: Record<AssetField, string>;
  canImport: boolean;
  canDeploy: boolean;
  canCreatePool: boolean;
  importing: boolean;
  importError: string | null;
  deploymentError: string | null;
  poolError: string | null;
};
export class AssetForms {
  private state: string;
  private readonly listeners = new Set<() => void>();
  constructor(environment: AssetEnvironment) {
    this.state = globalThis.DEXAssets.initialForms(encode(environment));
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  view(environment: AssetEnvironment): AssetFormsView {
    return JSON.parse(
      globalThis.DEXAssets.formsView(this.state, encode(environment))
    );
  }
  dispatch(environment: AssetEnvironment, event: AssetEvent): AssetEffect {
    const result = JSON.parse(
      globalThis.DEXAssets.stepForms(
        this.state,
        encode(environment),
        encode(event)
      )
    ) as { state: string; effect: AssetEffect };
    this.state = result.state;
    this.listeners.forEach((listener) => listener());
    return result.effect;
  }
}
export const initialCatalog = (deployed: Token[], saved: string) =>
  globalThis.DEXAssets.initialCatalog(encode(deployed), saved);
export const registerCatalog = (state: string, additions: Token[]) =>
  globalThis.DEXAssets.registerCatalog(state, encode(additions));
export const catalogStorageError = (state: string, message: string) =>
  globalThis.DEXAssets.storageError(state, message);
export const catalogView = (
  state: string,
  pools: Pool[]
): {
  tokens: Token[];
  storedTokens: unknown[];
  discovery: string[];
  error: string | null;
} => {
  const view = JSON.parse(
    globalThis.DEXAssets.catalogView(state, encode(marketRecords(pools)))
  );
  return {
    ...view,
    tokens: view.tokens.map((token: Token) => ({
      ...token,
      address: getAddress(token.address),
    })),
  };
};
export function canonicalAssetAddress(raw: string): string {
  const result = JSON.parse(globalThis.DEXAssets.canonicalAddress(raw)) as {
    address: string | null;
    error: string | null;
  };
  if (result.address === null) throw new Error(result.error!);
  return result.address;
}
export function recognizeAsset(metadata: {
  address: string;
  name: string;
  symbol: string;
  decimals: string;
  code: string;
  expectedCode: string;
}): Token {
  const result = JSON.parse(
    globalThis.DEXAssets.metadata(encode(metadata))
  ) as { token: Token | null; error: string | null };
  if (result.token === null) throw new Error(result.error!);
  return { ...result.token, address: getAddress(result.token.address) };
}
function acceptedPlan<T>(json: string): T {
  const result = JSON.parse(json) as { call: T | null; error: string | null };
  if (result.call === null) throw new Error(result.error!);
  return result.call;
}
export const deploymentPlan = (name: string, symbol: string) =>
  acceptedPlan<DeploymentPlan>(globalThis.DEXAssets.deployment(name, symbol));
export const createPoolPlan = (
  environment: AssetEnvironment,
  exchange: string,
  first: string,
  second: string
) =>
  acceptedPlan<PoolPlan>(
    globalThis.DEXAssets.pool(
      encode({ ...environment, exchange, first, second })
    )
  );
export const faucetPlan = (token: Token) =>
  acceptedPlan<FaucetPlan>(globalThis.DEXAssets.faucet(encode(token)));
export function deploymentAddress(address: string | null | undefined): string {
  const result = JSON.parse(
    globalThis.DEXAssets.receipt(encode(address ?? null))
  ) as { address: string | null; error: string | null };
  if (result.address === null) throw new Error(result.error!);
  return result.address;
}
export function verifyDeployedAsset(
  name: string,
  symbol: string,
  token: Token
): void {
  const error = JSON.parse(
    globalThis.DEXAssets.deployed(name, symbol, encode(token))
  ) as string | null;
  if (error !== null) throw new Error(error);
}

export class AssetCatalog {
  private state: string;
  private readonly listeners = new Set<() => void>();
  constructor(deployed: Token[], saved: string) {
    this.state = initialCatalog(deployed, saved);
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: string) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  register(tokens: Token[]) {
    this.publish(registerCatalog(this.state, tokens));
  }
  storageError(message: string) {
    this.publish(catalogStorageError(this.state, message));
  }
}

export const assetPoolPrice = (
  first: bigint,
  second: bigint,
  decimals0: number,
  decimals1: number,
  symbol0: string,
  symbol1: string
) =>
  globalThis.DEXAssets.poolPrice(
    first.toString(),
    second.toString(),
    decimals0.toString(),
    decimals1.toString(),
    symbol0,
    symbol1
  );

export const poolAssetsSupported = (
  pool: Pick<Pool, "token0" | "token1">,
  tokens: readonly Token[]
) =>
  globalThis.DEXAssets.poolAssetsSupported(
    encode({
      tokens: tokens.map((token) => token.address),
      first: pool.token0,
      second: pool.token1,
    })
  );
export function assertSupportedPool(
  pool: Pick<Pool, "token0" | "token1">,
  tokens: readonly Token[]
): void {
  if (!poolAssetsSupported(pool, tokens))
    throw new Error(globalThis.DEXAssets.unsupportedPoolError);
}
export const runtimeCodeMatches = (
  actual: string | undefined,
  expected: string
) => globalThis.DEXAssets.runtimeCodeMatches(actual ?? "", expected);
export const unsupportedPoolError: string =
  globalThis.DEXAssets.unsupportedPoolError;
