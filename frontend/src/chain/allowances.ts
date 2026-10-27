import { getAddress } from "viem";
import { testTokenAbi } from "../generated/abis";
import { sessionIdentity, type WalletController } from "../wallet/session";
import type { RawAllowances, WalletIdentity } from "../wallet/kernel";
import type { ExchangeClient, SendTransaction } from "./client";
import type { Token } from "./types";

export type AllowanceRow = {
  token: string; spender: string; allowance: string | null;
  error: string | null; unlimited: boolean; canRevoke: boolean;
};
export type RevokePlan = {
  identity: WalletIdentity; owner: string; token: string; spender: string; allowance: string; unlimited: boolean;
};
export type AllowancesView = {
  phase: "idle" | "loading" | "ready" | "error" | "disconnected";
  owner: string | null; block: string | null; rows: AllowanceRow[];
  canRefresh: boolean; canConfirm: boolean;
  review: RevokePlan | null;
  action: { kind: "idle" | "verifying" | "verified" | "unverified" | "error"; message: string; hash?: string };
};
type ReadRequest = { request: string; identity: WalletIdentity; owner: string; pairs: {token:string;spender:string}[] };
type PreparedWrite = {kind:"prepared";token:string;spender:string;amount:string}|{kind:"rejected";message:string};

/** Interprets the extracted model's RPC and wallet effects. */
export class AllowanceController {
  private raw: RawAllowances;
  private view: AllowancesView;
  private listeners = new Set<() => void>();
  private unsubscribe: () => void;
  constructor(private client: ExchangeClient, private wallet: WalletController, tokens: readonly Token[]) {
    this.raw = wallet.kernel.createAllowances({
      tokens: tokens.map(token => getAddress(token.address)),
      spenders: [...client.deployment.exchanges.map(exchange => getAddress(exchange.address)), getAddress(client.deployment.arbitrage)],
    });
    this.view = JSON.parse(this.raw.view());
    this.unsubscribe = wallet.kernel.subscribe(() => this.publish());
  }
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  dispose = () => { this.unsubscribe(); this.listeners.clear(); };
  private publish() { this.view = JSON.parse(this.raw.view()); for (const listener of this.listeners) listener(); }
  private command<T = unknown>(event: object): T {
    const reply = JSON.parse(this.raw.command(JSON.stringify(event))) as {view:AllowancesView;result:T};
    this.view = reply.view;
    for (const listener of this.listeners) listener();
    return reply.result;
  }
  async refresh(blockNumber?: bigint): Promise<void> {
    const request = this.command<ReadRequest | null>({kind:"refresh"});
    if (!request) return;
    try {
      const block = blockNumber ?? await this.client.rpc.getBlockNumber({cacheTime:0});
      const rows = await Promise.all(request.pairs.map(async pair => {
        try {
          const amount = await this.client.rpc.readContract({address:getAddress(pair.token),abi:testTokenAbi,
            functionName:"allowance",args:[getAddress(request.owner),getAddress(pair.spender)],blockNumber:block});
          return {...pair,allowance:amount.toString(),error:null};
        } catch (error) {
          // DEFENSE: an imported token or RPC may reject this exact allowance read.
          return {...pair,allowance:null,error:error instanceof Error ? error.message : String(error)};
        }
      }));
      this.command({kind:"loaded",request:request.request,block:block.toString(),rows});
    } catch (error) {
      // DEFENSE: the endpoint may fail before a fixed block for this read is known.
      this.command({kind:"failed",request:request.request,message:error instanceof Error ? error.message : String(error)});
    }
  }
  review(token: string, spender: string): void { this.command({kind:"review",token:getAddress(token),spender:getAddress(spender)}); }
  cancel(): void { this.command({kind:"cancel"}); }
  async confirm(): Promise<void> {
    const plan = this.command<RevokePlan | null>({kind:"take"});
    if (!plan) return;
    const session = this.wallet.session();
    try {
      await this.wallet.perform({label:"Revoke token authorization",session,perform:async writer => {
        const receipt = await writer.revokeAllowance(plan, this.raw);
        this.command({kind:"submitted",plan,hash:receipt.transactionHash,block:receipt.blockNumber.toString()});
        await this.refresh(receipt.blockNumber);
      }});
    } catch (error) {
      // DEFENSE: a wallet refusal, account change, simulation rejection or reverted receipt interrupts this explicit revoke.
      this.command({kind:"rejected",identity:plan.identity,message:error instanceof Error ? error.message : String(error)});
    }
  }
}

export async function revokeAllowance(context: {
  client: ExchangeClient; session: import("../wallet/session").WalletSession; send: SendTransaction;
}, plan: RevokePlan, runtime: RawAllowances) {
  const prepared: PreparedWrite = JSON.parse(runtime.writePlan(JSON.stringify({plan,identity:sessionIdentity(context.session)})));
  if (prepared.kind === "rejected") throw new Error(prepared.message);
  const request = {address:getAddress(prepared.token),abi:testTokenAbi,functionName:"approve" as const,
    args:[getAddress(prepared.spender),BigInt(prepared.amount)] as const,account:context.session.address,chain:context.client.chain};
  const simulation = await context.client.rpc.simulateContract(request);
  const refusal: string | null = JSON.parse(runtime.simulation(simulation.result));
  if (refusal !== null) throw new Error(refusal);
  return context.send("Revoke ERC20 authorization", () => context.session.walletClient.writeContract(request));
}
