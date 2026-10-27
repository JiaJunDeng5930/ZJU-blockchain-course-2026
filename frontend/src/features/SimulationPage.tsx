import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther } from "viem";
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
import { formatAmount, shorten } from "../chain/amounts";

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
  const { symbol, refresh } = useDex();
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
              }).view
            )
        );
    },
    [controller]
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
    <div>
      <section className="card">
        <h2>20-account market simulation</h2>
        <p>
          Let 20 funded test accounts trade and add or remove liquidity across
          Harbor and Summit. A separate arbitrageur checks both market
          directions and executes profitable routes atomically. These are real
          local-chain transactions.
        </p>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            setSelectedArbitrage(undefined);
            dispatch({ type: "start" });
          }}
        >
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
            Runs until both minimums are reached, then redeems its positions and
            verifies a deliberately unprofitable trade reverts. Do not submit
            manual trades during the run if you want reproducible results.
          </small>
          {invalidOptions && (
            <p role="alert">
              Use 20–1000 rounds, 0–600 seconds, 0–5000 ms interval, and a seed
              from 0 to 4294967295.
            </p>
          )}
          <div className="row">
            <button disabled={!view.canStart}>Start simulation</button>
            <button
              type="button"
              className="secondary"
              disabled={!view.canStop}
              onClick={() => dispatch({ type: "stop" })}
            >
              Stop simulation
            </button>
            {data?.reportAvailable && (
              <a
                href={`/api/simulation/report?jobId=${encodeURIComponent(
                  data.id ?? ""
                )}`}
                download
              >
                Download complete report
              </a>
            )}
          </div>
        </form>
        {view.error && <p role="alert">{view.error}</p>}
        {view.uncertain && (
          <p role="status">
            Refresh the service state before starting or stopping a simulation.
          </p>
        )}
        <button
          type="button"
          className="text"
          disabled={!view.canRefresh}
          onClick={() => dispatch({ type: "poll" })}
        >
          Refresh simulation status
        </button>
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
        {data?.error && <p role="alert">{data.error}</p>}
        {data?.state === "stopping" && (
          <p>
            Finishing the current transaction and redeeming positions created by
            this run. The stop result is not counted as a completed 20-account
            test.
          </p>
        )}
        {data?.state === "stopped" && (
          <p>
            The run was stopped safely. Confirmed transactions remain on chain;
            this is a partial run.
          </p>
        )}
      </section>
      {progress && (
        <>
          <div className="balances" aria-label="Simulation metrics">
            <div>
              <small>Active addresses</small>
              <strong>{progress.activeAccounts} / 20</strong>
            </div>
            <div>
              <small>Swaps</small>
              <strong>{progress.counts.swap}</strong>
            </div>
            <div>
              <small>Liquidity added / removed</small>
              <strong>
                {progress.counts.addLiquidity} /{" "}
                {progress.counts.removeLiquidity}
              </strong>
            </div>
            <div>
              <small>Profitable arbitrages</small>
              <strong>{progress.counts.arbitrage}</strong>
            </div>
            <div>
              <small>Transactions recorded</small>
              <strong>{progress.transactionCount}</strong>
            </div>
          </div>
          <div className="workspace">
            <section className="card">
              <h2>Markets</h2>
              <p>
                Prices are {symbol(progress.markets[0].token1)} per{" "}
                {symbol(progress.markets[0].token0)}. Both markets trade the
                same pair; their reserves and prices evolve independently.
              </p>
              <PriceHistory snapshots={progress.marketHistory} />
              <table>
                <thead>
                  <tr>
                    <th>Exchange</th>
                    <th>
                      Reserves {symbol(progress.markets[0].token0)} /{" "}
                      {symbol(progress.markets[0].token1)}
                    </th>
                    <th>Price</th>
                  </tr>
                </thead>
                <tbody>
                  {progress.markets.map((market) => (
                    <tr key={market.address}>
                      <td>{market.exchange}</td>
                      <td>
                        {formatAmount(BigInt(market.reserve0), 18)} /{" "}
                        {formatAmount(BigInt(market.reserve1), 18)}
                      </td>
                      <td>{market.priceToken1PerToken0.toFixed(6)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="card">
              <h2>Arbitrage profit</h2>
              <p>
                Realized profit, grouped by its capital token. ETH gas is
                separate, so amounts in different tokens are never added
                together.
              </p>
              <dl className="details">
                {progress.profits.map((profit) => (
                  <div key={profit.token}>
                    <dt>{profit.symbol}</dt>
                    <dd>{formatAmount(BigInt(profit.amount), 18, 8)}</dd>
                  </div>
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
                          {formatAmount(BigInt(item.profit), 18)}{" "}
                          {symbol(item.capitalToken)}
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
          <section className="card sources">
            <h2>Participating accounts</h2>
            <p>
              Counts include confirmed swaps, deposits, redemptions and
              arbitrages; ERC20 approvals do not count as market participation.
            </p>
            <div className="markets">
              {progress.accounts.map((account, index) => (
                <div key={account}>
                  <strong>Account {index + 1}</strong>
                  <small title={account}>{shorten(account)}</small>
                  <span>
                    {progress.accountOperations[account]} confirmed operations
                  </span>
                </div>
              ))}
            </div>
          </section>
          <section className="card sources">
            <h2>Latest confirmed activity</h2>
            <p>
              The latest 100 transactions appear here; download the report for
              every transaction and full before/after evidence.
            </p>
            <div className="table-scroll" style={{ maxHeight: 420 }}>
              <table>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Account</th>
                    <th>Block</th>
                    <th>Result</th>
                    <th>Transaction hash</th>
                  </tr>
                </thead>
                <tbody>
                  {[...progress.transactions].reverse().map((transaction) => (
                    <tr key={transaction.hash}>
                      <td>{actionLabels[transaction.action]}</td>
                      <td title={transaction.account}>
                        {shorten(transaction.account)}
                      </td>
                      <td>{transaction.blockNumber}</td>
                      <td>
                        {transaction.status === 1
                          ? "Confirmed"
                          : "Reverted as expected"}
                      </td>
                      <td>
                        <code>{transaction.hash}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      {data?.rollback && (
        <section className="card">
          <h2>Atomic rollback verification</h2>
          <p>
            A real transaction required an impossible profit and reverted with
            status {data.rollback.status}. Both pool reserves and the
            caller/contract token balances were compared before and after.
          </p>
          <strong>
            {data.rollback.reservesAndTokenBalancesUnchanged
              ? "Verified: reserves and token balances unchanged"
              : "Verification failed"}
          </strong>
          <p>
            <code>{data.rollback.hash}</code>
          </p>
          <p>The failed transaction still pays ETH gas.</p>
        </section>
      )}
    </div>
  );
}
function ArbitrageDetails({ item }: { item: SimulationArbitrage }) {
  const { symbol } = useDex();
  return (
    <div>
      <dl className="details">
        <dt>Capital</dt>
        <dd>
          {formatAmount(BigInt(item.amountIn), 18)} {symbol(item.capitalToken)}
        </dd>
        <dt>Realized token profit</dt>
        <dd>
          {formatAmount(BigInt(item.profit), 18, 8)} {symbol(item.capitalToken)}
        </dd>
        <dt>ETH gas cost</dt>
        <dd>{formatEther(BigInt(item.gasCostWei))}</dd>
      </dl>
      <code>{item.hash}</code>
      <table>
        <thead>
          <tr>
            <th>Exchange</th>
            <th>Price before / after</th>
            <th>Reserves before / after</th>
          </tr>
        </thead>
        <tbody>
          {item.before.map((before) => {
            const after = item.after.find(
              (market) => market.address === before.address
            )!;
            return (
              <tr key={before.address}>
                <td>{before.exchange}</td>
                <td>
                  {before.priceToken1PerToken0.toFixed(6)}
                  <br />
                  {after.priceToken1PerToken0.toFixed(6)}
                </td>
                <td>
                  {formatAmount(BigInt(before.reserve0), 18)} /{" "}
                  {formatAmount(BigInt(before.reserve1), 18)}
                  <br />
                  {formatAmount(BigInt(after.reserve0), 18)} /{" "}
                  {formatAmount(BigInt(after.reserve1), 18)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
function PriceHistory({ snapshots }: { snapshots: MarketSnapshot[][] }) {
  if (snapshots.length < 2)
    return <p>Waiting for a second market update to draw the price history…</p>;
  const values = snapshots.flatMap((markets) =>
    markets.map((market) => market.priceToken1PerToken0)
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
                  }`
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
            {market.exchange}
          </span>
        ))}{" "}
        · latest {snapshots.length} observed updates
      </figcaption>
    </figure>
  );
}
