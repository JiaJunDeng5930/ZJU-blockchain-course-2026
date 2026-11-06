import { useDex } from "../chain/DexProvider";
import { formatAmount } from "../chain/amounts";

export function TransactionsPage() {
  const { journal, wallet } = useDex();
  return (
    <section className="panel transactions-panel">
      <div className="section-heading">
        <div>
          <h1>Transactions</h1>
          <p>Transactions in this page session.</p>
        </div>
        <button
          type="button"
          onClick={() =>
            wallet.controller.dispatch({ kind: "pending-refresh" })
          }
        >
          Recheck pending transactions
        </button>
      </div>
      {journal.length === 0 ? (
        <p className="empty-state">No transaction activity in this page.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Operation</th>
                <th>Account</th>
                <th>Status</th>
                <th>Transaction</th>
                <th>Block</th>
                <th>Execution fee (ETH)</th>
              </tr>
            </thead>
            <tbody>
              {[...journal].reverse().map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.label}</td>
                  <td>
                    <code title={entry.account}>
                      {entry.account.slice(0, 8)}…{entry.account.slice(-6)}
                    </code>
                    {entry.authority === "dev-faucet" && (
                      <small>Development faucet for {entry.beneficiary}</small>
                    )}
                  </td>
                  <td>
                    {entry.state === "awaiting-wallet"
                      ? "Awaiting wallet"
                      : entry.state === "submitted"
                        ? "Pending"
                        : entry.state === "confirmed"
                          ? "Confirmed"
                          : entry.state === "submission-unknown"
                            ? "Submission unknown"
                            : entry.state === "replaced"
                              ? "Replaced"
                              : "Failed"}
                    {"message" in entry && entry.message && (
                      <small>{entry.message}</small>
                    )}
                  </td>
                  <td>
                    {"hash" in entry && entry.hash ? (
                      <code title={entry.hash}>
                        {entry.hash.slice(0, 12)}…{entry.hash.slice(-8)}
                      </code>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {"block" in entry && entry.block !== undefined
                      ? entry.block.toString()
                      : "—"}
                  </td>
                  <td>
                    {"gas" in entry && entry.gas !== undefined
                      ? formatAmount(entry.gas, 18, 8)
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
