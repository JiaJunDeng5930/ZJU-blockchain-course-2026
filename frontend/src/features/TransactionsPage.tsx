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
import { arbitrageReceiptAvailable } from "../logic/arbitrageReceipt";
import { liquidityReceiptAvailable } from "../logic/liquidityReceipt";
export function TransactionsPage() {
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
                      entry.descriptor?.to === null && (
                        <CreatedContractReceipt entry={entry} />
                      )}
                    {entry.state === "confirmed" &&
                      liquidityReceiptAvailable(
                        client.deployment.exchanges,
                        entry.descriptor,
                      ) && <LiquidityReceipt entry={entry} />}
                    {entry.state === "confirmed" &&
                      arbitrageReceiptAvailable(
                        client.deployment.arbitrage,
                        entry.descriptor,
                      ) && <ArbitrageReceipt entry={entry} />}
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

function LiquidityReceipt({
  entry,
}: {
  entry: Extract<JournalView, { state: "confirmed" }>;
}) {
  const { client } = useDex();
  const result = useQuery({
    queryKey: [
      "liquidity-receipt",
      client.deployment.rpcUrl,
      client.key,
      entry.instance,
      entry.id,
      entry.hash,
    ],
    queryFn: () => client.liquidityReceipt(entry.hash as Hex),
    enabled: false,
    retry: false,
  });
  return (
    <div>
      {result.data && (
        <ConfirmedLiquidityAction
          result={result.data.confirmation}
          tokens={result.data.tokens}
        />
      )}
      {result.data === null && (
        <p>
          No liquidity operation from this deployment was found in the receipt.
        </p>
      )}
      {result.error && (
        <p role="alert">
          Liquidity receipt could not be read: {result.error.message}
        </p>
      )}
      <button
        className="text"
        type="button"
        disabled={result.isFetching}
        onClick={() => void result.refetch()}
      >
        {result.isFetching
          ? "Reading liquidity receipt…"
          : "Read liquidity result"}
      </button>
    </div>
  );
}

function CreatedContractReceipt({
  entry,
}: {
  entry: Extract<JournalView, { state: "confirmed" }>;
}) {
  const { client } = useDex();
  // The kernel exposes only archives from this RPC/genesis/deployment scope;
  // restored confirmations have already been re-observed on that same RPC.
  const receipt = useQuery({
    queryKey: [
      "created-contract-receipt",
      client.deployment.rpcUrl,
      client.key,
      entry.instance,
      entry.id,
      entry.hash,
    ],
    queryFn: () =>
      client.rpc.getTransactionReceipt({ hash: entry.hash as Hex }),
    enabled: false,
    retry: false,
  });
  return (
    <div>
      {receipt.data?.status === "success" && receipt.data.contractAddress ? (
        <>
          <p>
            Created contract: <code>{receipt.data.contractAddress}</code>
          </p>
          <p>
            Copy this address into Pools &amp; tokens → Import to read its
            metadata.
          </p>
        </>
      ) : receipt.data ? (
        <p>The observed receipt contains no successful contract creation.</p>
      ) : null}
      {receipt.error && (
        <p role="alert">
          Creation receipt could not be read: {receipt.error.message}
        </p>
      )}
      <button
        className="text"
        type="button"
        disabled={receipt.isFetching}
        onClick={() => void receipt.refetch()}
      >
        {receipt.isFetching
          ? "Reading creation receipt…"
          : "Read created contract"}
      </button>
    </div>
  );
}

function ArbitrageReceipt({
  entry,
}: {
  entry: Extract<JournalView, { state: "confirmed" }>;
}) {
  const { client } = useDex();
  const result = useQuery({
    queryKey: [
      "arbitrage-receipt",
      client.deployment.rpcUrl,
      client.key,
      entry.instance,
      entry.id,
      entry.hash,
    ],
    queryFn: () => client.arbitrageReceipt(entry.hash as Hex),
    enabled: false,
    retry: false,
  });
  return (
    <div>
      {result.data && (
        <ConfirmedArbitrageAction
          result={result.data.result}
          tokens={result.data.tokens}
        />
      )}
      {result.data === null && (
        <p>
          No arbitrage operation from this deployment was found in the receipt.
        </p>
      )}
      {result.error && (
        <p role="alert">
          Arbitrage receipt could not be read: {result.error.message}
        </p>
      )}
      <button
        className="text"
        type="button"
        disabled={result.isFetching}
        onClick={() => void result.refetch()}
      >
        {result.isFetching
          ? "Reading arbitrage receipt…"
          : "Read arbitrage result"}
      </button>
    </div>
  );
}
