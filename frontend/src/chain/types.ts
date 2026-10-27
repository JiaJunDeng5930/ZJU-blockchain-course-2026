import type { TransactionReceipt } from "viem";

export type Token = {
  address: string;
  name: string;
  symbol: string;
  kind: "faucet" | "wrapped" | "external";
};
export type Exchange = { address: string; name: string };
export type Deployment = {
  schemaVersion: 1;
  chainId: number;
  rpcUrl: string;
  tokens: Token[];
  exchanges: Exchange[];
  arbitrage: string;
  bytecodes: { TestToken: string };
};
export type Pool = {
  exchange: Exchange;
  id: bigint;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  totalShares: bigint;
  createdAt: bigint;
};
export type Position = {
  exchange: Exchange;
  id: bigint;
  poolId: bigint;
  shares: bigint;
  amount0: bigint;
  amount1: bigint;
  createdAt: bigint;
  owner: string;
};
export type ChainSnapshot = {
  block: number;
  pools: Pool[];
  positions: Position[];
  balances: Record<string, bigint>;
  ether: bigint;
};
export type Opportunity = {
  buy: Pool;
  sell: Pool;
  tokenIn: string;
  amountIn: bigint;
  intermediateAmount: bigint;
  amountOut: bigint;
  profit: bigint;
  quotedAtBlock: number;
};
export type ArbitrageResult = {
  tokenIn: string;
  profit: bigint;
  receipt: TransactionReceipt;
  before: Pool[];
  after: Pool[];
};
export type JournalEntry = {
  id: string;
  label: string;
  account: string;
  beneficiary?: string;
  authority: "wallet" | "dev-faucet";
} & (
  | { state: "awaiting-wallet" }
  | { state: "submitted"; hash: string }
  | { state: "confirmed"; hash: string; block: bigint; gas: bigint }
  | { state: "failed"; message: string; hash?: string }
  | { state: "submission-unknown"; message: string }
);

export type LiquidityActivity = {
  block: number;
  volume0: bigint;
  volume1: bigint;
  fees0: bigint;
  fees1: bigint;
  swaps: number;
  events: {
    kind: "added" | "removed";
    positionId: bigint;
    actor: string;
    amount0: bigint;
    amount1: bigint;
    block: number;
    index: number;
    hash: string;
  }[];
};
