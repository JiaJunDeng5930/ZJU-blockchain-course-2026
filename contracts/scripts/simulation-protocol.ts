export type SimulationOptions = {
  rounds: number;
  seed: number;
  durationSeconds: number;
  intervalMs: number;
};
export type SimulationAction =
  | "swap"
  | "addLiquidity"
  | "removeLiquidity"
  | "arbitrage"
  | "approve"
  | "expectedArbitrageRevert";
export type SimulationTransaction = {
  action: SimulationAction;
  account: string;
  hash: string;
  blockNumber: number;
  gasUsed: string;
  status: number;
  liquidity?: { exchange: string; poolId: string; positionId: string };
};
export type SimulationPositionEvidence = {
  exchange: string;
  poolId: string;
  positionId: string;
  account: string;
  mintHash: string;
  redeemHash: string | null;
};
export type SimulationJournalSummary = {
  transactionCount: number;
  positions: SimulationPositionEvidence[];
};
export type MarketSnapshot = {
  exchange: string;
  address: string;
  poolId: string;
  token0: string;
  token1: string;
  reserve0: string;
  reserve1: string;
  reserve0Formatted: string;
  reserve1Formatted: string;
  priceToken1PerToken0: number;
};
export type SimulationArbitrage = {
  hash: string;
  capitalToken: string;
  amountIn: string;
  profit: string;
  profitFormatted: string;
  expectedProfit: string;
  buyExchange: string;
  sellExchange: string;
  gasUsed: string;
  gasCostWei: string;
  profitExcludesGas: true;
  before: MarketSnapshot[];
  after: MarketSnapshot[];
};
export type SimulationProgress = {
  startedAt: string;
  elapsedSeconds: number;
  completedRounds: number;
  requestedRounds: number;
  requestedDurationSeconds: number;
  phase: "preparing" | "trading" | "redeeming" | "verifying";
  accounts: string[];
  activeAccounts: number;
  accountOperations: Record<string, number>;
  counts: {
    swap: number;
    addLiquidity: number;
    removeLiquidity: number;
    arbitrage: number;
  };
  transactions: SimulationTransaction[];
  transactionCount: number;
  markets: MarketSnapshot[];
  marketHistory: MarketSnapshot[][];
  arbitrages: SimulationArbitrage[];
  profits: { token: string; symbol: string; amount: string }[];
};
export type SimulationReport = Omit<
  SimulationProgress,
  "phase" | "markets" | "marketHistory" | "profits" | "accountOperations"
> & {
  version: 1;
  status: "completed" | "stopped";
  chainId: number;
  finishedAt: string;
  seed: number;
  intervalMs: number;
  initial: MarketSnapshot[];
  final: MarketSnapshot[];
  rollback: {
    hash: string;
    status: number;
    reservesAndTokenBalancesUnchanged: boolean;
    before: unknown;
    after: unknown;
  };
};
export type SimulationMessage =
  | { type: "transaction"; transaction: SimulationTransaction }
  | { type: "progress"; progress: SimulationProgress }
  | { type: "finished"; report: SimulationReport };
export type SimulationJob = {
  id: string | null;
  state:
    | "idle"
    | "starting"
    | "running"
    | "stopping"
    | "completed"
    | "stopped"
    | "failed";
  options: SimulationOptions | null;
  progress: SimulationProgress | null;
  finishedAt: string | null;
  error: string | null;
  reportAvailable: boolean;
  rollback: SimulationReport["rollback"] | null;
  journal?: SimulationJournalSummary;
};
export type SimulationJournal = {
  version: 1;
  jobId: string;
  state: SimulationJob["state"];
  options: SimulationOptions | null;
  finishedAt: string | null;
  error: string | null;
  transactions: SimulationTransaction[];
  positions: SimulationPositionEvidence[];
};
