import { useEffect, useMemo, useSyncExternalStore } from "react";
import { formatUnits } from "viem";
import { AllowanceController } from "../chain/allowances";
import { useDex } from "../chain/DexProvider";
import { ConfirmationDialog } from "../components/ConfirmationDialog";
import { shorten } from "../chain/amounts";

export function AllowancesPage() {
  const {client,wallet,tokens,session} = useDex();
  const controller = useMemo(() => new AllowanceController(client,wallet.controller,tokens),[client,wallet.controller,tokens]);
  const view = useSyncExternalStore(controller.subscribe,controller.getSnapshot);
  useEffect(() => () => controller.dispose(),[controller]);
  useEffect(() => { void controller.refresh(); },[controller,session?.epoch]);
  const tokenName = (address:string) => tokens.find(token => token.address === address)?.symbol ?? shorten(address);
  const spenderName = (address:string) => client.deployment.exchanges.find(exchange => exchange.address === address)?.name ?? "Atomic arbitrage";
  return <section className="card">
    <h2>Token approvals</h2>
    <p>Review the amounts these contracts can spend. Revoking an approval sets its remaining amount to zero; earlier trades remain confirmed.</p>
    {view.owner ? <p>Account <code>{view.owner}</code></p> : <p>Connect a wallet to view its approvals.</p>}
    <button type="button" disabled={!view.canRefresh} onClick={() => {void controller.refresh();}}>Refresh</button>
    {view.phase === "loading" && <p role="status">Reading approvals…</p>}
    {view.action.kind !== "idle" && <p role="status">{view.action.message}{view.action.hash && <> <code>{view.action.hash}</code></>}</p>}
    {view.owner && <div className="table-scroll"><table>
      <thead><tr><th>Token</th><th>Spender</th><th>Allowance</th><th>Action</th></tr></thead>
      <tbody>{view.rows.map(row => <tr key={`${row.token}:${row.spender}`}>
        <td><span title={row.token}>{tokenName(row.token)}</span></td>
        <td><span title={row.spender}>{spenderName(row.spender)}</span> <code title={row.spender}>{shorten(row.spender)}</code></td>
        <td>{row.allowance === null ? <span>{row.error ? "Read failed" : "Not observed"}</span> : <span title={row.allowance}>{row.unlimited ? "Unlimited" : formatUnits(BigInt(row.allowance),18)}</span>}
          {row.error && <p role="alert">{row.error}</p>}</td>
        <td><button type="button" disabled={!row.canRevoke} onClick={() => controller.review(row.token,row.spender)}>Revoke</button></td>
      </tr>)}</tbody>
    </table></div>}
    {view.block && <p>Observed at block {view.block}.</p>}
    {view.review && <ConfirmationDialog title="Revoke token approval" onClose={() => controller.cancel()}>
      <dl>
        <dt>Token</dt><dd>{tokenName(view.review.token)} <code>{view.review.token}</code></dd>
        <dt>Account</dt><dd><code>{view.review.owner}</code></dd>
        <dt>Spender</dt><dd>{spenderName(view.review.spender)} <code>{view.review.spender}</code></dd>
        <dt>Current allowance</dt><dd title={view.review.allowance}>{view.review.unlimited ? "Unlimited" : formatUnits(BigInt(view.review.allowance),18)}</dd>
        <dt>New allowance</dt><dd>0</dd>
      </dl>
      <div className="actions"><button type="button" onClick={() => controller.cancel()}>Cancel</button>
        <button type="button" disabled={!view.canConfirm} onClick={() => {void controller.confirm();}}>Revoke approval</button></div>
    </ConfirmationDialog>}
  </section>;
}
