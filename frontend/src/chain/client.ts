import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  getContract,
  parseEventLogs,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import {
  miniDexAbi,
  testTokenAbi,
  miniDexRuntimeBytecode,
  testTokenRuntimeBytecode,
  wrappedEtherRuntimeBytecode,
  arbitrageRuntimeBytecode,
} from "../generated/abis";
import { activeOwners } from "../logic/ledger";
import { aggregateActivity } from "../logic/liquidity";
import { executionFeeWei } from "../logic/receipts";
import { approvalNeeded } from "../logic/units";
import { makeSwapParameters } from "../logic/trade";
import type { RoutedSwapPlan } from "../logic/routing";
import { runtimeCodeMatches } from "../logic/assets";
import {
  importAsset,
  createAsset,
  createAssetPool,
  claimAsset,
} from "./assets";
import { addLiquidity, removeLiquidity, transferPosition } from "./liquidity";
import { revokeAllowance, type RevokePlan } from "./allowances";
import type { RawAllowances } from "../wallet/kernel";
import { executeWrap } from "./wrapping";
import { opportunities, quoteArbitrage, executeArbitrage } from "./arbitrage";
import type {
  ArbitrageResult,
  SwapResult,
  LiquidityActivity,
  ChainSnapshot,
  Deployment,
  Opportunity,
  Pool,
  Token,
} from "./types";
import type { WalletSession } from "../wallet/session";
import { planNativeFunding } from "../wallet/kernel";

export type SendTransaction = (
  label: string,
  submit: () => Promise<Hex>,
  authority?: { kind: "dev-faucet"; sender: Address }
) => Promise<TransactionReceipt>;

export class ExchangeClient {
  readonly rpc: PublicClient;
  readonly key: string;
  readonly chain;
  constructor(readonly deployment: Deployment) {
    this.chain = defineChain({
      id: deployment.chainId,
      name: "DEX teaching chain",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [deployment.rpcUrl] } },
    });
    this.rpc = createPublicClient({
      chain: this.chain,
      transport: http(deployment.rpcUrl),
      pollingInterval: 250,
      cacheTime: 0,
    });
    this.key = `${deployment.chainId}:${deployment.exchanges
      .map((e) => e.address)
      .join(":")}`;
  }
  async verifyDeployment() {
    if ((await this.rpc.getChainId()) !== this.deployment.chainId)
      throw new Error(
        "RPC chain differs from the deployment file. Redeploy on the intended network."
      );
    const expected = [
      ...this.deployment.exchanges.map((exchange) => ({
        address: exchange.address,
        code: miniDexRuntimeBytecode,
      })),
      ...this.deployment.tokens.map((token) => ({
        address: token.address,
        code:
          token.kind === "wrapped"
            ? wrappedEtherRuntimeBytecode
            : testTokenRuntimeBytecode,
      })),
      { address: this.deployment.arbitrage, code: arbitrageRuntimeBytecode },
    ];
    const blockNumber = await this.rpc.getBlockNumber();
    const matches = await Promise.all(
      expected.map(async ({ address, code }) =>
        runtimeCodeMatches(
          await this.rpc.getCode({ address: getAddress(address), blockNumber }),
          code
        )
      )
    );
    if (matches.includes(false))
      throw new Error(
        "Deployed contracts differ from this verified build. Run npm run deploy against this chain."
      );
    // Deployment metadata is observed after verifying this build's deployed runtime.
    this.deployment.tokens = await Promise.all(
      this.deployment.tokens.map(async (token) => ({
        ...token,
        decimals: await this.token(token.address).read.decimals({
          blockNumber,
        }),
      }))
    );
  }
  async transactionTimestamp(): Promise<bigint> {
    // The latest mined block can be old on an idle chain; estimation uses the pending block.
    return (await this.rpc.getBlock({ blockTag: "pending" })).timestamp;
  }
  async localAccounts(): Promise<Address[]> {
    return createWalletClient({
      transport: http(this.deployment.rpcUrl),
    }).getAddresses();
  }
  private dex(address: string) {
    return getContract({
      address: getAddress(address),
      abi: miniDexAbi,
      client: this.rpc,
    });
  }
  token(address: string) {
    return getContract({
      address: getAddress(address),
      abi: testTokenAbi,
      client: this.rpc,
    });
  }
  async pools(blockTag: number): Promise<Pool[]> {
    const blockNumber = BigInt(blockTag);
    return (
      await Promise.all(
        this.deployment.exchanges.map(async (exchange) => {
          const contract = this.dex(exchange.address);
          const count = Number(await contract.read.poolCount({ blockNumber }));
          return Promise.all(
            Array.from({ length: count }, async (_, index) => {
              const id = BigInt(index + 1);
              const [
                token0,
                token1,
                reserve0,
                reserve1,
                totalShares,
                createdAt,
              ] = await contract.read.pools([id], { blockNumber });
              return {
                exchange,
                id,
                token0,
                token1,
                reserve0,
                reserve1,
                totalShares,
                createdAt,
              };
            })
          );
        })
      )
    ).flat();
  }
  async snapshot(
    address: string | undefined,
    tokens: Token[]
  ): Promise<ChainSnapshot> {
    const block = Number(await this.rpc.getBlockNumber());
    const blockNumber = BigInt(block);
    const [pools, positions, balances, ether] = await Promise.all([
      this.pools(block),
      Promise.all(
        this.deployment.exchanges.map(async (exchange) => {
          const c = this.dex(exchange.address);
          const transfers = await this.rpc.getContractEvents({
            address: getAddress(exchange.address),
            abi: miniDexAbi,
            eventName: "Transfer",
            fromBlock: 0n,
            toBlock: blockNumber,
            strict: true,
          });
          const owners = activeOwners(
            transfers.map((log) => ({
              tokenId: log.args.tokenId,
              to: log.args.to,
            }))
          );
          return Promise.all(
            owners.map(async ({ id, owner }) => {
              const [poolId, shares, amount0, amount1, createdAt] =
                await c.read.positions([id], { blockNumber });
              return {
                exchange,
                id,
                owner,
                poolId,
                shares,
                amount0,
                amount1,
                createdAt,
              };
            })
          );
        })
      ),
      address
        ? Promise.all(
            tokens.map(
              async (token) =>
                [
                  token.address,
                  await this.token(token.address).read.balanceOf(
                    [getAddress(address)],
                    { blockNumber }
                  ),
                ] as const
            )
          )
        : Promise.resolve([]),
      address
        ? this.rpc.getBalance({ address: getAddress(address), blockNumber })
        : Promise.resolve(0n),
    ]);
    return {
      block,
      pools,
      positions: positions.flat(),
      balances: Object.fromEntries(balances),
      ether,
    };
  }
  quote(pool: Pool, tokenIn: string, amountIn: bigint, block?: number) {
    return this.dex(pool.exchange.address).read.quote(
      [pool.id, getAddress(tokenIn), amountIn],
      block === undefined ? undefined : { blockNumber: BigInt(block) }
    );
  }
  importToken(address: string): Promise<Token> {
    return importAsset(this, address);
  }
  async liquidityActivity(
    pool: Pool,
    block: number
  ): Promise<LiquidityActivity> {
    const address = getAddress(pool.exchange.address),
      toBlock = BigInt(block);
    const [added, removed, swaps, feeBps] = await Promise.all([
      this.rpc.getContractEvents({
        address,
        abi: miniDexAbi,
        eventName: "LiquidityAdded",
        args: { poolId: pool.id },
        fromBlock: 0n,
        toBlock,
        strict: true,
      }),
      this.rpc.getContractEvents({
        address,
        abi: miniDexAbi,
        eventName: "LiquidityRemoved",
        args: { poolId: pool.id },
        fromBlock: 0n,
        toBlock,
        strict: true,
      }),
      this.rpc.getContractEvents({
        address,
        abi: miniDexAbi,
        eventName: "Swap",
        args: { poolId: pool.id },
        fromBlock: 0n,
        toBlock,
        strict: true,
      }),
      this.dex(address).read.FEE_BPS({ blockNumber: toBlock }),
    ]);
    const { volume0, volume1, fees0, fees1 } = aggregateActivity(
      pool.token0,
      feeBps,
      swaps.map((log) => ({
        tokenIn: log.args.tokenIn,
        amountIn: log.args.amountIn,
      }))
    );
    const events = [
      ...added.map((log) => ({
        kind: "added" as const,
        positionId: log.args.positionId,
        actor: log.args.provider,
        amount0: log.args.amount0,
        amount1: log.args.amount1,
        block: Number(log.blockNumber),
        index: log.logIndex,
        hash: log.transactionHash,
      })),
      ...removed.map((log) => ({
        kind: "removed" as const,
        positionId: log.args.positionId,
        actor: log.args.owner,
        amount0: log.args.amount0,
        amount1: log.args.amount1,
        block: Number(log.blockNumber),
        index: log.logIndex,
        hash: log.transactionHash,
      })),
    ].sort((a, b) => b.block - a.block || b.index - a.index);
    return {
      block,
      volume0,
      volume1,
      fees0,
      fees1,
      swaps: swaps.length,
      events,
    };
  }
  async metadata(positionId: bigint, exchange: string): Promise<unknown> {
    const uri = await this.dex(exchange).read.tokenURI([positionId]);
    return JSON.parse(atob(uri.split(",")[1]));
  }
  opportunities(
    pool: Pool,
    allPools: Pool[],
    tokenIn: string,
    supportedTokens: readonly Token[]
  ): Promise<Opportunity[]> {
    return opportunities(this, pool, allPools, tokenIn, supportedTokens);
  }
  quoteArbitrage(
    pool: Pool,
    tokenIn: string,
    amount: string,
    supportedTokens: readonly Token[],
  ): Promise<Opportunity[]> {
    return quoteArbitrage(this, pool, tokenIn, amount, supportedTokens);
  }
  writer(session: WalletSession, send: SendTransaction) {
    return new ExchangeWriter(this, session, send);
  }
}

class ExchangeWriter {
  constructor(
    private client: ExchangeClient,
    private session: WalletSession,
    private send: SendTransaction
  ) {}
  private async approve(token: string, spender: string, amount: bigint) {
    const allowance = await this.client
      .token(token)
      .read.allowance([this.session.address, getAddress(spender)]);
    if (approvalNeeded(allowance, amount))
      await this.send("Approve ERC20", () =>
        this.session.walletClient.writeContract({
          account: this.session.address,
          chain: this.client.chain,
          address: getAddress(token),
          abi: testTokenAbi,
          functionName: "approve",
          args: [getAddress(spender), amount],
        })
      );
  }
  revokeAllowance(plan: RevokePlan, runtime: RawAllowances) {
    return revokeAllowance(this.context(), plan, runtime);
  }
  faucet(token: Token) {
    return claimAsset(this.context(), token);
  }
  private context() {
    return { client: this.client, session: this.session, send: this.send };
  }
  async claimEther() {
    const funding = planNativeFunding(
      String(this.client.deployment.chainId),
      this.session.address,
      await this.client.localAccounts()
    );
    const funder = funding.sender;
    const fundingWallet = createWalletClient({
      chain: this.client.chain,
      account: funder,
      transport: http(this.client.deployment.rpcUrl),
    });
    const receipt = await this.send(
      "Claim local ETH",
      () =>
        fundingWallet.sendTransaction({
          to: this.session.address,
          value: funding.amountWei,
        }),
      { kind: "dev-faucet", sender: funder }
    );
    return { kind: "native" as const, recipient: this.session.address,
      amount: funding.amountWei, gasCostWei: executionFeeWei(receipt), receipt };
  }
  async routedSwap(plan: RoutedSwapPlan): Promise<SwapResult> {
    const receipt = await this.executeSwap(
      plan.pool,
      plan.inputToken,
      plan.input,
      plan.quoted,
      plan.slippage
    );
    const event = parseEventLogs({
      abi: miniDexAbi,
      eventName: "Swap",
      logs: receipt.logs,
      strict: true
    }).find(
      (event) =>
        getAddress(event.address) === getAddress(plan.pool.exchange.address) &&
        event.args.poolId === plan.pool.id
    );
    // DEFENSE: a successful swap must provide its settlement event; incomplete RPC
    // receipt logs cannot be presented as an actual received amount.
    if (!event)
      throw new Error("Confirmed swap is missing its settlement event.");
    return {
      gasCostWei: executionFeeWei(receipt),
      pool: plan.pool,
      tokenIn: event.args.tokenIn,
      tokenOut: plan.outputToken,
      amountIn: event.args.amountIn,
      amountOut: event.args.amountOut,
      quoted: plan.quoted,
      minimum: plan.minimum,
      receipt
    };
  }
  async swap(
    pool: Pool,
    tokenIn: string,
    amount: bigint,
    quote: bigint,
    slippage: bigint
  ) {
    await this.executeSwap(pool, tokenIn, amount, quote, slippage);
  }
  private async executeSwap(
    pool: Pool,
    tokenIn: string,
    amount: bigint,
    quote: bigint,
    slippage: bigint
  ) {
    await this.approve(tokenIn, pool.exchange.address, amount);
    const plan = makeSwapParameters(
      amount,
      quote,
      slippage,
      await this.client.transactionTimestamp()
    );
    return this.send("Swap tokens", () =>
      this.session.walletClient.writeContract({
        account: this.session.address,
        chain: this.client.chain,
        address: getAddress(pool.exchange.address),
        abi: miniDexAbi,
        functionName: "swap",
        args: [
          pool.id,
          getAddress(tokenIn),
          plan.input,
          plan.minimum,
          this.session.address,
          plan.deadline
        ]
      })
    );
  }
  async addLiquidity(
    pool: Pool,
    amount0: bigint,
    amount1: bigint,
    slippage: bigint
  ) {
    return addLiquidity(this.context(), pool, amount0, amount1, slippage);
  }
  async removeLiquidity(
    pool: Pool,
    id: bigint,
    amounts: readonly [bigint, bigint],
    slippage: bigint
  ) {
    return removeLiquidity(this.context(), pool, id, amounts, slippage);
  }
  async transferPosition(pool: Pool, positionId: bigint, recipient: string) {
    return transferPosition(this.context(), pool, positionId, recipient);
  }
  createPool(exchange: string, token0: string, token1: string) {
    return createAssetPool(this.context(), exchange, token0, token1);
  }
  createToken(name: string, symbol: string) {
    return createAsset(this.context(), name, symbol);
  }
  wrap(amount: bigint, withdraw: boolean) {
    return executeWrap(this.context(), amount, withdraw);
  }
  arbitrage(
    route: Opportunity,
    minimumProfit: string
  ): Promise<ArbitrageResult> {
    return executeArbitrage(
      { client: this.client, session: this.session, send: this.send },
      route,
      minimumProfit
    );
  }
}
export type Writer = ReturnType<ExchangeClient["writer"]>;
