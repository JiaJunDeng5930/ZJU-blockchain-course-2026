import { getAddress } from "viem";
import type { Exchange, Pool } from "../chain/types";
import {
  decodeSwapView,
  serializeSwapContext,
  type SwapContext,
  type SwapEvent,
} from "./trade";

export type RoutedSwapContext = SwapContext & {
  pools: readonly Pool[];
  exchanges: readonly Exchange[];
  block?: number;
};
export type RoutedSwapEvent = SwapEvent | { kind: "route"; value: string };
export type RoutedSwapPlan = {
  readonly kind: "swap";
  readonly pool: Pool;
  readonly inputToken: string;
  readonly outputToken: string;
  readonly input: bigint;
  readonly quoted: bigint;
  readonly minimum: bigint;
  readonly slippage: bigint;
  readonly block?: number;
};
type WirePool = Omit<
  Pool,
  "id" | "reserve0" | "reserve1" | "totalShares" | "createdAt"
> & {
  id: string;
  reserve0: string;
  reserve1: string;
  totalShares: string;
  createdAt: string;
};
type WireRouting = {
  mode: "auto" | "manual";
  manualKey: string | null;
  manualUnavailable: boolean;
  pairKey: string | null;
  pairs: { key: string; token0: string; token1: string }[];
  route: WirePool | null;
  routes: { key: string; pool: WirePool; quoted: string | null }[];
  block: string;
  effect:
    | null
    | { kind: "wallet" }
    | {
        kind: "swap";
        pool: WirePool;
        minimum: string;
        block: string;
      };
};
const encodePool = (pool: Pool) => ({
  exchange: { ...pool.exchange, address: getAddress(pool.exchange.address) },
  id: pool.id.toString(),
  token0: getAddress(pool.token0),
  token1: getAddress(pool.token1),
  reserve0: pool.reserve0.toString(),
  reserve1: pool.reserve1.toString(),
  totalShares: pool.totalShares.toString(),
  createdAt: pool.createdAt.toString(),
});
const decodePool = (pool: WirePool): Pool => ({
  ...pool,
  exchange: { ...pool.exchange, address: getAddress(pool.exchange.address) },
  token0: getAddress(pool.token0),
  token1: getAddress(pool.token1),
  id: BigInt(pool.id),
  reserve0: BigInt(pool.reserve0),
  reserve1: BigInt(pool.reserve1),
  totalShares: BigInt(pool.totalShares),
  createdAt: BigInt(pool.createdAt),
});
const encodeContext = (context: RoutedSwapContext) =>
  JSON.stringify({
    ...JSON.parse(serializeSwapContext(context)),
    pools: context.pools.map(encodePool),
    exchanges: context.exchanges.map((exchange) =>
      getAddress(exchange.address)
    ),
    metadata: context.tokens.map((token) => ({
      address: getAddress(token.address),
      decimals: token.decimals.toString(),
    })),
    block: context.block?.toString() ?? "0",
  });
function decode(serialized: string) {
  const base = decodeSwapView(serialized);
  const value = JSON.parse(serialized) as WireRouting;
  const effect: null | { kind: "wallet" } | RoutedSwapPlan =
    base.effect?.kind === "swap" && value.effect?.kind === "swap"
      ? {
          ...base.effect,
          outputToken: base.outputToken,
          pool: decodePool(value.effect.pool),
          minimum: BigInt(value.effect.minimum),
          block: Number(value.effect.block),
        }
      : base.effect?.kind === "wallet"
      ? base.effect
      : null;
  return {
    ...base,
    effect,
    mode: value.mode,
    manualKey: value.manualKey,
    manualUnavailable: value.manualUnavailable,
    pairKey: value.pairKey,
    pairs: value.pairs,
    route: value.route === null ? undefined : decodePool(value.route),
    routes: value.routes.map((row) => ({
      ...row,
      pool: decodePool(row.pool),
      quoted: row.quoted === null ? undefined : BigInt(row.quoted),
    })),
    block: Number(value.block),
  };
}
export type RoutedSwapView = ReturnType<typeof decode>;

/** Uses the extracted routing model; this adapter only encodes wire values. */
export function createRoutedSwapController(token0: string) {
  const controller = globalThis.DEXTrade.createRouted(getAddress(token0));
  return {
    view: (context: RoutedSwapContext) =>
      decode(controller.view(encodeContext(context))),
    dispatch: (event: RoutedSwapEvent, context: RoutedSwapContext) =>
      decode(
        controller.dispatch(
          JSON.stringify(
            event.kind === "pay" || event.kind === "receive"
              ? { ...event, value: getAddress(event.value) }
              : event
          ),
          encodeContext(context)
        )
      ),
  };
}
