import { useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import { useDex } from "../chain/DexProvider";
import { poolLabel, shorten } from "../chain/amounts";
import { formatUnits } from "../logic/units";
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
import type { Pool, Token } from "../chain/types";
import { FormError, SubmitButton, TokenSelect } from "../components/Forms";
import { WrapAssets } from "./WrapAssets";
import "./PoolsPage.css";

type FormProps = {
  view: AssetFormsView;
  dispatch: (event: AssetEvent) => void;
};
export function PoolsPage({
  onSelect,
  onProvideLiquidity,
}: {
  onSelect: (pool: Pool) => void;
  onProvideLiquidity: (pool: Pool) => void;
}) {
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
  const poolForm = useRef<HTMLFormElement>(null);
  const environment = assetEnvironment(
    client.deployment.exchanges,
    tokens,
    snapshot.data?.pools ?? [],
    !!session,
    pending,
  );
  const controller = useMemo(() => new AssetForms(environment), [client]);
  useSyncExternalStore(controller.subscribe, controller.snapshot);
  const forms = controller.view(environment);
  const dispatch = (event: AssetEvent) =>
    dispatchAssetEvent(
      { client, controller, environment, run, registerToken },
      event,
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
              <h3
                title={`${pool.exchange.address} · ${pool.token0} / ${pool.token1}`}
              >
                {poolLabel(pool, symbol)}
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
                      symbol(pool.token1),
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
              {pool.totalShares === 0n && (
                <p>The first deposit sets the starting price.</p>
              )}
              <button
                className="text"
                disabled={
                  pending || !session || !poolAssetsSupported(pool, tokens)
                }
                onClick={() => onProvideLiquidity(pool)}
              >
                Add liquidity
              </button>
              <button
                className="text"
                disabled={
                  !poolAssetsSupported(pool, tokens) || pool.totalShares === 0n
                }
                onClick={() => onSelect(pool)}
              >
                Trade this pool
              </button>
            </article>
          ))}
        </div>
      </section>
      <div className="workspace">
        <CreatePool view={forms} dispatch={dispatch} formRef={poolForm} />
        <TokenRegistry view={forms} dispatch={dispatch} />
      </div>
      <AvailableTokens
        onUseToken={(token) => {
          dispatch({ kind: "edit", field: "first", value: token.address });
          poolForm.current!.focus({ preventScroll: true });
          poolForm.current!.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        }}
      />
      <WrapAssets />
    </>
  );
}
function CreatePool({
  view,
  dispatch,
  formRef,
}: FormProps & { formRef: RefObject<HTMLFormElement | null> }) {
  const { client } = useDex();
  const draft = view.draft;
  return (
    <form
      id="create-pool"
      ref={formRef}
      tabIndex={-1}
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
          title={draft.exchange}
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
            <option
              key={exchange.address}
              value={exchange.address}
              title={exchange.address}
            >
              {exchange.name} · {shorten(exchange.address)}
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
        Creating a pool does not deposit tokens or mint a position NFT. Add its
        first liquidity deposit to set the initial price and open it for
        trading. Use WETH for a market against ETH.
      </p>
    </form>
  );
}
function TokenRegistry({ view, dispatch }: FormProps) {
  const { catalogError } = useDex();
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
          New test tokens use 18 decimal places and start with zero supply.
          Deployment does not fund your wallet. Open the wallet panel to claim
          10,000 units, then select the token for a new pool below.
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
    </section>
  );
}

function AvailableTokens({
  onUseToken,
}: {
  onUseToken: (token: Token) => void;
}) {
  const { tokens, session, snapshot } = useDex();
  return (
    <section className="card available-tokens">
      <h2>Available tokens ({tokens.length})</h2>
      <p>
        Created and imported tokens appear here. Select a token to use it as the
        first asset in the new-pool form. Creating or importing a token does not
        create a market for it.
      </p>
      <div className="table-scroll">
        <table className="asset-table">
          <caption>
            {session
              ? `Balances for ${shorten(session.address)}${snapshot.data ? ` at block ${snapshot.data.block}` : ""}`
              : "Connect a wallet to read balances."}
          </caption>
          <thead>
            <tr>
              <th>Token</th>
              <th>Contract</th>
              <th>Decimals</th>
              <th>Your balance</th>
              <th>New pool</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((token) => {
              // DEFENSE: a newly registered token can precede its refreshed balance snapshot.
              const balance =
                snapshot.data?.balances[token.address.toLowerCase()];
              return (
                <tr key={token.address}>
                  <td>
                    {token.name} ({token.symbol})
                  </td>
                  <td>
                    <code>{token.address}</code>
                  </td>
                  <td>{token.decimals}</td>
                  <td className="asset-balance">
                    {session && balance !== undefined
                      ? formatUnits(balance, token.decimals)
                      : "—"}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Use ${token.symbol} ${token.address} as first pool token`}
                      onClick={() => onUseToken(token)}
                    >
                      Use as first token
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
