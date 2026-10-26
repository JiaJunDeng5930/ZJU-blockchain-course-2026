import { formatAmount, shorten } from "../chain/amounts";
import { useDex } from "../chain/DexProvider";
import { OnboardingGuide } from "./OnboardingGuide";

export function WalletBar() {
  const { wallet, session, accounts, snapshot, tokens, pending, run, refresh } =
    useDex();
  return (
    <>
      <section className="wallet card">
        <div>
          <strong>
            {wallet.source === "local"
              ? "Local demo account"
              : "Browser wallet"}
          </strong>
          <label htmlFor="account">
            Test account · {accounts.data?.length ?? 0} funded addresses
          </label>
          <select
            id="account"
            value={
              session?.kind === "local" ? session.address.toLowerCase() : ""
            }
            disabled={pending}
            onChange={(event) => wallet.selectLocal(event.target.value)}
          >
            <option value="" disabled>
              {session?.kind === "injected"
                ? "Browser wallet connected"
                : "Select local account"}
            </option>
            {accounts.data?.map((address, index) => (
              <option key={address} value={address.toLowerCase()}>
                Account {index + 1} · {address}
              </option>
            ))}
          </select>
          {session && (
            <small>
              Connected account:{" "}
              <span aria-label="Connected account" title={session.address}>
                {session.address}
              </span>{" "}
              · {session.kind === "local" ? "Local RPC" : "Browser wallet"}
            </small>
          )}
          {session?.kind === "local" && (
            <small>
              Transactions use this node's public test account. No wallet
              extension or private key import is needed.
            </small>
          )}
          {session?.kind === "injected" && (
            <small>
              Your browser wallet approves transactions. Only use the local
              teaching network and test assets here.
            </small>
          )}
          {wallet.state.kind === "connecting" && (
            <small>Connecting wallet…</small>
          )}
          {wallet.state.kind === "unavailable" && (
            <div>
              <p role="alert">{wallet.state.message}</p>
              {wallet.state.reason === "wrong-network" && (
                <button
                  className="secondary"
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
        </div>
        <button disabled={pending} onClick={wallet.connectInjected}>
          Connect browser wallet
        </button>
        <button
          className="secondary"
          disabled={pending || snapshot.isFetching}
          onClick={() => {
            void refresh();
          }}
        >
          Refresh
        </button>
      </section>
      <OnboardingGuide />
      {accounts.error && (
        <p role="alert">Local accounts unavailable: {accounts.error.message}</p>
      )}
      {session && (
        <div className="balances">
          <div>
            <small>Gas balance</small>
            <strong>
              {snapshot.data ? formatAmount(snapshot.data.ether, 4) : "—"} ETH
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
          {tokens.map((token) => (
            <div key={token.address}>
              <small>{token.symbol}</small>
              <strong>
                {snapshot.data
                  ? formatAmount(snapshot.data.balances[token.address] ?? 0n)
                  : "—"}
              </strong>
              {token.kind === "faucet" && (
                <button
                  className="text"
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
              <small title={token.address}>{shorten(token.address)}</small>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
