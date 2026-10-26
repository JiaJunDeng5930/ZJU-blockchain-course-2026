import {
  ContractFactory,
  JsonRpcProvider,
  getAddress,
  parseEther,
  type TransactionResponse,
  type TransactionReceipt,
} from "ethers";
import {
  MiniDEX__factory,
  TestToken__factory,
  WrappedEther__factory,
  AtomicArbitrage__factory,
} from "../../../contracts/types/ethers-contracts/factories";
import { depositAmounts, minimumReceived, sameAddress } from "./amounts";
import type {
  ArbitrageResult,
  ChainSnapshot,
  Deployment,
  Opportunity,
  Pool,
  Token,
} from "./types";
import type { WalletSession } from "../wallet/session";

export type SendTransaction = (
  label: string,
  submit: () => Promise<TransactionResponse>,
) => Promise<TransactionReceipt>;
export class ExchangeClient {
  readonly rpc: JsonRpcProvider;
  readonly key: string;
  constructor(readonly deployment: Deployment) {
    this.rpc = new JsonRpcProvider(deployment.rpcUrl, undefined, {
      cacheTimeout: -1,
    });
    this.rpc.pollingInterval = 250;
    this.key = `${deployment.chainId}:${deployment.exchanges.map((e) => e.address).join(":")}`;
  }
  async verifyDeployment() {
    if (
      Number((await this.rpc.getNetwork()).chainId) !== this.deployment.chainId
    )
      throw new Error(
        "RPC chain differs from the deployment file. Redeploy on the intended network.",
      );
    const codes = await Promise.all(
      this.deployment.exchanges.map((e) => this.rpc.getCode(e.address)),
    );
    if (codes.some((code) => code === "0x"))
      throw new Error(
        "Deployed exchanges are missing from the chain. Run npm run deploy after restarting the node.",
      );
  }
  async localAccounts(): Promise<string[]> {
    return this.rpc.send("eth_accounts", []);
  }
  private dex(address: string) {
    return MiniDEX__factory.connect(address, this.rpc);
  }
  token(address: string) {
    return TestToken__factory.connect(address, this.rpc);
  }
  async pools(blockTag: number): Promise<Pool[]> {
    return (
      await Promise.all(
        this.deployment.exchanges.map(async (exchange) => {
          const contract = this.dex(exchange.address);
          const count = Number(await contract.poolCount({ blockTag }));
          return Promise.all(
            Array.from({ length: count }, async (_, index) => {
              const id = BigInt(index + 1);
              const p = await contract.pools(id, { blockTag });
              return {
                exchange,
                id,
                token0: p.token0,
                token1: p.token1,
                reserve0: p.reserve0,
                reserve1: p.reserve1,
                totalShares: p.totalShares,
                createdAt: p.createdAt,
              };
            }),
          );
        }),
      )
    ).flat();
  }
  async snapshot(
    address: string | undefined,
    tokens: Token[],
  ): Promise<ChainSnapshot> {
    const block = await this.rpc.getBlockNumber();
    const [pools, positions, balances, ether] = await Promise.all([
      this.pools(block),
      Promise.all(
        this.deployment.exchanges.map(async (exchange) => {
          const c = this.dex(exchange.address);
          const transfers = await c.queryFilter(c.filters.Transfer(), 0, block);
          // ERC721 is not enumerable here; replay transfers at the same block as the reserve snapshot.
          const owners = new Map<bigint, string>();
          for (const log of transfers) {
            if (
              sameAddress(
                log.args.to,
                "0x0000000000000000000000000000000000000000",
              )
            )
              owners.delete(log.args.tokenId);
            else owners.set(log.args.tokenId, log.args.to);
          }
          return Promise.all(
            [...owners].map(async ([id, owner]) => {
              const p = await c.positions(id, { blockTag: block });
              return {
                exchange,
                id,
                owner,
                poolId: p.poolId,
                shares: p.shares,
                amount0: p.amount0,
                amount1: p.amount1,
                createdAt: p.createdAt,
              };
            }),
          );
        }),
      ),
      address
        ? Promise.all(
            tokens.map(
              async (token) =>
                [
                  token.address,
                  await this.token(token.address).balanceOf(address, {
                    blockTag: block,
                  }),
                ] as const,
            ),
          )
        : Promise.resolve([]),
      address ? this.rpc.getBalance(address, block) : Promise.resolve(0n),
    ]);
    return {
      block,
      pools,
      positions: positions.flat(),
      balances: Object.fromEntries(balances),
      ether,
    };
  }
  quote(pool: Pool, tokenIn: string, amountIn: bigint) {
    return this.dex(pool.exchange.address).quote(pool.id, tokenIn, amountIn);
  }
  async deadline() {
    const block = await this.rpc.getBlock("latest");
    if (!block) throw new Error("The local chain has no latest block.");
    return block.timestamp + 1200;
  }
  async importToken(address: string): Promise<Token> {
    const contract = this.token(getAddress(address));
    const [name, symbol, decimals] = await Promise.all([
      contract.name(),
      contract.symbol(),
      contract.decimals(),
    ]);
    if (decimals !== 18n)
      throw new Error(
        "The interface supports standard ERC20 tokens with 18 decimals.",
      );
    return {
      address: await contract.getAddress(),
      name,
      symbol,
      kind: "external",
    };
  }
  async metadata(positionId: bigint, exchange: string): Promise<unknown> {
    const uri = await this.dex(exchange).tokenURI(positionId);
    return JSON.parse(atob(uri.split(",")[1]));
  }
  async opportunities(
    pool: Pool,
    allPools: Pool[],
    tokenIn: string,
  ): Promise<Opportunity[]> {
    const quotedAtBlock = await this.rpc.getBlockNumber();
    const others = allPools.filter(
      (other) =>
        !sameAddress(other.exchange.address, pool.exchange.address) &&
        sameAddress(other.token0, pool.token0) &&
        sameAddress(other.token1, pool.token1) &&
        other.reserve0 > 0n &&
        other.reserve1 > 0n,
    );
    const tokenOut = sameAddress(tokenIn, pool.token0)
      ? pool.token1
      : pool.token0;
    const routes = others.flatMap(
      (other) =>
        [
          [pool, other],
          [other, pool],
        ] as const,
    );
    const results = await Promise.all(
      routes.flatMap(([buy, sell]) =>
        [1, 5, 10, 25, 50, 100, 200, 500].map(
          async (size): Promise<Opportunity> => {
            const amountIn = parseEther(String(size));
            const bridge = await this.quote(buy, tokenIn, amountIn);
            const amountOut = await this.quote(sell, tokenOut, bridge);
            return {
              buy,
              sell,
              tokenIn,
              amountIn,
              amountOut,
              profit: amountOut - amountIn,
              quotedAtBlock,
            };
          },
        ),
      ),
    );
    return results
      .filter((route) => route.profit > 0n)
      .sort((a, b) => (a.profit > b.profit ? -1 : a.profit < b.profit ? 1 : 0));
  }
  writer(session: WalletSession, send: SendTransaction) {
    return new ExchangeWriter(this, session, send);
  }
}

class ExchangeWriter {
  constructor(
    private client: ExchangeClient,
    private session: WalletSession,
    private send: SendTransaction,
  ) {}
  private dex(pool: Pool) {
    return MiniDEX__factory.connect(pool.exchange.address, this.session.signer);
  }
  private async approve(token: string, spender: string, amount: bigint) {
    const c = TestToken__factory.connect(token, this.session.signer);
    if ((await c.allowance(this.session.address, spender)) < amount)
      await this.send("Approve ERC20", () => c.approve(spender, amount));
  }
  async faucet(token: Token) {
    await this.send(`Claim ${token.symbol}`, () =>
      TestToken__factory.connect(token.address, this.session.signer).faucet(),
    );
  }
  async claimEther() {
    if (this.client.deployment.chainId !== 31337)
      throw new Error("The ETH faucet requires the local teaching chain.");
    const [funder] = await this.client.localAccounts();
    const signer = await this.client.rpc.getSigner(funder);
    await this.send("Claim local ETH", () =>
      signer.sendTransaction({
        to: this.session.address,
        value: parseEther("10"),
      }),
    );
  }
  async swap(
    pool: Pool,
    tokenIn: string,
    amount: bigint,
    quote: bigint,
    slippage: bigint,
  ) {
    await this.approve(tokenIn, pool.exchange.address, amount);
    const deadline = await this.client.deadline();
    await this.send("Swap tokens", () =>
      this.dex(pool).swap(
        pool.id,
        tokenIn,
        amount,
        minimumReceived(quote, slippage),
        this.session.address,
        deadline,
      ),
    );
  }
  async addLiquidity(
    pool: Pool,
    amount0: bigint,
    amount1: bigint,
    slippage: bigint,
  ) {
    const [used0, used1] = depositAmounts(pool, amount0, amount1);
    await this.approve(pool.token0, pool.exchange.address, amount0);
    await this.approve(pool.token1, pool.exchange.address, amount1);
    const deadline = await this.client.deadline();
    await this.send("Add liquidity", () =>
      this.dex(pool).addLiquidity(
        pool.id,
        amount0,
        amount1,
        minimumReceived(used0, slippage),
        minimumReceived(used1, slippage),
        deadline,
      ),
    );
  }
  async removeLiquidity(
    pool: Pool,
    id: bigint,
    amounts: readonly [bigint, bigint],
    slippage: bigint,
  ) {
    const deadline = await this.client.deadline();
    await this.send("Redeem position", () =>
      this.dex(pool).removeLiquidity(
        id,
        minimumReceived(amounts[0], slippage),
        minimumReceived(amounts[1], slippage),
        deadline,
      ),
    );
  }
  async createPool(exchange: string, token0: string, token1: string) {
    await this.send("Create pool", () =>
      MiniDEX__factory.connect(exchange, this.session.signer).createPool(
        token0,
        token1,
      ),
    );
  }
  async createToken(name: string, symbol: string): Promise<Token> {
    const factory = new ContractFactory(
      TestToken__factory.abi,
      this.client.deployment.bytecodes.TestToken,
    );
    const request = await factory.getDeployTransaction(name, symbol);
    const receipt = await this.send("Deploy ERC20", () =>
      this.session.signer.sendTransaction(request),
    );
    return { address: receipt.contractAddress!, name, symbol, kind: "faucet" };
  }

  async wrap(amount: bigint, withdraw: boolean) {
    const wrapped = this.client.deployment.tokens.find(
      (token) => token.kind === "wrapped",
    );
    if (!wrapped)
      throw new Error("This deployment has no wrapped ETH contract.");
    const c = WrappedEther__factory.connect(
      wrapped.address,
      this.session.signer,
    );
    await this.send(withdraw ? "Unwrap WETH" : "Wrap ETH", () =>
      withdraw ? c.withdraw(amount) : c.deposit({ value: amount }),
    );
  }
  async arbitrage(
    route: Opportunity,
    minProfit: bigint,
  ): Promise<ArbitrageResult> {
    await this.approve(
      route.tokenIn,
      this.client.deployment.arbitrage,
      route.amountIn,
    );
    const before = await this.client.pools(
      await this.client.rpc.getBlockNumber(),
    );
    const deadline = await this.client.deadline();
    const c = AtomicArbitrage__factory.connect(
      this.client.deployment.arbitrage,
      this.session.signer,
    );
    const receipt = await this.send("Atomic arbitrage", () =>
      c.execute(
        route.buy.exchange.address,
        route.buy.id,
        route.sell.exchange.address,
        route.sell.id,
        route.tokenIn,
        route.amountIn,
        minProfit,
        deadline,
      ),
    );
    const event = receipt.logs
      .filter((log) =>
        sameAddress(log.address, this.client.deployment.arbitrage),
      )
      .map((log) => c.interface.parseLog(log))
      .find((log) => log?.name === "ArbitrageExecuted");
    if (!event)
      throw new Error("The confirmed arbitrage receipt has no result event.");
    const profit: bigint = event.args.profit;
    return { tokenIn: route.tokenIn, profit, receipt, before };
  }
}
export type Writer = ReturnType<ExchangeClient["writer"]>;
