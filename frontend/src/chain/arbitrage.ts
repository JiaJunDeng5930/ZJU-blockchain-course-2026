import {
  getAddress,
  parseEventLogs,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { arbitrageAbi, miniDexAbi, testTokenAbi } from "../generated/abis";
import {
  prepareArbitrage,
  arbitrageCapitalInput,
  quoteArbitrageAmount,
  scanArbitrage,
  summarizeArbitrageExecution,
} from "../logic/arbitrage";
import { selectArbitrageReceipt } from "../logic/arbitrageReceipt";
import { importAsset } from "./assets";
import { tokenDecimals } from "./amounts";
import { assertSupportedPool } from "../logic/assets";
import type { WalletSession } from "../wallet/session";
import type { ExchangeClient, SendTransaction } from "./client";
import type {
  ArbitrageResult,
  ArbitrageReceiptDetails,
  ArbitrageReserveSnapshot,
  Opportunity,
  Pool,
  Token,
} from "./types";

export async function opportunities(
  client: ExchangeClient,
  selected: Pool,
  _pools: Pool[],
  tokenIn: string,
  supportedTokens: readonly Token[],
): Promise<Opportunity[]> {
  assertSupportedPool(selected, supportedTokens);
  const block = await client.rpc.getBlockNumber();
  const pools = await client.pools(Number(block));
  return scanArbitrage(
    selected,
    pools,
    tokenIn,
    Number(block),
    supportedTokens,
  );
}

export async function quoteArbitrage(
  client: ExchangeClient,
  selected: Pool,
  tokenIn: string,
  amount: string,
  supportedTokens: readonly Token[],
): Promise<Opportunity[]> {
  assertSupportedPool(selected, supportedTokens);
  const input = arbitrageCapitalInput(
    amount,
    tokenDecimals(supportedTokens, tokenIn),
  );
  if (!input.canQuote) throw new Error(input.error!);
  const block = await client.rpc.getBlock({ blockTag: "latest" });
  const pools = await client.pools(Number(block.number));
  return quoteArbitrageAmount(
    selected,
    pools,
    tokenIn,
    amount,
    Number(block.number),
    supportedTokens,
  );
}

export async function executeArbitrage(
  context: {
    client: ExchangeClient;
    session: WalletSession;
    send: SendTransaction;
  },
  route: Opportunity,
  minimum: string,
): Promise<ArbitrageResult> {
  const { client, session, send } = context;
  const capital = getAddress(route.tokenIn);
  const arbitrage = getAddress(client.deployment.arbitrage);
  const block = await client.rpc.getBlock();
  const [pools, balance, allowance] = await Promise.all([
    client.pools(Number(block.number)),
    client.rpc.readContract({
      address: capital,
      abi: testTokenAbi,
      functionName: "balanceOf",
      args: [session.address],
      blockNumber: block.number,
    }),
    client.rpc.readContract({
      address: capital,
      abi: testTokenAbi,
      functionName: "allowance",
      args: [session.address, arbitrage],
      blockNumber: block.number,
    }),
  ]);
  // Quote state uses one mined block; the deadline uses the execution clock.
  const [verifiedTokens, preflightTimestamp] = await Promise.all([
    Promise.all([
      importAsset(client, route.buy.token0),
      importAsset(client, route.buy.token1),
    ]),
    client.transactionTimestamp(),
  ]);
  assertSupportedPool(route.buy, verifiedTokens);
  assertSupportedPool(route.sell, verifiedTokens);
  const prepareAt = (now: bigint) =>
    prepareArbitrage({
      arbitrage,
      route,
      pools,
      supportedTokens: verifiedTokens,
      token: verifiedTokens.find(
        (token) => getAddress(token.address) === capital,
      )!,
      minimum,
      balance,
      allowance,
      now,
      block: Number(block.number),
    });
  const approvalPlan = prepareAt(preflightTimestamp);
  if (approvalPlan.requiresApproval) {
    await send("Approve arbitrage capital", () =>
      session.walletClient.writeContract({
        account: session.address,
        chain: session.walletClient.chain,
        address: capital,
        abi: testTokenAbi,
        functionName: "approve",
        args: [arbitrage, approvalPlan.route.amountIn],
      }),
    );
  }
  // Keep the quoted route and profit bound; an approval wait only changes
  // the execution clock passed to the same extracted planner.
  const plan = prepareAt(await client.transactionTimestamp());
  const receipt = await send("Execute atomic arbitrage", () =>
    session.walletClient.writeContract({
      account: session.address,
      chain: session.walletClient.chain,
      address: arbitrage,
      abi: arbitrageAbi,
      functionName: "execute",
      args: [
        getAddress(plan.route.buy.exchange.address),
        plan.route.buy.id,
        getAddress(plan.route.sell.exchange.address),
        plan.route.sell.id,
        capital,
        plan.route.amountIn,
        plan.minimumProfit,
        plan.deadline,
      ],
    }),
  );
  return resultFromEvidence(receipt, decodeArbitrageEvents(client, receipt)!, [
    plan.route.buy,
    plan.route.sell,
  ]);
}

function decodeArbitrageEvents(
  client: ExchangeClient,
  receipt: TransactionReceipt,
) {
  const executions = parseEventLogs({
    abi: arbitrageAbi,
    eventName: "ArbitrageExecuted",
    logs: receipt.logs,
  });
  const snapshots = parseEventLogs({
    abi: arbitrageAbi,
    eventName: "PoolReservesChanged",
    logs: receipt.logs,
  });
  const selection = selectArbitrageReceipt(
    receipt.status === "success",
    getAddress(client.deployment.arbitrage).toLowerCase(),
    client.deployment.exchanges.map((exchange) =>
      getAddress(exchange.address).toLowerCase(),
    ),
    executions.map((event, index) => ({
      index,
      source: getAddress(event.address).toLowerCase(),
      buy: getAddress(event.args.buyDex).toLowerCase(),
      sell: getAddress(event.args.sellDex).toLowerCase(),
    })),
    snapshots.map((event, index) => ({
      index,
      source: getAddress(event.address).toLowerCase(),
      exchange: getAddress(event.args.exchange).toLowerCase(),
    })),
  );
  switch (selection.kind) {
    case "none":
      return null;
    case "reverted":
      // DEFENSE: a saved or supplied hash can refer to an actually reverted execution.
      throw new Error(
        "The transaction reverted and has no confirmed arbitrage result.",
      );
    case "unsupported":
      // DEFENSE: an external contract can call execute more than once in one transaction.
      throw new Error(
        "This receipt does not contain one complete arbitrage execution and its two reserve events.",
      );
  }
  return {
    execution: executions[selection.execution]!,
    buy: snapshots[selection.buy]!,
    sell: snapshots[selection.sell]!,
  };
}

type Evidence = NonNullable<ReturnType<typeof decodeArbitrageEvents>>;
type PoolIdentity = Pick<Pool, "exchange" | "id" | "token0" | "token1">;

function resultFromEvidence(
  receipt: TransactionReceipt,
  evidence: Evidence,
  pools: readonly [PoolIdentity, PoolIdentity],
): ArbitrageResult {
  const snapshots = [evidence.buy, evidence.sell].map((event, index) => {
    const pool = pools[index]!;
    const identity = {
      exchange: pool.exchange,
      id: pool.id,
      token0: pool.token0,
      token1: pool.token1,
    };
    return {
      before: {
        ...identity,
        reserve0: event.args.reserve0Before,
        reserve1: event.args.reserve1Before,
      },
      after: {
        ...identity,
        reserve0: event.args.reserve0After,
        reserve1: event.args.reserve1After,
      },
    } satisfies {
      before: ArbitrageReserveSnapshot;
      after: ArbitrageReserveSnapshot;
    };
  });
  const event = evidence.execution.args;
  return {
    trader: getAddress(event.trader),
    tokenIn: event.tokenIn,
    intermediateAmount: event.intermediateAmount,
    ...summarizeArbitrageExecution({
      amountIn: event.amountIn,
      amountOut: event.amountOut,
      profit: event.profit,
      gasUsed: receipt.gasUsed,
      gasPrice: receipt.effectiveGasPrice,
    }),
    receipt,
    before: snapshots.map((snapshot) => snapshot.before),
    after: snapshots.map((snapshot) => snapshot.after),
  };
}

export async function readArbitrageReceipt(
  client: ExchangeClient,
  hash: Hex,
): Promise<ArbitrageReceiptDetails | null> {
  return arbitrageReceiptFromReceipt(
    client,
    await client.rpc.getTransactionReceipt({ hash }),
  );
}

export async function arbitrageReceiptFromReceipt(
  client: ExchangeClient,
  receipt: TransactionReceipt,
): Promise<ArbitrageReceiptDetails | null> {
  const evidence = decodeArbitrageEvents(client, receipt);
  if (evidence === null) return null;
  const blockNumber = receipt.blockNumber;
  const readIdentity = async (
    event: Evidence["buy"],
  ): Promise<PoolIdentity> => {
    const address = getAddress(event.args.exchange);
    const exchange = client.deployment.exchanges.find(
      (item) => getAddress(item.address) === address,
    )!;
    const [token0, token1] = await client.rpc.readContract({
      address,
      abi: miniDexAbi,
      functionName: "pools",
      args: [event.args.poolId],
      blockNumber,
    });
    return { exchange, id: event.args.poolId, token0, token1 };
  };
  const pools = await Promise.all([
    readIdentity(evidence.buy),
    readIdentity(evidence.sell),
  ]);
  const tokens = await Promise.all([
    importAsset(client, pools[0].token0, blockNumber),
    importAsset(client, pools[0].token1, blockNumber),
  ]);
  return { result: resultFromEvidence(receipt, evidence, pools), tokens };
}
