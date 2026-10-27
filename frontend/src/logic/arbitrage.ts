import "../generated/dex_logic.js";
import { tokenDecimals } from "../chain/amounts";
import type { Opportunity, Pool, Token } from "../chain/types";

type WirePool = {
  exchange: string;
  id: string;
  token0: string;
  token1: string;
  reserve0: string;
  reserve1: string;
};
type WireOpportunity = {
  buy: WirePool;
  sell: WirePool;
  tokenIn: string;
  amountIn: string;
  intermediateAmount: string;
  amountOut: string;
  profit: string;
};
type PreparedWire = {
  ok: true;
  route: WireOpportunity;
  minimumProfit: string;
  deadline: string;
  requiresApproval: boolean;
};
type RejectedWire = { ok: false; error: string };
type Kernel = {
  scan: (input: string) => string;
  prepare: (input: string) => string;
  preview: (input: string) => string;
};
const kernel = () =>
  (globalThis as unknown as { DEXArbitrage: Kernel }).DEXArbitrage;

function poolWire(pool: Pool): WirePool {
  return {
    exchange: pool.exchange.address,
    id: pool.id.toString(),
    token0: pool.token0,
    token1: pool.token1,
    reserve0: pool.reserve0.toString(),
    reserve1: pool.reserve1.toString(),
  };
}
function opportunityWire(route: Opportunity): WireOpportunity {
  return {
    buy: poolWire(route.buy),
    sell: poolWire(route.sell),
    tokenIn: route.tokenIn,
    amountIn: route.amountIn.toString(),
    intermediateAmount: route.intermediateAmount.toString(),
    amountOut: route.amountOut.toString(),
    profit: route.profit.toString(),
  };
}
function key(pool: Pick<WirePool, "exchange" | "id">) {
  return `${pool.exchange.toLowerCase()}:${pool.id}`;
}
function decodeOpportunity(
  value: WireOpportunity,
  pools: Pool[],
  quotedAtBlock: number
): Opportunity {
  const indexed = new Map(pools.map((pool) => [key(poolWire(pool)), pool]));
  // scan_members proves both records came from this input pool list.
  return {
    buy: indexed.get(key(value.buy))!,
    sell: indexed.get(key(value.sell))!,
    tokenIn: value.tokenIn,
    amountIn: BigInt(value.amountIn),
    intermediateAmount: BigInt(value.intermediateAmount),
    amountOut: BigInt(value.amountOut),
    profit: BigInt(value.profit),
    quotedAtBlock,
  };
}

export function scanArbitrage(
  selected: Pool,
  pools: Pool[],
  tokenIn: string,
  quotedAtBlock: number,
  supportedTokens: readonly Token[]
): Opportunity[] {
  const output = JSON.parse(
    kernel().scan(
      JSON.stringify({
        decimals: tokenDecimals(supportedTokens, tokenIn).toString(),
        selected: poolWire(selected),
        supportedTokens: supportedTokens.map((token) => token.address),
        pools: pools.map(poolWire),
        tokenIn,
      })
    )
  ) as WireOpportunity[];
  return output.map((route) => decodeOpportunity(route, pools, quotedAtBlock));
}

export function arbitragePreview(
  arbitrage: string,
  route: Opportunity | undefined,
  minimum: string,
  balance: bigint,
  principal: Token
): { canExecute: boolean; error: string | null } {
  return JSON.parse(
    kernel().preview(
      JSON.stringify({
        arbitrage,
        decimals: principal.decimals.toString(),
        route: route ? opportunityWire(route) : null,
        minimum,
        balance: balance.toString(),
      })
    )
  );
}

export function prepareArbitrage(input: {
  arbitrage: string;
  route: Opportunity;
  token: Token;
  pools: Pool[];
  supportedTokens: readonly Token[];
  minimum: string;
  balance: bigint;
  allowance: bigint;
  now: bigint;
  block: number;
}) {
  const output = JSON.parse(
    kernel().prepare(
      JSON.stringify({
        arbitrage: input.arbitrage,
        decimals: input.token.decimals.toString(),
        supportedTokens: input.supportedTokens.map((token) => token.address),
        buy: poolWire(input.route.buy),
        sell: poolWire(input.route.sell),
        pools: input.pools.map(poolWire),
        tokenIn: input.route.tokenIn,
        amountIn: input.route.amountIn.toString(),
        minimum: input.minimum.toString(),
        balance: input.balance.toString(),
        allowance: input.allowance.toString(),
        now: input.now.toString(),
      })
    )
  ) as PreparedWire | RejectedWire;
  if (!output.ok) throw new Error(output.error);
  return {
    route: decodeOpportunity(output.route, input.pools, input.block),
    minimumProfit: BigInt(output.minimumProfit),
    deadline: BigInt(output.deadline),
    requiresApproval: output.requiresApproval,
  };
}
