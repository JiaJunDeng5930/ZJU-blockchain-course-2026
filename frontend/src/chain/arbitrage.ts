import { getAddress, parseEventLogs } from "viem";
import { arbitrageAbi, testTokenAbi } from "../generated/abis";
import { prepareArbitrage, scanArbitrage } from "../logic/arbitrage";
import { importAsset } from "./assets";
import { assertSupportedPool } from "../logic/assets";
import type { WalletSession } from "../wallet/session";
import type { ExchangeClient, SendTransaction } from "./client";
import type { ArbitrageResult, Opportunity, Pool, Token } from "./types";

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
  const [verifiedTokens, executionTimestamp] = await Promise.all([
    Promise.all([
      importAsset(client, route.buy.token0),
      importAsset(client, route.buy.token1),
    ]),
    client.transactionTimestamp(),
  ]);
  assertSupportedPool(route.buy, verifiedTokens);
  assertSupportedPool(route.sell, verifiedTokens);
  const plan = prepareArbitrage({
    arbitrage,
    route,
    pools,
    supportedTokens: verifiedTokens,
    minimum,
    balance,
    allowance,
    now: executionTimestamp,
    block: Number(block.number),
  });
  if (plan.requiresApproval) {
    await send("Approve arbitrage capital", () =>
      session.walletClient.writeContract({
        account: session.address,
        chain: session.walletClient.chain,
        address: capital,
        abi: testTokenAbi,
        functionName: "approve",
        args: [arbitrage, plan.route.amountIn],
      }),
    );
  }
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
  const event = parseEventLogs({
    abi: arbitrageAbi,
    eventName: "ArbitrageExecuted",
    logs: receipt.logs,
  }).find((log) => getAddress(log.address) === arbitrage)!;
  const snapshots = parseEventLogs({
    abi: arbitrageAbi,
    eventName: "PoolReservesChanged",
    logs: receipt.logs,
  }).filter((log) => getAddress(log.address) === arbitrage);
  const evidence = [plan.route.buy, plan.route.sell].map((pool) => {
    const snapshot = snapshots.find(
      (log) =>
        getAddress(log.args.exchange) === getAddress(pool.exchange.address) &&
        log.args.poolId === pool.id,
    )!;
    return {
      before: {
        ...pool,
        reserve0: snapshot.args.reserve0Before,
        reserve1: snapshot.args.reserve1Before,
      },
      after: {
        ...pool,
        reserve0: snapshot.args.reserve0After,
        reserve1: snapshot.args.reserve1After,
      },
    };
  });
  return {
    tokenIn: route.tokenIn,
    profit: event.args.profit,
    receipt,
    before: evidence.map((snapshot) => snapshot.before),
    after: evidence.map((snapshot) => snapshot.after),
  };
}
