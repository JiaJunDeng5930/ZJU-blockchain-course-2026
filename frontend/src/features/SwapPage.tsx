import { useReducer, useState } from "react";
import { tokenLabel } from "../chain/amounts";
import { formatUnits } from "../logic/units";
import {
  createRoutedSwapController,
  type RoutedSwapEvent,
} from "../logic/routing";
import { useDex } from "../chain/DexProvider";
import type { Pool } from "../chain/types";
import "./SwapPage.css";

type SwapPageProps = {
  pool: Pool;
  onPoolChange: (key: string) => void;
  onOpenWallet: () => void;
};

export function SwapPage({ pool, onPoolChange, onOpenWallet }: SwapPageProps) {
  const {
    client,
    snapshot,
    symbol,
    session,
    pending,
    run,
    amount,
    precision,
    tokens,
  } = useDex();
  const [controller] = useState(() => createRoutedSwapController(pool.token0));
  const [, render] = useReducer((value: boolean) => !value, false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const context = {
    tokens,
    pool,
    pools: snapshot.data?.pools ?? [],
    exchanges: client.deployment.exchanges,
    block: snapshot.data?.block,
    balances: snapshot.data?.balances,
    connected: !!session,
    pending,
  };
  const view = controller.view(context);
  const { inputToken, outputToken, balance, outputBalance } = view;
  function dispatch(event: RoutedSwapEvent) {
    const { effect } = controller.dispatch(event, context);
    render();
    if (effect?.kind === "wallet") onOpenWallet();
    if (effect?.kind === "swap") {
      run(`Swap on ${effect.pool.exchange.name} #${effect.pool.id}`, (writer) =>
        writer.routedSwap(effect)
      );
    }
  }

  return (
    <div className="trade-layout">
      <form
        className="trade-card"
        aria-label="Swap tokens"
        onSubmit={(event) => {
          event.preventDefault();
          dispatch({ kind: "submit" });
        }}
      >
        <div className="trade-heading">
          <h1 id="trade-title">Swap</h1>
          <button
            className="trade-settings-button"
            type="button"
            aria-expanded={settingsOpen}
            aria-controls="trade-settings"
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            Settings
          </button>
        </div>

        <div className="trade-market">
          <select
            id="trade-market"
            aria-label="Trading pair"
            value={view.pairKey ?? ""}
            disabled={pending}
            onChange={(event) => onPoolChange(event.target.value)}
          >
            {view.pairKey === null && <option value="">Select a pair</option>}
            {view.pairs.map((pair) => (
              <option
                key={pair.key}
                value={pair.key}
                title={`${pair.token0} / ${pair.token1}`}
              >
                {tokenLabel(pair.token0, symbol(pair.token0))} /{" "}
                {tokenLabel(pair.token1, symbol(pair.token1))}
              </option>
            ))}
          </select>
          <select
            aria-label="Exchange"
            value={view.mode === "auto" ? "auto" : view.manualKey ?? ""}
            disabled={pending}
            onChange={(event) =>
              dispatch({ kind: "route", value: event.target.value })
            }
          >
            <option value="auto">Best quote</option>
            {view.manualUnavailable && (
              <option value={view.manualKey ?? ""}>Unavailable pool</option>
            )}
            {view.routes.map((route) => (
              <option key={route.key} value={route.key}>
                {route.pool.exchange.name} #{String(route.pool.id)}
                {route.quoted === undefined
                  ? " · No quote"
                  : ` · ${amount(route.quoted, view.outputToken)} ${symbol(
                      view.outputToken
                    )}`}
              </option>
            ))}
          </select>
        </div>

        {settingsOpen && (
          <section id="trade-settings" className="trade-settings">
            <label htmlFor="trade-slippage">Slippage tolerance</label>
            <div className="trade-slippage-controls">
              {["0.1", "0.5", "1"].map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={view.slippageText === value}
                  onClick={() => dispatch({ kind: "slippage", value })}
                >
                  {value}%
                </button>
              ))}
              <div className="trade-custom-slippage">
                <input
                  id="trade-slippage"
                  aria-label="Slippage"
                  inputMode="decimal"
                  value={view.slippageText}
                  onChange={(event) =>
                    dispatch({ kind: "slippage", value: event.target.value })
                  }
                />
                <span>%</span>
              </div>
            </div>
          </section>
        )}

        <section className="trade-amount-box" aria-label="Sell amount">
          <div className="trade-amount-label">
            <label htmlFor="trade-amount">Sell</label>
            <span>
              Balance:{" "}
              {balance === undefined ? "—" : amount(balance, inputToken)}
              {view.showMax && (
                <button
                  type="button"
                  className="trade-max"
                  disabled={pending}
                  onClick={() => dispatch({ kind: "max" })}
                >
                  Max
                </button>
              )}
            </span>
          </div>
          <div className="trade-amount-row">
            <input
              id="trade-amount"
              aria-label="Swap amount"
              placeholder="0"
              inputMode="decimal"
              autoComplete="off"
              value={view.amountText}
              disabled={pending}
              onChange={(event) =>
                dispatch({ kind: "amount", value: event.target.value })
              }
            />
            <TokenSelector
              label="Pay token"
              value={inputToken}
              addresses={[pool.token0, pool.token1]}
              disabled={pending}
              onChange={(value) => dispatch({ kind: "pay", value })}
            />
          </div>
        </section>

        <div className="trade-direction-row">
          <button
            type="button"
            className="trade-direction"
            aria-label="Reverse swap direction"
            disabled={pending}
            onClick={() => dispatch({ kind: "reverse" })}
          >
            ↓
          </button>
        </div>

        <section className="trade-amount-box" aria-label="Buy amount">
          <div className="trade-amount-label">
            <span>Buy</span>
            <span>
              Balance:{" "}
              {outputBalance === undefined
                ? "—"
                : amount(outputBalance, outputToken)}
            </span>
          </div>
          <div className="trade-amount-row">
            <output
              className="trade-output"
              aria-label="Estimated receive"
              title={
                view.output === undefined
                  ? undefined
                  : formatUnits(view.output, precision(outputToken))
              }
            >
              {view.output === undefined
                ? view.hasAmount
                  ? "—"
                  : "0"
                : amount(view.output, outputToken, 6)}
            </output>
            <TokenSelector
              label="Receive token"
              value={outputToken}
              addresses={[pool.token0, pool.token1]}
              disabled={pending}
              onChange={(value) => dispatch({ kind: "receive", value })}
            />
          </div>
        </section>

        {view.message && (
          <p className="trade-error" role="alert">
            {view.message}
          </p>
        )}
        {!view.message && view.highImpact && (
          <p className="trade-impact-note" role="alert">
            Price impact is {view.impactText}%. Review the received amount.
          </p>
        )}
        {!view.funded && (
          <p className="trade-error" role="alert">
            This pool has no liquidity yet. Add liquidity before trading.
          </p>
        )}

        <button className="trade-submit" type="submit" disabled={view.disabled}>
          {view.actionLabel}
        </button>

        {view.amount !== undefined && (
          <div className="trade-summary">
            {view.route && (
              <span>
                {view.route.exchange.name} #{String(view.route.id)}
              </span>
            )}
            <span>{view.feePercent}% pool fee</span>
            <span>Slippage {view.slippageText}%</span>
          </div>
        )}
        {view.output !== undefined && (
          <details className="trade-details">
            <summary>
              <span>
                1 {symbol(inputToken)} ≈ {view.rateText} {symbol(outputToken)}
              </span>
              <span>Trade details</span>
            </summary>
            <dl>
              <dt>Exchange</dt>
              <dd>
                {view.route?.exchange.name} #{String(view.route?.id)}
              </dd>
              <dt>Quote block</dt>
              <dd>{view.block}</dd>
              <dt>Minimum received</dt>
              <dd>
                {view.minimum === undefined
                  ? "—"
                  : `${amount(view.minimum, outputToken, 6)} ${symbol(
                      outputToken
                    )}`}
              </dd>
              <dt>Price impact, including fee</dt>
              <dd
                className={view.highImpact ? "trade-impact-warning" : undefined}
              >
                {view.impactText === null ? "—" : `${view.impactText}%`}
              </dd>
              <dt>Liquidity provider fee</dt>
              <dd>
                {view.fee === undefined
                  ? "—"
                  : `${amount(view.fee, inputToken, 6)} ${symbol(inputToken)}`}
              </dd>
              <dt>Deadline</dt>
              <dd>{view.deadlineText}</dd>
            </dl>
            <p>
              Best quote compares direct pools in this deployment after pool
              fees. Network gas is separate.
            </p>
            <p>
              Token approval may require a separate confirmation before the
              swap. Gas is paid in ETH.
            </p>
          </details>
        )}
      </form>
    </div>
  );
}

function TokenSelector({
  label,
  value,
  addresses,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  addresses: string[];
  disabled: boolean;
  onChange: (address: string) => void;
}) {
  const { symbol } = useDex();
  return (
    <div className="trade-token-selector">
      <select
        aria-label={label}
        title={value}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {addresses.map((address) => (
          <option key={address} value={address} title={address}>
            {tokenLabel(address, symbol(address))}
          </option>
        ))}
      </select>
    </div>
  );
}
