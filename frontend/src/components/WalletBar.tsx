import { formatAmount, shorten } from "../chain/amounts";
import { useDex } from "../chain/DexProvider";

export function WalletBar() {
  const { wallet, session, accounts, snapshot, tokens, pending, run, refresh } =
    useDex();
  return (
    <>
      <section className="wallet card">
        <div>
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
          {wallet.state.kind === "connecting" && (
            <small>Connecting wallet…</small>
          )}
          {wallet.state.kind === "unavailable" && (
            <p role="alert">{wallet.state.message}</p>
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
