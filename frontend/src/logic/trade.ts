import "../generated/dex_logic.js";
import type { Pool, Token } from "../chain/types";

type RawController = {
  view(context: string): string;
  dispatch(event: string, context: string): string;
};
type TradeRuntime = {
  create(token0: string): RawController;
  makeParameters(request: string): string;
  parameterError: string;
};
declare global {
  var DEXTrade: TradeRuntime;
}

type WireEffect =
  | null
  | { kind: "wallet" }
  | {
      kind: "swap";
      inputToken: string;
      input: string;
      quoted: string;
      slippage: string;
    };
type WireView = {
  amount: string | null;
  output: string | null;
  minimum: string | null;
  slippage: string | null;
  outputToken: string;
  fee: string | null;
  feePercent: string;
  deadlineText: string;
  impactText: string | null;
  highImpact: boolean;
  rateText: string | null;
  hasAmount: boolean;
  funded: boolean;
  canSubmit: boolean;
  disabled: boolean;
  actionLabel: string;
  message: string | null;
  canMax: boolean;
  showMax: boolean;
  maxText: string | null;
  reverseText: string;
  amountText: string;
  slippageText: string;
  inputToken: string;
  balance: string | null;
  outputBalance: string | null;
  effect: WireEffect;
};
export type SwapContext = {
  tokens: readonly Token[];
  pool: Pool;
  balances?: Record<string, bigint>;
  connected: boolean;
  pending: boolean;
};
export type SwapEvent =
  | { kind: "amount" | "slippage" | "pay" | "receive"; value: string }
  | { kind: "reverse" | "max" | "submit" };
export type SwapEffect =
  | null
  | { kind: "wallet" }
  | {
      kind: "swap";
      inputToken: string;
      input: bigint;
      quoted: bigint;
      slippage: bigint;
    };
const integer = (value: string | null) =>
  value === null ? undefined : BigInt(value);
const contextJSON = ({
  pool,
  tokens,
  balances,
  connected,
  pending,
}: SwapContext) =>
  JSON.stringify({
    assets: tokens.map((token) => token.address),
    token0: pool.token0,
    token1: pool.token1,
    reserve0: pool.reserve0.toString(),
    reserve1: pool.reserve1.toString(),
    balance0: balances?.[pool.token0]?.toString() ?? null,
    balance1: balances?.[pool.token1]?.toString() ?? null,
    connected,
    pending,
  });
function decode(serialized: string) {
  const value = JSON.parse(serialized) as WireView;
  const effect: SwapEffect =
    value.effect === null || value.effect.kind === "wallet"
      ? value.effect
      : {
          kind: "swap",
          inputToken: value.effect.inputToken,
          input: BigInt(value.effect.input),
          quoted: BigInt(value.effect.quoted),
          slippage: BigInt(value.effect.slippage),
        };
  return {
    ...value,
    amount: integer(value.amount),
    output: integer(value.output),
    minimum: integer(value.minimum),
    fee: integer(value.fee),
    slippage: integer(value.slippage),
    balance: integer(value.balance),
    outputBalance: integer(value.outputBalance),
    effect,
  };
}
export function createSwapController(token0: string) {
  const controller = globalThis.DEXTrade.create(token0);
  return {
    view: (context: SwapContext) =>
      decode(controller.view(contextJSON(context))),
    dispatch: (event: SwapEvent, context: SwapContext) =>
      decode(controller.dispatch(JSON.stringify(event), contextJSON(context))),
  };
}
export function makeSwapParameters(
  input: bigint,
  quoted: bigint,
  slippage: bigint,
  now: bigint,
) {
  const result = JSON.parse(
    globalThis.DEXTrade.makeParameters(
      JSON.stringify({
        input: input.toString(),
        quoted: quoted.toString(),
        slippage: slippage.toString(),
        now: now.toString(),
      }),
    ),
  ) as { input: string; minimum: string; deadline: string } | null;
  if (result === null) throw new Error(globalThis.DEXTrade.parameterError);
  return {
    input: BigInt(result.input),
    minimum: BigInt(result.minimum),
    deadline: BigInt(result.deadline),
  };
}
