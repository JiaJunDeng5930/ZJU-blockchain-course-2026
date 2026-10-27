import "../generated/dex_logic.js";
import type { JournalView, WalletKernel } from "../wallet/kernel";

export type ActivityQuery = {
  account: "all" | "current";
  status: "all" | "pending" | "confirmed" | "failed" | "unknown";
  page: string;
  observedAccount: string | null;
};
export type ActivityEvent =
  | { kind: "account"; value: ActivityQuery["account"] }
  | { kind: "status"; value: ActivityQuery["status"] }
  | { kind: "previous" | "next" | "reset" };
export type ActivityPage = {
  query: ActivityQuery;
  entries: JournalView[];
  total: string;
  filteredTotal: string;
  page: string;
  pages: string;
  canPrevious: boolean;
  canNext: boolean;
  canCurrentAccount: boolean;
  emptyMessage: string;
};
export type ActivityContext = { kernel: WalletKernel };

/** Defaults are supplied by the same extracted model as every transition. */
export const initialActivityQuery = (): ActivityQuery =>
  JSON.parse(globalThis.DEXWallet.initialActivityQuery());
export function activityView(
  context: ActivityContext,
  query: ActivityQuery | null = null,
): ActivityPage {
  return JSON.parse(context.kernel.projectActivity(JSON.stringify({ query, event: null })));
}
export function activityStep(
  context: ActivityContext,
  query: ActivityQuery,
  event: ActivityEvent,
): ActivityPage {
  return JSON.parse(context.kernel.projectActivity(JSON.stringify({ query, event })));
}
