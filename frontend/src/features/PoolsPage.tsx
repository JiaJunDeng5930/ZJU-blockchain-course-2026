import { useMemo, useSyncExternalStore } from "react";
import { useDex } from "../chain/DexProvider";
import { shorten } from "../chain/amounts";
import { dispatchAssetEvent } from "../chain/assets";
import {
  AssetForms,
  assetEnvironment,
  assetPoolPrice,
  poolAssetsSupported,
  unsupportedPoolError,
  type AssetEvent,
  type AssetFormsView,
} from "../logic/assets";
import type { Pool } from "../chain/types";
import { FormError, SubmitButton, TokenSelect } from "../components/Forms";
import { WrapAssets } from "./WrapAssets";

type FormProps = {
  view: AssetFormsView;
  dispatch: (event: AssetEvent) => void;
};
export function PoolsPage({ onSelect }: { onSelect: (pool: Pool) => void }) {
  const {
    client,
    session,
    snapshot,
    tokens,
    symbol,
    pending,
    amount,
    precision,
    run,
    registerToken,
  } = useDex();
  const environment = assetEnvironment(
    client.deployment.exchanges,
    tokens,
    snapshot.data?.pools ?? [],
    !!session,
    pending
  );
  const controller = useMemo(() => new AssetForms(environment), [client]);
  useSyncExternalStore(controller.subscribe, controller.snapshot);
  const forms = controller.view(environment);
  const dispatch = (event: AssetEvent) =>
    dispatchAssetEvent(
      { client, controller, environment, run, registerToken },
      event
    );
  return (
    <>
      <section className="card">
        <h2>Exchange pools</h2>
        {snapshot.data?.pools.length === 0 && (
          <p>
            No pools yet. Create a pair below, then add its first liquidity
            deposit.
          </p>
        )}
        <div className="markets">
          {snapshot.data?.pools.map((pool) => (
            <article
              className="market"
              key={`${pool.exchange.address}:${pool.id}`}
            >
              <p>
                {pool.exchange.name} · pool #{String(pool.id)}
              </p>
              <h3>
                {symbol(pool.token0)} / {symbol(pool.token1)}
              </h3>
              {poolAssetsSupported(pool, tokens) ? (
                <>
                  <p>
                    {assetPoolPrice(
                      pool.reserve0,
                      pool.reserve1,
                      precision(pool.token0),
                      precision(pool.token1),
                      symbol(pool.token0),
                      symbol(pool.token1)
                    )}
                  </p>
                  <p>
                    {amount(pool.reserve0, pool.token0)} {symbol(pool.token0)} /{" "}
                    {amount(pool.reserve1, pool.token1)} {symbol(pool.token1)}{" "}
                    in reserves
                  </p>
                </>
              ) : (
                <p>{unsupportedPoolError}</p>
              )}
              <code title={pool.exchange.address}>
                {shorten(pool.exchange.address)}
              </code>
              <button
                className="text"
                disabled={!poolAssetsSupported(pool, tokens)}
                onClick={() => onSelect(pool)}
              >
                Trade this pool
              </button>
            </article>
          ))}
        </div>
      </section>
      <div className="workspace">
        <CreatePool view={forms} dispatch={dispatch} />
        <TokenRegistry view={forms} dispatch={dispatch} />
      </div>
      <WrapAssets />
    </>
  );
}
function CreatePool({ view, dispatch }: FormProps) {
  const { client } = useDex();
  const draft = view.draft;
  return (
    <form
      className="card form"
      onSubmit={(event) => {
        event.preventDefault();
        dispatch({ kind: "pool" });
      }}
    >
      <h2>Create a pool</h2>
      <label>
        Exchange
        <select
          aria-label="Create pool exchange"
          value={draft.exchange}
          onChange={(event) =>
            dispatch({
              kind: "edit",
              field: "exchange",
              value: event.target.value,
            })
          }
        >
          {client.deployment.exchanges.map((exchange) => (
            <option key={exchange.address} value={exchange.address}>
              {exchange.name}
            </option>
          ))}
        </select>
      </label>
      <TokenSelect
        label="First token"
        value={draft.first}
        onChange={(value) => dispatch({ kind: "edit", field: "first", value })}
      />
      <TokenSelect
        label="Second token"
        value={draft.second}
        onChange={(value) => dispatch({ kind: "edit", field: "second", value })}
      />
      <FormError message={view.poolError ?? undefined} />
      <SubmitButton disabled={!view.canCreatePool}>Create pool</SubmitButton>
      <p>
        Add liquidity after creating the pool to open it for trading. Use WETH
        for a market against ETH.
      </p>
    </form>
  );
}
function TokenRegistry({ view, dispatch }: FormProps) {
  const { tokens, catalogError } = useDex();
  const draft = view.draft;
  return (
    <section className="card">
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          dispatch({ kind: "deploy" });
        }}
      >
        <h2>Create a test token</h2>
        <label>
          Name
          <input
            maxLength={100}
            value={draft.name}
            onChange={(event) =>
              dispatch({
                kind: "edit",
                field: "name",
                value: event.target.value,
              })
            }
          />
        </label>
        <label>
          Symbol
          <input
            maxLength={100}
            value={draft.symbol}
            onChange={(event) =>
              dispatch({
                kind: "edit",
                field: "symbol",
                value: event.target.value,
              })
            }
          />
        </label>
        <FormError message={view.deploymentError ?? undefined} />
        <SubmitButton disabled={!view.canDeploy}>Deploy ERC20</SubmitButton>
        <p>
          Each address can claim 10,000 units of a test token from the wallet
          panel.
        </p>
      </form>
      <form
        className="form token-import"
        onSubmit={(event) => {
          event.preventDefault();
          dispatch({ kind: "import" });
        }}
      >
        <h3>Import an existing ERC20</h3>
        <label>
          ERC20 address
          <input
            placeholder="0x…"
            value={draft.address}
            disabled={view.importing}
            onChange={(event) =>
              dispatch({
                kind: "edit",
                field: "address",
                value: event.target.value,
              })
            }
          />
        </label>
        <FormError message={view.importError ?? undefined} />
        <button className="secondary" disabled={!view.canImport}>
          {view.importing ? "Reading token…" : "Import token"}
        </button>
        <p>
          This exchange supports standard ERC20 tokens with readable decimal
          metadata (0–255 places). Their addresses are saved for this
          deployment.
        </p>
      </form>
      <FormError message={catalogError ?? undefined} />
      <details className="token-import">
        <summary>Available tokens ({tokens.length})</summary>
        {tokens.map((token) => (
          <p key={token.address}>
            <strong>{token.symbol}</strong> · {token.name}
            <br />
            <code>{token.address}</code>
          </p>
        ))}
      </details>
    </section>
  );
}
