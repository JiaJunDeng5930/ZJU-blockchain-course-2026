import "../generated/dex_logic.js";

type ExecutionFact = {
  index: number;
  source: string;
  buy: string;
  sell: string;
};
type SnapshotFact = { index: number; source: string; exchange: string };
type Selection =
  | { kind: "none" | "unsupported" | "reverted" }
  | { kind: "selected"; execution: number; buy: number; sell: number };

declare global {
  var DEXArbitrageReceipt: {
    select: (observation: string) => string;
    intermediate: (observation: string) => string;
  };
}

export function arbitrageIntermediateToken(
  token0: string,
  token1: string,
  capital: string,
): string {
  return globalThis.DEXArbitrageReceipt.intermediate(
    JSON.stringify({
      token0: token0.toLowerCase(),
      token1: token1.toLowerCase(),
      capital: capital.toLowerCase(),
    }),
  );
}

export function selectArbitrageReceipt(
  successful: boolean,
  contract: string,
  exchanges: string[],
  executions: ExecutionFact[],
  snapshots: SnapshotFact[],
): Selection {
  return JSON.parse(
    globalThis.DEXArbitrageReceipt.select(
      JSON.stringify({
        successful,
        contract,
        exchanges,
        executions,
        snapshots,
      }),
    ),
  ) as Selection;
}
