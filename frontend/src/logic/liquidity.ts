import "../generated/dex_logic.js";
import { getAddress, type Address } from "viem";
import type { Pool, Position } from "../chain/types";

type Raw = Record<string, string>;
type DepositWire = { [K in keyof DepositPlan]: string };
type WithdrawRequest = ReturnType<typeof poolWire> & {
  shares: string;
  expectedPool: string;
  actualPool: string;
  expected0: string;
  expected1: string;
  owner: string;
  current: string;
  slippageBps: string;
  now: string;
};
type WireDeposit =
  { ok: false; error: string | null } | ({ ok: true } & DepositWire);
export type DepositPlan = {
  desired0: bigint;
  desired1: bigint;
  used0: bigint;
  used1: bigint;
  unused0: bigint;
  unused1: bigint;
  shares: bigint;
  minimum0: bigint;
  minimum1: bigint;
};
export type DepositDecision =
  { ok: false; error: string | null } | ({ ok: true } & DepositPlan);
type Runtime = {
  [
    K in
      | "analyzeDeposit"
      | "depositAmounts"
      | "counterpart"
      | "positionView"
      | "transferError"
      | "aggregateActivity"
      | "writeDeposit"
      | "writeWithdraw"
      | "ownedPositions"
      | "poolPositions"
  ]: (json: string) => string;
};
declare global {
  var DEXLiquidity: Runtime;
}
const poolWire = (pool: Pool) => ({
  reserve0: pool.reserve0.toString(),
  reserve1: pool.reserve1.toString(),
  totalShares: pool.totalShares.toString(),
});
function decodePlan(wire: DepositWire): DepositPlan {
  return {
    desired0: BigInt(wire.desired0),
    desired1: BigInt(wire.desired1),
    used0: BigInt(wire.used0),
    used1: BigInt(wire.used1),
    unused0: BigInt(wire.unused0),
    unused1: BigInt(wire.unused1),
    shares: BigInt(wire.shares),
    minimum0: BigInt(wire.minimum0),
    minimum1: BigInt(wire.minimum1),
  };
}
export function depositPreview(
  pool: Pool,
  amount0: string,
  amount1: string,
  slippage: string,
  balance0: bigint,
  balance1: bigint,
): DepositDecision {
  const wire = JSON.parse(
    globalThis.DEXLiquidity.analyzeDeposit(
      JSON.stringify({
        ...poolWire(pool),
        amount0,
        amount1,
        slippage,
        balance0: balance0.toString(),
        balance1: balance1.toString(),
      }),
    ),
  ) as WireDeposit;
  return wire.ok ? { ok: true, ...decodePlan(wire) } : wire;
}
export function depositAmounts(
  pool: Pool,
  desired0: bigint,
  desired1: bigint,
): readonly [bigint, bigint] {
  const wire = JSON.parse(
    globalThis.DEXLiquidity.depositAmounts(
      JSON.stringify({
        ...poolWire(pool),
        desired0: desired0.toString(),
        desired1: desired1.toString(),
      }),
    ),
  ) as [string, string];
  return [BigInt(wire[0]), BigInt(wire[1])];
}
export function counterpartAmount(
  pool: Pool,
  amount: string,
  index: 0 | 1,
): string | null {
  return JSON.parse(
    globalThis.DEXLiquidity.counterpart(
      JSON.stringify({ ...poolWire(pool), amount, second: index === 1 }),
    ),
  );
}
export function positionView(pool: Pool, position: Position) {
  const wire = JSON.parse(
    globalThis.DEXLiquidity.positionView(
      JSON.stringify({
        ...poolWire(pool),
        shares: position.shares.toString(),
        original0: position.amount0.toString(),
        original1: position.amount1.toString(),
      }),
    ),
  ) as Raw;
  return {
    amounts: [BigInt(wire.amount0), BigInt(wire.amount1)] as const,
    heldValue: BigInt(wire.heldValue),
    currentValue: BigInt(wire.currentValue),
    valueChange: BigInt(wire.valueChange),
    sharePercent: wire.sharePercent,
    valueSign: wire.valueSign,
  };
}
export function prepareTransfer(
  owner: string,
  current: string,
  recipient: string,
): { ok: false; error: string } | { ok: true; recipient: Address } {
  // The transport decoder checks EIP-55; the verified policy receives success or failure.
  let decoded: Address | null;
  try {
    decoded = getAddress(recipient);
  } catch {
    decoded = null;
  }
  return JSON.parse(
    globalThis.DEXLiquidity.transferError(
      JSON.stringify({ owner, current, recipient: decoded }),
    ),
  );
}
export function transferError(
  owner: string,
  current: string,
  recipient: string,
): string | undefined {
  const plan = prepareTransfer(owner, current, recipient);
  return plan.ok ? undefined : plan.error;
}
export function aggregateActivity(
  token0: string,
  feeBps: bigint,
  trades: readonly { tokenIn: string; amountIn: bigint }[],
) {
  const wire = JSON.parse(
    globalThis.DEXLiquidity.aggregateActivity(
      JSON.stringify({
        token0,
        feeBps: feeBps.toString(),
        trades: trades.map((trade) => ({
          tokenIn: trade.tokenIn,
          amountIn: trade.amountIn.toString(),
        })),
      }),
    ),
  ) as Raw;
  return {
    volume0: BigInt(wire.volume0),
    volume1: BigInt(wire.volume1),
    fees0: BigInt(wire.fees0),
    fees1: BigInt(wire.fees1),
  };
}
export function prepareDepositWrite(
  pool: Pool,
  desired0: bigint,
  desired1: bigint,
  balance0: bigint,
  balance1: bigint,
  slippageBps: bigint,
  now: bigint,
  allowance0: bigint,
  allowance1: bigint,
) {
  const wire = JSON.parse(
    globalThis.DEXLiquidity.writeDeposit(
      JSON.stringify({
        ...poolWire(pool),
        desired0: desired0.toString(),
        desired1: desired1.toString(),
        balance0: balance0.toString(),
        balance1: balance1.toString(),
        slippageBps: slippageBps.toString(),
        now: now.toString(),
        allowance0: allowance0.toString(),
        allowance1: allowance1.toString(),
      }),
    ),
  ) as
    | { ok: false; error: string }
    | ({
        ok: true;
        deadline: string;
        approve0: boolean;
        approve1: boolean;
      } & DepositWire);
  if (!wire.ok) throw new Error(wire.error);
  return {
    ...decodePlan(wire),
    deadline: BigInt(wire.deadline),
    approve0: wire.approve0,
    approve1: wire.approve1,
  };
}
export function prepareWithdrawWrite(
  pool: Pool,
  shares: bigint,
  owner: string,
  current: string,
  slippageBps: bigint,
  now: bigint,
  actualPool: bigint,
  expected: readonly [bigint, bigint],
) {
  const wire = JSON.parse(
    globalThis.DEXLiquidity.writeWithdraw(
      JSON.stringify({
        ...poolWire(pool),
        shares: shares.toString(),
        expectedPool: pool.id.toString(),
        actualPool: actualPool.toString(),
        expected0: expected[0].toString(),
        expected1: expected[1].toString(),
        owner,
        current,
        slippageBps: slippageBps.toString(),
        now: now.toString(),
      } satisfies WithdrawRequest),
    ),
  ) as { ok: false; error: string } | ({ ok: true } & Raw);
  if (!wire.ok) throw new Error(wire.error);
  return {
    amount0: BigInt(wire.amount0),
    amount1: BigInt(wire.amount1),
    minimum0: BigInt(wire.minimum0),
    minimum1: BigInt(wire.minimum1),
    deadline: BigInt(wire.deadline),
  };
}

const positionKey = (position: Position) =>
  `${position.exchange.address.toLowerCase()}:${position.id}`;
const positionsWire = (positions: readonly Position[]) =>
  positions.map((position) => ({
    key: positionKey(position),
    owner: position.owner,
    pool: `${position.exchange.address.toLowerCase()}:${position.poolId}`,
    created: position.createdAt.toString(),
    id: position.id.toString(),
  }));
function projectedPositions(
  positions: readonly Position[],
  keys: string[],
): Position[] {
  const source = new Map(
    positions.map((position) => [positionKey(position), position]),
  );
  return keys.map((key) => source.get(key)!);
}
export function ownedPositions(
  positions: readonly Position[],
  owner: string,
): Position[] {
  const keys = JSON.parse(
    globalThis.DEXLiquidity.ownedPositions(
      JSON.stringify({ positions: positionsWire(positions), owner }),
    ),
  ) as string[];
  return projectedPositions(positions, keys);
}
export function poolPositions(
  positions: readonly Position[],
  pool: Pool,
): Position[] {
  const keys = JSON.parse(
    globalThis.DEXLiquidity.poolPositions(
      JSON.stringify({
        positions: positionsWire(positions),
        pool: `${pool.exchange.address.toLowerCase()}:${pool.id}`,
      }),
    ),
  ) as string[];
  return projectedPositions(positions, keys);
}
