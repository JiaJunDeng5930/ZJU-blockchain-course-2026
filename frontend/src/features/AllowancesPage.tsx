import { useEffect, useMemo, useSyncExternalStore } from "react";
import { formatUnits } from "../logic/units";
import { AllowanceController } from "../chain/allowances";
import { useDex } from "../chain/DexProvider";
import { ConfirmationDialog } from "../components/ConfirmationDialog";
import { shorten, tokenLabel } from "../chain/amounts";

export function AllowancesPage() {
  const { client, wallet, tokens, session, symbol } = useDex();
  const controller = useMemo(
    () => new AllowanceController(client, wallet.controller, tokens),
    [client, wallet.controller, tokens]
  );
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot
  );
  useEffect(() => {
    void controller.refresh();
  }, [controller, session?.epoch]);
  const spenderName = (address: string) =>
    client.deployment.exchanges.find((exchange) => exchange.address === address)
      ?.name ?? "Atomic arbitrage";
  return (
    <section className="card">
      <h2>Token approvals</h2>
      <p>
        These approvals let this deployment's contracts spend the named ERC20
        token on chain {client.deployment.chainId}. An allowance is a spending
        limit, not a token balance. Revoking sets it to zero; earlier trades
        remain confirmed.
      </p>
      {view.owner ? (
        <p>
          Account <code>{view.owner}</code>
        </p>
      ) : (
        <p>Connect a wallet on this chain to view its approvals.</p>
      )}
      <button
        type="button"
        disabled={!view.canRefresh}
        onClick={() => {
          void controller.refresh();
        }}
      >
        Refresh
      </button>
      {view.phase === "loading" && <p role="status">Reading approvals…</p>}
      {view.action.kind !== "idle" && (
        <p role="status">
          {view.action.message}
          {view.action.hash && (
            <>
              {" "}
              <code>{view.action.hash}</code>
            </>
          )}
        </p>
      )}
      {view.owner && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>Spender</th>
                <th>Allowance</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <tr key={`${row.token}:${row.spender}`}>
                  <td>
                    <span title={row.token}>
                      {tokenLabel(row.token, symbol(row.token))}
                    </span>
                  </td>
                  <td>
                    <span title={row.spender}>{spenderName(row.spender)}</span>{" "}
                    <code title={row.spender}>{shorten(row.spender)}</code>
                  </td>
                  <td>
                    {row.allowance === null ? (
                      <span>{row.error ? "Read failed" : "Not observed"}</span>
                    ) : (
                      <span title={row.allowance}>
                        {row.unlimited
                          ? "Unlimited"
                          : formatUnits(
                              BigInt(row.allowance),
                              tokens.find(
                                (token) =>
                                  token.address.toLowerCase() ===
                                  row.token.toLowerCase()
                              )!.decimals
                            )}
                      </span>
                    )}
                    {row.error && <p role="alert">{row.error}</p>}
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={!row.canRevoke}
                      onClick={() => controller.review(row.token, row.spender)}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view.block && <p>Observed at block {view.block}.</p>}
      {view.review && (
        <ConfirmationDialog
          title="Revoke token approval"
          onClose={() => controller.cancel()}
        >
          <dl>
            <dt>Token</dt>
            <dd>
              {symbol(view.review.token)} <code>{view.review.token}</code>
            </dd>
            <dt>Account</dt>
            <dd>
              <code>{view.review.owner}</code>
            </dd>
            <dt>Wallet</dt>
            <dd>
              {view.review.identity.source === "local"
                ? "Local test account"
                : "Browser wallet"}
            </dd>
            <dt>Chain</dt>
            <dd>{view.review.identity.chain}</dd>
            <dt>Spender</dt>
            <dd>
              {spenderName(view.review.spender)}{" "}
              <code>{view.review.spender}</code>
            </dd>
            <dt>Allowance observed at block</dt>
            <dd>{view.block}</dd>
            <dt>Observed allowance</dt>
            <dd title={view.review.allowance}>
              {view.review.unlimited
                ? "Unlimited"
                : formatUnits(
                    BigInt(view.review.allowance),
                    tokens.find(
                      (token) =>
                        token.address.toLowerCase() ===
                        view.review!.token.toLowerCase()
                    )!.decimals
                  )}
            </dd>
            <dt>New allowance</dt>
            <dd>0</dd>
          </dl>
          <p>
            Spending can change the remaining allowance after this observation.
            This transaction sets it to zero, transfers no tokens and requires
            ETH for gas.
          </p>
          <div className="actions">
            <button type="button" onClick={() => controller.cancel()}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!view.canConfirm}
              onClick={() => {
                void controller.confirm();
              }}
            >
              Revoke approval
            </button>
          </div>
        </ConfirmationDialog>
      )}
    </section>
  );
}
