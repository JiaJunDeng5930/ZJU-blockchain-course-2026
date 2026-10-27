import { formatAmount, shorten, tokenLabel } from "../chain/amounts";
import { useDex } from "../chain/DexProvider";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { OnboardingGuide } from "./OnboardingGuide";
import { Link, useSearchParams } from "react-router-dom";

export function WalletMenu({
  open,
  onOpen,
  onClose,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const {
    client,
    wallet,
    session,
    accounts,
    snapshot,
    tokens,
    pending,
    status,
    run,
    refresh,
  } = useDex();
  const [searchParams] = useSearchParams();
  const wrappingSearch = new URLSearchParams(searchParams);
  wrappingSearch.set("view", "pools");
  const mismatch =
    wallet.state.kind === "unavailable" &&
    wallet.state.reason === "wrong-network";
  return (
    <div className="wallet-control">
      <button
        className={`account-control${mismatch ? " account-wrong-network" : ""}`}
        aria-label="Open wallet"
        onClick={onOpen}
      >
        <span className="account-dot" />
        {session ? (
          <>
            {session.kind === "local" && (
              <span className="demo-label">Demo · </span>
            )}
            <span aria-label="Connected account" title={session.address}>
              {shorten(session.address)}
            </span>
          </>
        ) : mismatch ? (
          "Wrong network"
        ) : (
          "Connect wallet"
        )}
      </button>
      {open && (
        <ConfirmationDialog
          title="Wallet and test assets"
          onClose={onClose}
          closeLabel="Close wallet"
          className="wallet-dialog"
        >
          <div className="wallet-kind">
            <button
              className={wallet.source === "local" ? "selected" : ""}
              disabled={pending}
              onClick={() => {
                const address = accounts.data?.[0];
                if (address) wallet.selectLocal(address);
              }}
            >
              Demo wallet
            </button>
            <button
              className={wallet.source === "injected" ? "selected" : ""}
              disabled={pending}
              onClick={wallet.connectInjected}
            >
              Connect browser wallet
            </button>
          </div>
          {wallet.source === "local" && (
            <label className="wallet-account-picker">
              Test account
              <select
                aria-label="Test account"
                value={
                  session?.kind === "local" ? session.address.toLowerCase() : ""
                }
                disabled={pending}
                onChange={(event) => wallet.selectLocal(event.target.value)}
              >
                <option value="" disabled>
                  Select an account
                </option>
                {accounts.data?.map((address, index) => (
                  <option key={address} value={address.toLowerCase()}>
                    Account {index + 1} · {shorten(address)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {wallet.state.kind === "connecting" && <p>Connecting wallet…</p>}
          {wallet.state.kind === "unavailable" && (
            <div className="wallet-problem">
              <p role="alert">{wallet.state.message}</p>
              {mismatch && (
                <button
                  className="button-primary"
                  disabled={pending}
                  onClick={() => {
                    void wallet.switchNetwork();
                  }}
                >
                  Add / switch local network
                </button>
              )}
            </div>
          )}
          {accounts.error && <p role="alert">{accounts.error.message}</p>}
          {session && (
            <>
              <div className="wallet-balance-heading">
                <h3>Your balances</h3>
                <button
                  className="text"
                  disabled={pending || snapshot.isFetching}
                  onClick={() => {
                    void refresh();
                  }}
                >
                  Refresh
                </button>
              </div>
              <div className="wallet-asset-list">
                <div className="wallet-asset">
                  <span className="asset-mark">Ξ</span>
                  <div>
                    <strong title="Used for network fees">ETH</strong>
                  </div>
                  <div className="wallet-asset-amount">
                    <strong>
                      {snapshot.data
                        ? formatAmount(snapshot.data.ether, 18, 4)
                        : "—"}
                    </strong>
                    <button
                      className="text"
                      disabled={pending}
                      onClick={() =>
                        run("Claim local ETH", (writer) => writer.claimEther())
                      }
                    >
                      Claim 10 local ETH
                    </button>
                  </div>
                </div>
                {tokens.map((token) => (
                  <div className="wallet-asset" key={token.address}>
                    <span className="asset-mark">
                      {token.symbol.slice(0, 2)}
                    </span>
                    <div title={`${token.name} · ${token.address}`}>
                      <strong>{tokenLabel(token.address, token.symbol)}</strong>
                    </div>
                    <div className="wallet-asset-amount">
                      <strong>
                        {snapshot.data
                          ? formatAmount(
                              snapshot.data.balances[token.address] ?? 0n,
                              token.decimals,
                            )
                          : "—"}
                      </strong>
                      {token.kind === "faucet" && (
                        <button
                          className="text"
                          aria-label={`Claim 10,000 ${token.symbol} (${token.address})`}
                          title={token.address}
                          disabled={pending}
                          onClick={() =>
                            run(`Claim ${token.symbol}`, (writer) =>
                              writer.faucet(token),
                            )
                          }
                        >
                          Claim 10,000 {token.symbol}
                        </button>
                      )}
                      {token.kind === "wrapped" && (
                        <Link
                          className="text"
                          to={{
                            search: `?${wrappingSearch}`,
                            hash: "#wrap-assets",
                          }}
                          onClick={onClose}
                        >
                          Wrap / unwrap
                        </Link>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          <OnboardingGuide />
          {pending ||
          status.startsWith("Operation stopped") ||
          status.includes("confirmed in block") ? (
            <p
              className="wallet-action-status"
              role="status"
              aria-live="polite"
            >
              {status}
            </p>
          ) : null}
          <details className="connection-details">
            <summary>Connection details</summary>
            {session && <code>{session.address}</code>}
            <p>
              Chain {client.deployment.chainId} · {client.deployment.rpcUrl}
            </p>
            <p>
              {wallet.source === "local"
                ? "The local node signs for this public demo account."
                : "Your browser wallet asks you to confirm each transaction."}{" "}
              Test assets only.
            </p>
          </details>
        </ConfirmationDialog>
      )}
    </div>
  );
}
