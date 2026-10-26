import { formatEther } from "ethers";
import { useDex } from "../chain/DexProvider";
export function TransactionsPage() {
  const { journal } = useDex();
  return (
    <section className="card">
      <h2>Blockchain transactions</h2>
      <p>
        Approvals and execution are recorded separately. A rejected step leaves
        earlier confirmed approvals in place. This journal belongs to this
        browser session.
      </p>
      {journal.length === 0 ? (
        <p>No transactions yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Operation</th>
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
                  <td>{entry.state}</td>
                  <td>
                    {"hash" in entry && entry.hash && <code>{entry.hash}</code>}
                    {entry.state === "failed" && <p>{entry.message}</p>}
                  </td>
                  <td>{entry.state === "confirmed" ? entry.block : "—"}</td>
                  <td>
                    {entry.state === "confirmed" ? formatEther(entry.gas) : "—"}
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
