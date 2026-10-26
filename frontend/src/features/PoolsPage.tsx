import { useState } from "react";
import { useDex } from "../chain/DexProvider";
import {
  errorMessage,
  formatAmount,
  positiveAmount,
  reservePrice,
  sameAddress,
  shorten,
} from "../chain/amounts";
import type { Pool } from "../chain/types";
import {
  AmountField,
  FormError,
  SubmitButton,
  TokenSelect,
  amountError,
} from "../components/Forms";

export function PoolsPage({ onSelect }: { onSelect: (pool: Pool) => void }) {
  const { snapshot, symbol } = useDex();
  return (
    <>
      <section className="card">
        <h2>Exchange pools</h2>
        <div className="markets">
          {snapshot.data?.pools.map((pool) => (
            <article
              className="market"
              key={`${pool.exchange.address}:${pool.id}`}
            >
              <small>
                {pool.exchange.name} · pool #{String(pool.id)}
              </small>
              <h3>
                {symbol(pool.token0)} / {symbol(pool.token1)}
              </h3>
              <strong>{reservePrice(pool)?.toFixed(6) ?? "Unfunded"}</strong>
              <p>
                {formatAmount(pool.reserve0)} / {formatAmount(pool.reserve1)} in
                reserves
              </p>
              <code title={pool.exchange.address}>
                {shorten(pool.exchange.address)}
              </code>
              <button className="text" onClick={() => onSelect(pool)}>
                Trade this pool
              </button>
            </article>
          ))}
        </div>
      </section>
      <div className="workspace">
        <CreatePool />
        <TokenRegistry />
      </div>
      <WrapEther />
    </>
  );
}
function CreatePool() {
  const { client, tokens, snapshot, run } = useDex();
  const [exchange, setExchange] = useState(
    client.deployment.exchanges[0].address,
  );
  const [token0, setToken0] = useState(tokens[0].address);
  const [token1, setToken1] = useState(tokens[1].address);
  const exists = snapshot.data?.pools.some(
    (pool) =>
      sameAddress(pool.exchange.address, exchange) &&
      [pool.token0, pool.token1].every(
        (address) =>
          sameAddress(address, token0) || sameAddress(address, token1),
      ),
  );
  const invalid = sameAddress(token0, token1)
    ? "Choose two different tokens."
    : exists
      ? "This pair already has a pool on this exchange."
      : undefined;
  return (
    <form
      className="card form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!invalid)
          run("Create pool", (writer) =>
            writer.createPool(exchange, token0, token1),
          );
      }}
    >
      <h2>Create a pool</h2>
      <label>
        Exchange
        <select
          aria-label="Create pool exchange"
          value={exchange}
          onChange={(event) => setExchange(event.target.value)}
        >
          {client.deployment.exchanges.map((e) => (
            <option key={e.address} value={e.address}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
      <TokenSelect label="First token" value={token0} onChange={setToken0} />
      <TokenSelect label="Second token" value={token1} onChange={setToken1} />
      <FormError message={invalid} />
      <SubmitButton disabled={!!invalid}>Create pool</SubmitButton>
      <p>
        After creating a pool, add its first liquidity deposit. WETH pools
        represent trading against wrapped native ETH.
      </p>
    </form>
  );
}
function TokenRegistry() {
  const { client, registerToken, run, pending } = useDex();
  const [name, setName] = useState("Demo Token");
  const [symbol, setSymbol] = useState("DEMO");
  const [address, setAddress] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="card">
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && symbol.trim())
            run("Deploy ERC20", async (writer) =>
              registerToken(
                await writer.createToken(name.trim(), symbol.trim()),
              ),
            );
        }}
      >
        <h2>Create a test token</h2>
        <label>
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>
        <label>
          Symbol
          <input
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
            required
          />
        </label>
        <SubmitButton disabled={!name.trim() || !symbol.trim()}>
          Deploy ERC20
        </SubmitButton>
      </form>
      <form
        className="form token-import"
        onSubmit={(event) => {
          event.preventDefault();
          setImporting(true);
          setError("");
          void client
            .importToken(address)
            .then(registerToken)
            .catch((cause: unknown) => setError(errorMessage(cause)))
            .finally(() => setImporting(false));
        }}
      >
        <h3>Import an existing ERC20</h3>
        <label>
          ERC20 address
          <input
            placeholder="0x…"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <FormError message={error || undefined} />
        <button
          className="secondary"
          disabled={!address || importing || pending}
        >
          {importing ? "Reading token…" : "Import token"}
        </button>
        <p>
          Imported tokens must use 18 decimals. Token addresses are saved in
          this browser for this deployment.
        </p>
      </form>
    </section>
  );
}
function WrapEther() {
  const { client, session, snapshot, run, pending } = useDex();
  const [value, setValue] = useState("1");
  const wrapped = client.deployment.tokens.find(
    (token) => token.kind === "wrapped",
  );
  const basicError = amountError(value);
  const wrapError = amountError(
    value,
    session ? snapshot.data?.ether : undefined,
  );
  const unwrapError = amountError(
    value,
    wrapped ? snapshot.data?.balances[wrapped.address] : undefined,
  );
  return (
    <section className="card form">
      <h2>ETH / WETH</h2>
      <p>
        Deposit native ETH to receive 1:1 backed WETH. Withdraw WETH to receive
        native ETH.
      </p>
      <AmountField
        label="ETH / WETH amount"
        value={value}
        onChange={setValue}
      />
      <FormError message={basicError} />
      <div className="row">
        <button
          disabled={pending || !session || !!wrapError}
          onClick={() =>
            run("Wrap ETH", (writer) =>
              writer.wrap(positiveAmount(value), false),
            )
          }
        >
          Wrap ETH
        </button>
        <button
          className="secondary"
          disabled={pending || !session || !!unwrapError}
          onClick={() =>
            run("Unwrap WETH", (writer) =>
              writer.wrap(positiveAmount(value), true),
            )
          }
        >
          Unwrap WETH
        </button>
      </div>
    </section>
  );
}
