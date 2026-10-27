import "../generated/dex_logic.js";
import { getAddress, type Address } from "viem";

export type WalletSource = "local" | "injected";
export type WalletIdentity = {
  source: WalletSource;
  address: string;
  chain: string;
  epoch: string;
};
export type WalletView = {
  source: WalletSource;
  epoch: string;
  expectedChain: string;
} & (
  | { kind: "connecting" }
  | { kind: "ready"; identity: WalletIdentity }
  | { kind: "unavailable"; reason: string; message: string }
);
export type JournalView = {
  id: string;
  instance: string;
  label: string;
  account: string;
  beneficiary: string;
  authority: "wallet" | "dev-faucet";
  epoch: string;
} & (
  | { state: "awaiting-wallet" }
  | { state: "submitted"; hash: string; message: string | null }
  | { state: "confirmed"; hash: string; block: string; gas: string }
  | { state: "submission-unknown"; message: string }
  | {
      state: "failed";
      message: string;
      hash?: string;
      block?: string;
      gas?: string;
    }
);
export type ActivityView =
  | { kind: "idle" }
  | {
      kind:
        | "preparing"
        | "awaiting-wallet"
        | "requesting-faucet"
        | "submitted"
        | "completed";
      label: string;
    }
  | { kind: "confirmed"; label: string; block: string }
  | {
      kind: "receipt-unavailable" | "interrupted";
      label: string;
      message: string;
    };
export type HistoryView = {
  kind: "loading" | "ready" | "saving" | "memory";
  error: string | null;
  canRefresh: boolean;
  canRetryLoad: boolean;
  canRetrySave: boolean;
};
export type KernelView = {
  wallet: WalletView;
  history: HistoryView;
  journal: JournalView[];
  pending: boolean;
  error: string | null;
  activity: ActivityView;
};
export type WalletEffect =
  | {
      kind: "observe";
      request: string;
      source: WalletSource;
      requestAccess: boolean;
    }
  | { kind: "switch-network" | "add-network"; request: string }
  | {
      kind: "persist";
      preference: { source: WalletSource; address: string | null };
    }
  | { kind: "load-history" }
  | { kind: "save-history"; key: string; archive: string }
  | {
      kind: "observe-receipt";
      instance: string;
      transaction: string;
      hash: string;
    };
export type Decision<T> =
  { kind: "accepted"; value: T } | { kind: "denied"; message: string };
export type KernelReply<T = unknown> = {
  view: KernelView;
  effects: WalletEffect[];
  result: Decision<T> | null;
};
export type FundingPlan =
  | { kind: "wallet-required" | "loading" | "ready" }
  | { kind: "need-funding"; native: boolean; tokens: string[] };
export type KernelEvent =
  | { kind: "select-local"; address: string }
  | { kind: "connect-browser" | "invalidate" | "disconnect" | "switch-network" }
  | { kind: "provider-changed" | "provider-disconnected"; source: WalletSource }
  | { kind: "observed"; request: string; accounts: string[]; chain: string }
  | {
      kind: "observation-failed";
      request: string;
      reason: "missing-provider" | "disconnected" | "request-failed";
      message?: string;
    }
  | {
      kind: "switched" | "added";
      request: string;
      success: boolean;
      code: string | null;
      message: string;
    }
  | { kind: "begin-operation"; identity: WalletIdentity | null; label: string }
  | {
      kind: "request-write";
      operation: string;
      label: string;
      authority: { kind: "dev-faucet"; sender: string } | null;
    }
  | {
      kind: "authorize";
      operation: string;
      transaction: string;
      accounts: string[];
      chain: string;
    }
  | { kind: "broadcast"; transaction: string; hash: string }
  | {
      kind: "preflight-failed" | "receipt-unavailable";
      transaction: string;
      message: string;
    }
  | {
      kind: "signature-failed";
      transaction: string;
      code: string | null;
      message: string;
    }
  | {
      kind: "receipt";
      transaction: string;
      hash: string;
      sender: string;
      status: "success" | "reverted";
      block: string;
      gasUsed: string;
      gasPrice: string;
    }
  | { kind: "finish-operation"; operation: string; error: string | null }
  | {
      kind: "history-loaded";
      key: string;
      snapshots: { owner: string; archive: string }[];
    }
  | { kind: "history-load-failed"; key: string; message: string }
  | { kind: "history-saved" }
  | { kind: "history-save-failed"; message: string }
  | { kind: "history-preference-warning"; message: string }
  | { kind: "history-retry-save" | "history-retry-load" | "history-refresh" }
  | {
      kind: "history-receipt";
      instance: string;
      transaction: string;
      hash: string;
      sender: string;
      status: "success" | "reverted";
      block: string;
      gasUsed: string;
      gasPrice: string;
    }
  | {
      kind: "history-observation-failed";
      instance: string;
      transaction: string;
      message: string;
    };
export type RawAllowances = {
  view(): string; command(event:string):string; writePlan(input:string):string; simulation(accepted:boolean):string;
};
type RawKernel = {
  view(): string;
  start(): string;
  dispatch(event: string): string;
  retainsSnapshot(identity: string): boolean;
  fundingPlan(observation: string): string;
  historyKey(genesis: string, deployment: string, endpoint: string): string;
  activity(input: string): string;
  allowances(configuration:string): RawAllowances;
};
declare global {
  var DEXWallet: {
    create(configuration: string): RawKernel;
    initialActivityQuery(): string;
    planNativeFunding(input: string): string;
  };
}

/** The extracted closure owns state; this class only transports JSON and subscriptions. */
export class WalletKernel {
  private raw: RawKernel;
  private view: KernelView;
  private listeners = new Set<() => void>();
  constructor(configuration: {
    chain: string;
    source: string | null;
    address: string | null;
    instance?: string | null;
  }) {
    this.raw = globalThis.DEXWallet.create(JSON.stringify(configuration));
    this.view = JSON.parse(this.raw.view());
  }
  createAllowances(configuration:{tokens:string[];spenders:string[]}): RawAllowances {
    return this.raw.allowances(JSON.stringify(configuration));
  }
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish<T>(encoded: string): KernelReply<T> {
    const reply: KernelReply<T> = JSON.parse(encoded);
    this.view = reply.view;
    for (const listener of this.listeners) listener();
    return reply;
  }
  start() {
    return this.publish(this.raw.start());
  }
  dispatch<T = unknown>(event: KernelEvent) {
    return this.publish<T>(this.raw.dispatch(JSON.stringify(event)));
  }
  /** Read-only projection: no dispatch, subscriptions or external effects. */
  projectActivity(input: string): string {
    return this.raw.activity(input);
  }
  historyKey(genesis: string, deployment: string, endpoint: string) {
    return this.raw.historyKey(genesis, deployment, endpoint);
  }
  retainsSnapshot(identity: WalletIdentity | null) {
    return this.raw.retainsSnapshot(JSON.stringify(identity));
  }
  fundingPlan(observation: object | null): FundingPlan {
    return JSON.parse(this.raw.fundingPlan(JSON.stringify(observation)));
  }
}
export function accepted<T>(reply: KernelReply<T>): T {
  const decision = reply.result as Decision<T>;
  if (decision.kind === "denied") throw new Error(decision.message);
  return decision.value;
}
export function renderActivity(activity: ActivityView, chain: number): string {
  switch (activity.kind) {
    case "idle":
      return `Connected to chain ${chain}`;
    case "preparing":
      return activity.label;
    case "awaiting-wallet":
      return `${activity.label}: confirm in wallet`;
    case "requesting-faucet":
      return `${activity.label}: requesting development faucet`;
    case "submitted":
      return `${activity.label}: waiting for block confirmation`;
    case "confirmed":
      return `${activity.label} confirmed in block ${activity.block}`;
    case "completed":
      return `${activity.label} completed`;
    case "receipt-unavailable":
      return `${activity.label}: confirmation unavailable — ${activity.message}`;
    case "interrupted":
      return `Operation stopped: ${activity.message}`;
  }
}

export function planNativeFunding(
  chainId: string,
  beneficiary: string,
  nodeAccounts: string[],
): { sender: Address; amountWei: bigint } {
  const decision: Decision<{ sender: string; amountWei: string }> = JSON.parse(
    globalThis.DEXWallet.planNativeFunding(
      JSON.stringify({
        chain: chainId,
        beneficiary: getAddress(beneficiary),
        accounts: nodeAccounts.map((account) => getAddress(account)),
      }),
    ),
  );
  if (decision.kind === "denied") throw new Error(decision.message);
  return {
    sender: getAddress(decision.value.sender),
    amountWei: BigInt(decision.value.amountWei),
  };
}
