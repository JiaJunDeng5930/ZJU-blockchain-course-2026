import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  activityStep,
  activityView,
  type ActivityQuery,
  type ActivityEvent,
} from "../logic/activity";
import { HistoryStatus } from "../components/HistoryStatus";
import { formatEther, type Hex } from "viem";
import type { JournalView } from "../wallet/kernel";
import { shorten } from "../chain/amounts";
import { useDex } from "../chain/DexProvider";
import { ConfirmedLiquidityAction } from "../components/ConfirmedLiquidityAction";
import { ConfirmedArbitrageAction } from "../components/ConfirmedArbitrageAction";
import { transactionResultAvailable } from "../logic/swapReceipt";
import { ConfirmedSwapAction } from "../components/ConfirmedSwapAction";
import { ConfirmedWrappingAction } from "../components/ConfirmedWrappingAction";
import { ConfirmedPoolCreation } from "../components/ConfirmedPoolCreation";
import type { Pool } from "../chain/types";
export function TransactionsPage({ onProvideLiquidity }: { onProvideLiquidity: (pool: Pool) => void }) {
  const { history, wallet, client } = useDex();
  const [query, setQuery] = useState<ActivityQuery | null>(null);
  const context = { kernel: wallet.controller.kernel };
  const page = activityView(context, query);
  const { account, status, page: requestedPage, observedAccount } = page.query;
  useEffect(() => {
    setQuery({ account, status, page: requestedPage, observedAccount });
  }, [account, status, requestedPage, observedAccount]);
  const navigate = (event: ActivityEvent) =>
    setQuery(activityStep(context, page.query, event).query);
  return (
    <section className="card">
      <h2>Blockchain transactions</h2>
      <p>
        Approvals and execution are recorded separately. A rejected step leaves
        earlier confirmed approvals in place. Activity from this deployment is
        restored with its original sender; saved hashes are checked again on
        this chain.
      </p>
      <HistoryStatus history={history} />
      <div className="actions">
        {history.canRefresh && (
          <button
            type="button"
            onClick={() =>
              wallet.controller.dispatch({ kind: "history-refresh" })
            }
          >
            Recheck pending receipts
          </button>
        )}
        {history.canRetryLoad && (
          <button
            type="button"
            onClick={() =>
              wallet.controller.dispatch({ kind: "history-retry-load" })
            }
          >
            Retry loading history
          </button>
        )}
        {history.canRetrySave && (
          <button
            type="button"
            onClick={() =>
              wallet.controller.dispatch({ kind: "history-retry-save" })
            }
          >
            Retry saving history
          </button>
        )}
      </div>
      <div className="actions activity-filters">
        <label>
          Account
          <select
            value={page.query.account}
            onChange={(event) =>
              navigate({
                kind: "account",
                value: event.target.value as ActivityQuery["account"],
              })
            }
          >
            <option value="all">All accounts</option>
            <option value="current" disabled={!page.canCurrentAccount}>
              Current account
            </option>
          </select>
        </label>
        <label>
          Status
          <select
            value={page.query.status}
            onChange={(event) =>
              navigate({
                kind: "status",
                value: event.target.value as ActivityQuery["status"],
              })
            }
          >
            <option value="all">All statuses</option>
            <option value="pending">In progress</option>
            <option value="confirmed">Confirmed</option>
            <option value="failed">Failed</option>
            <option value="unknown">Submission unknown</option>
          </select>
        </label>
        <button type="button" onClick={() => navigate({ kind: "reset" })}>
          Show all
        </button>
      </div>
      <p role="status">
        {page.filteredTotal} of {page.total} transactions
      </p>
      {page.entries.length === 0 ? (
        <p>{page.emptyMessage}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Operation</th>
                <th>Account</th>
                <th>Status</th>
                <th>Transaction / message</th>
                <th>Block</th>
                <th>Gas (ETH)</th>
              </tr>
            </thead>
            <tbody>
              {page.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.label}</td>
                  <td>
                    <code title={entry.account}>{shorten(entry.account)}</code>
                    {entry.authority === "dev-faucet" && entry.beneficiary && (
                      <>
                        {" "}
                        →{" "}
                        <code title={entry.beneficiary}>
                          {shorten(entry.beneficiary)}
                        </code>
                      </>
                    )}
                  </td>
                  <td>
                    {entry.state === "submission-unknown"
                      ? "Submission outcome unavailable"
                      : entry.state}
                  </td>
                  <td>
                    {"hash" in entry && entry.hash && <code>{entry.hash}</code>}
                    {entry.state === "confirmed" &&
                      transactionResultAvailable(
                        client.deployment,
                        entry.descriptor,
                      ) && <TransactionReceipt entry={entry} onProvideLiquidity={onProvideLiquidity} />}
                    {entry.replacements.map((replacement) => (
                      <p key={replacement.hash}>
                        {replacement.kind === "repriced"
                          ? "Fee replacement"
                          : "Different transaction"}
                        : <code>{replacement.hash}</code> →{" "}
                        <code>{replacement.replacementHash}</code>
                      </p>
                    ))}
                    {"message" in entry && entry.message && (
                      <p>{entry.message}</p>
                    )}
                  </td>
                  <td>
                    {"block" in entry && entry.block !== undefined
                      ? entry.block
                      : "—"}
                  </td>
                  <td>
                    {"gas" in entry && entry.gas !== undefined
                      ? formatEther(BigInt(entry.gas))
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.entries.length > 0 && (
        <nav className="actions" aria-label="Transaction pages">
          <button
            type="button"
            disabled={!page.canPrevious}
            onClick={() => navigate({ kind: "previous" })}
          >
            Previous
          </button>
          <span>
            Page {page.page} of {page.pages}
          </span>
          <button
            type="button"
            disabled={!page.canNext}
            onClick={() => navigate({ kind: "next" })}
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}

function TransactionReceipt({
  entry,
  onProvideLiquidity,
}: {
  entry: Extract<JournalView, { state: "confirmed" }>;
  onProvideLiquidity: (pool: Pool) => void;
}) {
  const { client } = useDex();
  // Archives have been scoped and re-observed by the wallet kernel before display.
  const result = useQuery({
    queryKey: [
      "transaction-result",
      client.deployment.rpcUrl,
      client.key,
      entry.instance,
      entry.id,
      entry.hash,
    ],
    queryFn: () => client.transactionResult(entry.hash as Hex),
    enabled: false,
    retry: false,
  });
  return (
    <div>
      {result.data?.kind === "swap" && (
        <ConfirmedSwapAction
          execution={result.data.details.execution}
          tokens={result.data.details.tokens}
        />
      )}
      {result.data?.kind === "liquidity" && (
        <ConfirmedLiquidityAction
          result={result.data.details.confirmation}
          tokens={result.data.details.tokens}
        />
      )}
      {result.data?.kind === "arbitrage" && (
        <ConfirmedArbitrageAction
          result={result.data.details.result}
          tokens={result.data.details.tokens}
        />
      )}
      {result.data?.kind === "creation" && (
        <>
          <p>
            Created contract: <code>{result.data.address}</code>
          </p>
          <p>
            Copy this address into Pools &amp; tokens → Import to read its
            metadata.
          </p>
        </>
      )}
      {result.data?.kind === "wrapping" && (
        <ConfirmedWrappingAction result={result.data.details} />
      )}
      {result.data?.kind === "pool-creation" && (
        <ConfirmedPoolCreation result={result.data.details} onProvideLiquidity={onProvideLiquidity} />
      )}
      {result.data === null && (
        <p>
          No supported operation from this deployment was found in the receipt.
        </p>
      )}
      {result.error && (
        <p role="alert">
          Transaction result could not be read: {result.error.message}
        </p>
      )}
      <button
        className="text"
        type="button"
        disabled={result.isFetching}
        onClick={() => void result.refetch()}
      >
        {result.isFetching
          ? "Reading transaction result…"
          : "Read transaction result"}
      </button>
    </div>
  );
}
