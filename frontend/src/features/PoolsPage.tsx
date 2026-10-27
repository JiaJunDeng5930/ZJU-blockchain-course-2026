import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDex } from "../chain/DexProvider";
import { poolLabel, shorten, tokenLabel } from "../chain/amounts";
import type { ExchangeClient } from "../chain/client";
import { formatUnits } from "../logic/units";
import { dispatchAssetEvent } from "../chain/assets";
import {
  AssetForms,
  assetEnvironment,
  assetPoolPrice,
  poolAssetsSupported,
  unsupportedPoolError,
  verifyDeployedAsset,
  type AssetEvent,
  type AssetFormsView,
} from "../logic/assets";
import type {
  AssetCreationConfirmation,
  Pool,
  Token,
  TokenCreationConfirmation,
} from "../chain/types";
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
  const cache = useQueryClient();
  const [created, setCreated] = useState<{
    clientKey: string;
    result: AssetCreationConfirmation;
  }>();
  const poolForm = useRef<HTMLFormElement>(null);
  const useToken = (token: Token) => {
    dispatch({ kind: "edit", field: "first", value: token.address });
    poolForm.current!.focus({ preventScroll: true });
    poolForm.current!.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const discoverCreatedToken = async (result: TokenCreationConfirmation) => {
    const query = createdTokenQuery(client, result);
    // Discovery has its own observable query error; it cannot undo a confirmed deployment.
    await cache.prefetchQuery(query);
    const token = cache.getQueryData<Token>(query.queryKey);
    if (token) registerToken(token);
  };
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
      {
        client,
        controller,
        environment,
        run,
        registerToken,
        onCreated: (result) => {
          setCreated({ clientKey: client.key, result });
          if (result.kind === "token") void discoverCreatedToken(result);
        },
      },
      event,
    );
  return (
    <>
      {created?.clientKey === client.key && (
        <ConfirmedCreation
          result={created.result}
          onUseToken={useToken}
          onReadToken={discoverCreatedToken}
          onProvideLiquidity={onProvideLiquidity}
        />
      )}
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
      <AvailableTokens onUseToken={useToken} />
      <WrapAssets />
    </>
  );
}
function createdTokenQuery(
  client: ExchangeClient,
  result: TokenCreationConfirmation,
) {
  return {
    queryKey: [
      "created-token",
      client.deployment.rpcUrl,
      client.key,
      result.address,
      result.receipt.transactionHash,
    ],
    queryFn: async () => {
      const token = await client.importToken(result.address);
      verifyDeployedAsset(result.name, result.symbol, token);
      return token;
    },
    staleTime: Infinity,
    retry: false,
  };
}

function ConfirmedCreation({
  result,
  onUseToken,
  onReadToken,
  onProvideLiquidity,
}: {
  result: AssetCreationConfirmation;
  onUseToken: (token: Token) => void;
  onReadToken: (result: TokenCreationConfirmation) => Promise<void>;
  onProvideLiquidity: (pool: Pool) => void;
}) {
  const { client } = useDex();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current!.focus({ preventScroll: true });
    panel.current!.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [result.receipt.transactionHash]);
  return (
    <section
      ref={panel}
      tabIndex={-1}
      className="card creation-result"
      aria-label="Confirmed creation"
    >
      <h2>Confirmed creation</h2>
      {result.kind === "token" ? (
        <CreatedToken
          result={result}
          onUseToken={onUseToken}
          onReadToken={onReadToken}
        />
      ) : (
        <CreatedPool result={result} onProvideLiquidity={onProvideLiquidity} />
      )}
      <dl className="creation-result-values">
        <dt>Created by</dt>
        <dd>
          <code>{result.receipt.from}</code>
        </dd>
        <dt>Chain</dt>
        <dd>{client.deployment.chainId}</dd>
        <dt>Confirmed block</dt>
        <dd>{result.receipt.blockNumber.toString()}</dd>
        <dt>Transaction</dt>
        <dd>
          <code>{result.receipt.transactionHash}</code>
        </dd>
      </dl>
    </section>
  );
}

function CreatedToken({
  result,
  onUseToken,
  onReadToken,
}: {
  result: TokenCreationConfirmation;
  onUseToken: (token: Token) => void;
  onReadToken: (result: TokenCreationConfirmation) => Promise<void>;
}) {
  const { client } = useDex();
  const metadata = useQuery({
    ...createdTokenQuery(client, result),
    enabled: false,
  });
  return (
    <>
      <p>
        ERC20 deployed: {result.name} ({result.symbol}).
      </p>
      <code className="creation-address">{result.address}</code>
      <p>
        New test tokens start with zero supply. Once metadata is read, claim
        test tokens in the wallet before providing liquidity.
      </p>
      {metadata.isFetching ? (
        <p role="status">Reading the created token's metadata…</p>
      ) : metadata.error ? (
        <p role="alert">
          Creation is confirmed. Metadata read failed: {metadata.error.message}
        </p>
      ) : metadata.data ? (
        <p>Verified token metadata · {metadata.data.decimals} decimals.</p>
      ) : (
        <p>Token metadata has not been read.</p>
      )}
      {metadata.data ? (
        <button type="button" onClick={() => onUseToken(metadata.data)}>
          Use as first token
        </button>
      ) : (
        <button
          type="button"
          disabled={metadata.isFetching}
          onClick={() => void onReadToken(result)}
        >
          Read token metadata
        </button>
      )}
    </>
  );
}

function CreatedPool({
  result,
  onProvideLiquidity,
}: {
  result: Extract<AssetCreationConfirmation, { kind: "pool" }>;
  onProvideLiquidity: (pool: Pool) => void;
}) {
  const { snapshot, symbol, tokens, session, pending } = useDex();
  const pool = snapshot.data?.pools.find(
    (candidate) =>
      candidate.id === result.poolId &&
      candidate.exchange.address.toLowerCase() ===
        result.exchange.address.toLowerCase(),
  );
  return (
    <>
      <p>
        {result.exchange.name} · pool #{result.poolId.toString()} created.
        Creating a pool does not deposit tokens.
      </p>
      <dl className="creation-result-values">
        <dt>Exchange</dt>
        <dd>
          <code>{result.exchange.address}</code>
        </dd>
        <dt>First asset</dt>
        <dd>
          {tokenLabel(result.token0, symbol(result.token0))}
          <code>{result.token0}</code>
        </dd>
        <dt>Second asset</dt>
        <dd>
          {tokenLabel(result.token1, symbol(result.token1))}
          <code>{result.token1}</code>
        </dd>
      </dl>
      {pool ? (
        <>
          <p>
            Pool state observed at block {snapshot.data!.block}. Add liquidity
            using this observed state.
          </p>
          <button
            type="button"
            disabled={pending || !session || !poolAssetsSupported(pool, tokens)}
            onClick={() => onProvideLiquidity(pool)}
          >
            Add liquidity to this pool
          </button>
        </>
      ) : (
        <>
          <p role="status">
            Creation is confirmed. Waiting to read this pool's state before
            preparing a deposit.
          </p>
          <button
            type="button"
            disabled={snapshot.isFetching}
            onClick={() => void snapshot.refetch()}
          >
            Read created pool
          </button>
        </>
      )}
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
              const balance = snapshot.data?.balances[token.address];
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
