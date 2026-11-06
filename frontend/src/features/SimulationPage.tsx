import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type {
  SimulationAction,
  SimulationJob,
  MarketSnapshot,
  SimulationArbitrage,
} from "../../../contracts/scripts/simulation-protocol";
import {
  SimulationController,
  performSimulation,
  type SimulationEvent,
} from "../logic/simulation";
import { useDex } from "../chain/DexProvider";
import {
  formatPrice,
  shorten,
  tokenDecimals,
  tokenLabel,
} from "../chain/amounts";
import { formatUnits } from "../logic/units";
import "./SimulationPage.css";

const actionLabels: Record<SimulationAction, string> = {
  swap: "Swap",
  addLiquidity: "Added liquidity",
  removeLiquidity: "Redeemed position",
  arbitrage: "Atomic arbitrage",
  approve: "Token approval",
  expectedArbitrageRevert: "Rollback verification",
};
const phaseLabels = {
  preparing: "preparing a price difference",
  trading: "random user activity",
  redeeming: "redeeming simulated positions",
  verifying: "checking atomic rollback",
};
const stateLabels: Record<SimulationJob["state"], string> = {
  idle: "Ready",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping after safe cleanup",
  completed: "Completed",
  stopped: "Stopped by user",
  failed: "Failed",
};
export function SimulationPage() {
  const { client, symbol, refresh, tokens } = useDex();
  const asset = (address: string) => tokenLabel(address, symbol(address));
  const amount = (value: string, address: string) =>
    formatUnits(BigInt(value), tokenDecimals(tokens, address));
  const [controller] = useState(() => new SimulationController());
  const [view, setView] = useState(() => controller.view());
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  const [selectedArbitrage, setSelectedArbitrage] = useState<string>();
  const dispatch = useCallback(
    (event: SimulationEvent) => {
      const transition = controller.dispatch(event);
      setView(transition.view);
      const effect = transition.effect;
      if (effect)
        void performSimulation(effect).then(
          (data) => {
            const result = controller.dispatch({
              type: "success",
              requestId: effect.requestId,
              data,
            });
            setView(result.view);
            if (result.refreshAssets) void refreshRef.current();
          },
          (error: unknown) =>
            setView(
              controller.dispatch({
                type: "failure",
                requestId: effect.requestId,
                error: error instanceof Error ? error.message : String(error),
              }).view,
            ),
        );
    },
    [controller],
  );
  useEffect(() => {
    dispatch({ type: "poll" });
    const timer = window.setInterval(() => dispatch({ type: "poll" }), 1000);
    return () => window.clearInterval(timer);
  }, [dispatch]);
  const { data, busy, invalidOptions, draft } = view;
  const { rounds, seed, duration, interval } = draft;
  const progress = data?.progress;
  const currentArbitrage =
    progress?.arbitrages.find((item) => item.hash === selectedArbitrage) ??
    progress?.arbitrages.at(-1);
  return (
    <div className="simulation-page">
      <section className="card">
        <h2>20-account market simulation</h2>
        {data && (
          <p role="status" aria-label="Simulation status">
            {stateLabels[data.state]}
            {progress
              ? ` · ${view.active ? phaseLabels[progress.phase] + " · " : ""}${
                  progress.completedRounds
                } rounds · ${progress.elapsedSeconds.toFixed(1)} seconds`
              : ""}
          </p>
        )}
        {progress && (
          <dl className="simulation-metrics" aria-label="Simulation metrics">
            <div>
              <dt>Active addresses</dt>
              <dd>{progress.activeAccounts} / 20</dd>
            </div>
            <div>
              <dt>Swaps</dt>
              <dd>{progress.counts.swap}</dd>
            </div>
            <div>
              <dt>Liquidity added / removed</dt>
              <dd>
                {progress.counts.addLiquidity} /{" "}
                {progress.counts.removeLiquidity}
              </dd>
            </div>
            <div>
              <dt>Atomic arbitrages</dt>
              <dd>{progress.counts.arbitrage}</dd>
            </div>
          </dl>
        )}
        {!progress && (
          <p>
            20 funded accounts trade and manage liquidity on Harbor and Summit.
          </p>
        )}
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            setSelectedArbitrage(undefined);
            dispatch({ type: "start" });
          }}
        >
          <details className="simulation-settings" open={!progress}>
            <summary>Run settings</summary>
            <div className="markets">
              <label>
                Minimum rounds
                <input
                  aria-label="Simulation rounds"
                  type="number"
                  min="20"
                  max="1000"
                  step="1"
                  value={rounds}
                  disabled={busy}
                  onChange={(event) =>
                    dispatch({
                      type: "edit",
                      draft: { ...draft, rounds: event.target.value },
                    })
                  }
                />
              </label>
              <label>
                Minimum duration (seconds)
                <input
                  aria-label="Simulation duration"
                  type="number"
                  min="0"
                  max="600"
                  step="1"
                  value={duration}
                  disabled={busy}
                  onChange={(event) =>
                    dispatch({
                      type: "edit",
                      draft: { ...draft, duration: event.target.value },
                    })
                  }
                />
              </label>
              <label>
                Interval between rounds (ms)
                <input
                  aria-label="Simulation interval"
                  type="number"
                  min="0"
                  max="5000"
                  step="1"
                  value={interval}
                  disabled={busy}
                  onChange={(event) =>
                    dispatch({
                      type: "edit",
                      draft: { ...draft, interval: event.target.value },
                    })
                  }
                />
              </label>
              <label>
                Random seed
                <input
                  aria-label="Simulation seed"
                  type="number"
                  min="0"
                  max="4294967295"
                  step="1"
                  value={seed}
                  disabled={busy}
                  onChange={(event) =>
                    dispatch({
                      type: "edit",
                      draft: { ...draft, seed: event.target.value },
                    })
                  }
                />
              </label>
            </div>
            <small>
              Both minimums must be reached before cleanup and rollback
              verification. Leave manual trading paused during the run.
            </small>
            <details className="simulation-funding">
              <summary>Funding requirements</summary>
              <p>
                Uses existing balances, without top-ups. All accounts need ETH
                for gas; Account 2 needs 1000{" "}
                {asset(client.deployment.tokens[0].address)} and Account 20
                needs at least one unit of either market token.
              </p>
            </details>
            {invalidOptions && (
              <p role="alert">
                Use 20–1000 rounds, 0–600 seconds, 0–5000 ms interval, and a
                seed from 0 to 4294967295.
              </p>
            )}
            <div className="row">
              <button disabled={!view.canStart}>Start simulation</button>
            </div>
          </details>
          {view.active && (
            <button
              type="button"
              className="secondary"
              disabled={!view.canStop}
              onClick={() => dispatch({ type: "stop" })}
            >
              Stop simulation
            </button>
          )}
        </form>
        {view.error && <p role="alert">{view.error}</p>}
        {view.uncertain && (
          <p role="status">
            Refresh the service state before starting or stopping a simulation.
          </p>
        )}
        {(view.uncertain || view.error || data?.error) && (
          <button
            type="button"
            className="text"
            disabled={!view.canRefresh}
            onClick={() => dispatch({ type: "poll" })}
          >
            Refresh simulation status
          </button>
        )}
        {data?.error && <p role="alert">{data.error}</p>}
        {data?.state === "stopping" && (
          <p>
            Finishing the current transaction and redeeming this run's
            positions.
          </p>
        )}
        {data?.state === "stopped" && (
          <p>
            Stopped safely. This is a partial run; confirmed transactions remain
            on chain.
          </p>
        )}
        {data?.state === "failed" && (
          <p>
            Confirmed transactions remain on chain; final cleanup was not
            reported. Download the journal and inspect the listed NFTs in
            Liquidity using their wallet accounts. Missing confirmation
            responses may require checking the chain too.
          </p>
        )}
      </section>
      {progress && (
        <>
          <div className="workspace">
            <section className="card">
              <h2>Markets</h2>
              <p>
                {symbol(progress.markets[0].token1)} per{" "}
                {symbol(progress.markets[0].token0)}
              </p>
              <PriceHistory snapshots={progress.marketHistory} />
              <div className="table-scroll">
                <table className="simulation-amounts">
                  <thead>
                    <tr>
                      <th>Exchange</th>
                      <th>Reserve {symbol(progress.markets[0].token0)}</th>
                      <th>Reserve {symbol(progress.markets[0].token1)}</th>
                      <th>
                        {symbol(progress.markets[0].token1)} per{" "}
                        {symbol(progress.markets[0].token0)}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {progress.markets.map((market) => (
                      <tr key={market.address}>
                        <td title={market.address}>
                          {market.exchange} #{market.poolId} ·{" "}
                          {shorten(market.address)}
                        </td>
                        <td>{amount(market.reserve0, market.token0)}</td>
                        <td>{amount(market.reserve1, market.token1)}</td>
                        <td>
                          {formatPrice(
                            BigInt(market.reserve1),
                            tokenDecimals(tokens, market.token1),
                            BigInt(market.reserve0),
                            tokenDecimals(tokens, market.token0),
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="card">
              <h2>Arbitrage profit</h2>
              <p>Realized token profit, excluding ETH gas.</p>
              <dl className="details">
                {progress.profits.map((profit) => (
                  <Fragment key={profit.token}>
                    <dt title={profit.token}>
                      {tokenLabel(profit.token, profit.symbol)}
                    </dt>
                    <dd>{amount(profit.amount, profit.token)}</dd>
                  </Fragment>
                ))}
              </dl>
              {progress.arbitrages.length === 0 ? (
                <p>No profitable route executed yet.</p>
              ) : (
                <>
                  <label>
                    Inspect an executed arbitrage
                    <select
                      aria-label="Executed arbitrage"
                      value={currentArbitrage?.hash ?? ""}
                      onChange={(event) =>
                        setSelectedArbitrage(event.target.value)
                      }
                    >
                      {[...progress.arbitrages].reverse().map((item) => (
                        <option key={item.hash} value={item.hash}>
                          {item.buyExchange} → {item.sellExchange} · +
                          {amount(item.profit, item.capitalToken)}{" "}
                          {symbol(item.capitalToken)} · {shorten(item.hash)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {currentArbitrage && (
                    <ArbitrageDetails item={currentArbitrage} />
                  )}
                </>
              )}
            </section>
          </div>
          <details className="card sources simulation-records">
            <summary>
              <h2>Participating accounts</h2>
            </summary>
            <p>Confirmed market operations; token approvals are excluded.</p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Confirmed market operations</th>
                  </tr>
                </thead>
                <tbody>
                  {progress.accounts.map((account, index) => (
                    <tr key={account}>
                      <td title={account}>
                        Account {index + 1} · {shorten(account)}
                      </td>
                      <td>
                        {progress.accountOperations[account]} confirmed
                        operations
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <details className="card sources simulation-records">
            <summary>
              <h2>Latest confirmed activity</h2>
            </summary>
            <p>
              Latest 100 receipts. The transaction journal contains the full
              run.
            </p>
            <div
              className="table-scroll simulation-evidence-scroll"
              role="region"
              aria-label="Latest confirmed transaction records"
              tabIndex={0}
            >
              <table className="simulation-activity-table">
                <thead>
                  <tr>
                    <th scope="col">Action</th>
                    <th scope="col">Account</th>
                    <th scope="col" className="simulation-record-id">
                      Block
                    </th>
                    <th scope="col">Result</th>
                    <th scope="col">Transaction hash</th>
                  </tr>
                </thead>
                <tbody>
                  {[...progress.transactions].reverse().map((transaction) => (
                    <tr key={transaction.hash}>
                      <td>{actionLabels[transaction.action]}</td>
                      <td title={transaction.account}>
                        {shorten(transaction.account)}
                      </td>
                      <td className="simulation-record-id">
                        {transaction.blockNumber}
                      </td>
                      <td>
                        {transaction.status === 1
                          ? "Confirmed"
                          : transaction.action === "expectedArbitrageRevert"
                            ? "Reverted as expected"
                            : "Reverted"}
                      </td>
                      <td>
                        <code>{transaction.hash}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      {data?.rollback && (
        <section className="card">
          <h2>Atomic rollback verification</h2>
          <p>
            Receipt status: {data.rollback.status} · minimum profit was not met.
          </p>
          <strong>
            {data.rollback.reservesAndTokenBalancesUnchanged
              ? "Verified: reserves and token balances unchanged"
              : "Verification failed"}
          </strong>
          <details>
            <summary>Transaction details</summary>
            <p>
              <code>{data.rollback.hash}</code>
            </p>
            <p>The failed transaction still pays ETH gas.</p>
          </details>
        </section>
      )}
      {data?.journal && data.journal.positions.length > 0 && (
        <details
          key={data.id}
          className="card sources simulation-position-records"
        >
          <summary>
            Positions created by this run · {data.journal.positions.length}
          </summary>
          <p>
            NFTs minted by this run. Use Liquidity to check current ownership or
            complete a redemption.
          </p>
          <div
            className="table-scroll simulation-evidence-scroll"
            role="region"
            aria-label="NFT mint and redemption records"
            tabIndex={0}
          >
            <table className="simulation-position-table">
              <thead>
                <tr>
                  <th scope="col">DEX / pool</th>
                  <th scope="col" className="simulation-record-id">
                    NFT
                  </th>
                  <th scope="col">Minted for</th>
                  <th scope="col">Mint transaction</th>
                  <th scope="col">Redemption in this run</th>
                </tr>
              </thead>
              <tbody>
                {data.journal.positions.map((position) => (
                  <tr key={`${position.exchange}:${position.positionId}`}>
                    <td>
                      <code>{position.exchange}</code> / #{position.poolId}
                    </td>
                    <td className="simulation-record-id">
                      #{position.positionId}
                    </td>
                    <td>
                      <code>{position.account}</code>
                    </td>
                    <td>
                      <code>{position.mintHash}</code>
                    </td>
                    <td>
                      {position.redeemHash ? (
                        <code>{position.redeemHash}</code>
                      ) : (
                        "No redemption recorded"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {data?.id && data.options && (
        <details className="card simulation-run-details">
          <summary>Run details and exports</summary>
          <dl className="details simulation-run">
            <dt>Run ID</dt>
            <dd>
              <code>{data.id}</code>
            </dd>
            <dt>Settings used</dt>
            <dd>
              Seed {data.options.seed} · minimum {data.options.rounds} rounds
              and {data.options.durationSeconds} seconds ·{" "}
              {data.options.intervalMs} ms interval
            </dd>
            {progress && (
              <>
                <dt>Started</dt>
                <dd>
                  <time dateTime={progress.startedAt}>
                    {progress.startedAt}
                  </time>
                </dd>
              </>
            )}
            {data.finishedAt && (
              <>
                <dt>Finished</dt>
                <dd>
                  <time dateTime={data.finishedAt}>{data.finishedAt}</time>
                </dd>
              </>
            )}
            {progress && (
              <>
                <dt>Transaction receipts</dt>
                <dd>{progress.transactionCount}</dd>
              </>
            )}
          </dl>{" "}
          <div className="row">
            {data?.reportAvailable && (
              <a
                href={`/api/simulation/report?jobId=${encodeURIComponent(
                  data.id ?? "",
                )}`}
                download
              >
                Download run report
              </a>
            )}
            {data?.id && data.journal && (
              <a
                href={`/api/simulation/journal?jobId=${encodeURIComponent(data.id)}`}
                download
              >
                Download transaction journal
              </a>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
function ArbitrageDetails({ item }: { item: SimulationArbitrage }) {
  const { symbol, tokens } = useDex();
  const asset = (address: string) => tokenLabel(address, symbol(address));
  const amount = (value: string, address: string) =>
    formatUnits(BigInt(value), tokenDecimals(tokens, address));
  return (
    <div className="simulation-execution">
      <dl className="details">
        <dt title={item.capitalToken}>Capital · {asset(item.capitalToken)}</dt>
        <dd>{amount(item.amountIn, item.capitalToken)}</dd>
        <dt>Realized token profit</dt>
        <dd>
          {amount(item.profit, item.capitalToken)} {symbol(item.capitalToken)}
        </dd>
      </dl>
      <details>
        <summary>Transaction details</summary>
        <dl className="details">
          <dt>Quoted token profit</dt>
          <dd>
            {amount(item.expectedProfit, item.capitalToken)}{" "}
            {asset(item.capitalToken)}
          </dd>
          <dt>Execution fee</dt>
          <dd>{formatUnits(BigInt(item.gasCostWei), 18)} ETH</dd>
          <dt>Transaction</dt>
          <dd>
            <code>{item.hash}</code>
          </dd>
        </dl>
      </details>
      <div className="table-scroll">
        <table className="simulation-amounts">
          <thead>
            <tr>
              <th>Pool</th>
              <th>State</th>
              <th>Reserve {symbol(item.before[0].token0)}</th>
              <th>Reserve {symbol(item.before[0].token1)}</th>
              <th>
                {symbol(item.before[0].token1)} per{" "}
                {symbol(item.before[0].token0)}
              </th>
            </tr>
          </thead>
          <tbody>
            {item.before.map((before) => {
              const after = item.after.find(
                (market) => market.address === before.address,
              )!;
              return (
                [
                  ["Before", before],
                  ["After", after],
                ] as const
              ).map(([state, market]) => (
                <tr key={`${market.address}:${state}`}>
                  <td title={market.address}>
                    {market.exchange} #{market.poolId}
                  </td>
                  <td>{state}</td>
                  <td>{amount(market.reserve0, market.token0)}</td>
                  <td>{amount(market.reserve1, market.token1)}</td>
                  <td>
                    {formatPrice(
                      BigInt(market.reserve1),
                      tokenDecimals(tokens, market.token1),
                      BigInt(market.reserve0),
                      tokenDecimals(tokens, market.token0),
                    )}
                  </td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function PriceHistory({ snapshots }: { snapshots: MarketSnapshot[][] }) {
  if (snapshots.length < 2)
    return <p>Waiting for a second market update to draw the price history…</p>;
  const values = snapshots.flatMap((markets) =>
    markets.map((market) => market.priceToken1PerToken0),
  );
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = maximum - minimum || 1;
  const colors = ["#246448", "#8d5f31"];
  return (
    <figure style={{ margin: "20px 0" }}>
      <svg
        role="img"
        aria-label="Price history for the two exchanges"
        viewBox="0 0 500 170"
        width="100%"
      >
        <line x1="35" y1="145" x2="490" y2="145" stroke="#ccd6cc" />
        <text x="0" y="20" fontSize="10" fill="#597064">
          {maximum.toFixed(3)}
        </text>
        <text x="0" y="145" fontSize="10" fill="#597064">
          {minimum.toFixed(3)}
        </text>
        {snapshots[0].map((market, index) => (
          <polyline
            key={market.address}
            fill="none"
            stroke={colors[index]}
            strokeWidth="2"
            points={snapshots
              .map(
                (markets, step) =>
                  `${35 + (step * 455) / (snapshots.length - 1)},${
                    145 -
                    ((markets[index].priceToken1PerToken0 - minimum) / range) *
                      125
                  }`,
              )
              .join(" ")}
          />
        ))}
      </svg>
      <figcaption>
        {snapshots[0].map((market, index) => (
          <span
            key={market.address}
            style={{ color: colors[index], marginRight: 20 }}
          >
            {market.exchange} #{market.poolId}
          </span>
        ))}{" "}
        · latest {snapshots.length} observed updates, oldest to newest. Chart
        prices are rounded; updates are not evenly spaced in time.
      </figcaption>
    </figure>
  );
}
