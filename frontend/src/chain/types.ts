import type {
  TransactionDescriptor,
  TransactionReplacement,
} from "../wallet/kernel";
import type { TransactionReceipt } from "viem";

export type Token = {
  address: string;
  name: string;
  symbol: string;
  kind: "faucet" | "wrapped" | "external";
  decimals: number;
};
export type Exchange = { address: string; name: string };
export type TokenCreationConfirmation = {
  kind: "token";
  address: string;
  name: string;
  symbol: string;
  receipt: TransactionReceipt;
};
export type AssetFundingConfirmation = {
  recipient: string;
  amount: bigint;
  gasCostWei: bigint;
  receipt: TransactionReceipt;
} & ({ kind: "native" } | { kind: "token"; token: Token });
export type PoolCreationConfirmation = {
  kind: "pool";
  exchange: Exchange;
  poolId: bigint;
  token0: string;
  token1: string;
  receipt: TransactionReceipt;
};
export type AssetCreationConfirmation =
  | TokenCreationConfirmation
  | PoolCreationConfirmation;
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
export type ArbitrageReserveSnapshot = Pick<
  Pool,
  "exchange" | "id" | "token0" | "token1" | "reserve0" | "reserve1"
>;
export type ArbitrageResult = {
  trader: string;
  intermediateAmount: bigint;
  tokenIn: string;
  amountIn: bigint;
  amountOut: bigint;
  profit: bigint;
  /** Execute transaction only; excludes preceding ERC20 approval fees. */
  gasCostWei: bigint;
  receipt: TransactionReceipt;
  before: ArbitrageReserveSnapshot[];
  after: ArbitrageReserveSnapshot[];
};
export type ArbitrageReceiptDetails = {
  result: ArbitrageResult;
  tokens: readonly [Token, Token];
};
export type SwapResult = {
  gasCostWei: bigint;
  pool: Pool;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  quoted: bigint;
  minimum: bigint;
  receipt: TransactionReceipt;
};
export type WrappingConfirmation = {
  kind: "wrap" | "unwrap";
  token: string;
  owner: string;
  amount: bigint;
  gasCostWei: bigint;
  nativeChangeWei: bigint;
  wrappedChange: bigint;
  receipt: TransactionReceipt;
};
export type LiquidityConfirmation = {
  gasCostWei: bigint;
  pool: Pool;
  positionId: bigint;
  receipt: TransactionReceipt;
} & (
  | {
      kind: "deposit" | "redeem";
      owner: string;
      amount0: bigint;
      amount1: bigint;
      shares: bigint;
    }
  | { kind: "transfer"; from: string; to: string }
);

export type LiquidityReceiptDetails = {
  confirmation: LiquidityConfirmation;
  tokens: readonly [Token, Token];
};

export type JournalEntry = {
  descriptor: TransactionDescriptor | null;
  originalHash: string | null;
  replacements: TransactionReplacement[];
  id: string;
  label: string;
  account: string;
  beneficiary?: string;
  authority: "wallet" | "dev-faucet";
} & (
  | { state: "awaiting-wallet" }
  | { state: "submitted"; hash: string; message?: string | null }
  | { state: "confirmed"; hash: string; block: bigint; gas: bigint }
  | {
      state: "failed";
      message: string;
      hash?: string;
      block?: bigint;
      gas?: bigint;
    }
  | { state: "submission-unknown"; message: string }
  | {
      state: "replaced";
      hash: string;
      message: string;
      block?: bigint;
      gas?: bigint;
    }
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
