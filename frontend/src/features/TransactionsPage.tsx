import { HistoryStatus } from "../components/HistoryStatus";
import { formatEther } from "viem";
import { shorten } from "../chain/amounts";
import { useDex } from "../chain/DexProvider";
export function TransactionsPage() {
  const { journal, history, wallet } = useDex();
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
      {journal.length === 0 ? (
        <p>No transactions yet.</p>
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
              {journal.map((entry) => (
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
                      ? formatEther(entry.gas)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
