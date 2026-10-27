import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "ethers";
import {
  formatAmount,
  minimumReceived,
  poolKey,
  positiveAmount,
  sameAddress,
  slippageBps,
} from "../chain/amounts";
import { useDex } from "../chain/DexProvider";
import type { Pool } from "../chain/types";
import { amountError, toleranceError } from "../components/Forms";
import "./SwapPage.css";

type SwapPageProps = {
  pool: Pool;
  onPoolChange: (key: string) => void;
  onOpenWallet: () => void;
};

export function SwapPage({ pool, onPoolChange, onOpenWallet }: SwapPageProps) {
  const { client, snapshot, symbol, session, pending, run } = useDex();
  const [inputToken, setInputToken] = useState(pool.token0);
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const outputToken = sameAddress(inputToken, pool.token0)
    ? pool.token1
    : pool.token0;
  const balance = session ? snapshot.data?.balances[inputToken] : undefined;
  const outputBalance = session
    ? snapshot.data?.balances[outputToken]
    : undefined;
  const hasAmount = amount.trim() !== "";
  const numericError = amountError(amount);
  const balanceError = amountError(amount, balance);
  const slippageError = toleranceError(slippage);
  const amountIn = numericError ? undefined : positiveAmount(amount);
  const funded = pool.reserve0 > 0n && pool.reserve1 > 0n;
  const quote = useQuery({
    queryKey: [
      "quote",
      client.key,
      poolKey(pool),
      inputToken,
      amount,
      snapshot.data?.block,
    ],
    queryFn: () => client.quote(pool, inputToken, amountIn!),
    enabled: amountIn !== undefined && funded,
  });
  const reserveIn = sameAddress(inputToken, pool.token0)
    ? pool.reserve0
    : pool.reserve1;
  const reserveOut = sameAddress(inputToken, pool.token0)
    ? pool.reserve1
    : pool.reserve0;
  const impact =
    amountIn && quote.data
      ? Math.max(
          0,
          (1 -
            (Number(quote.data) * Number(reserveIn)) /
              (Number(amountIn) * Number(reserveOut))) *
            100,
        )
      : undefined;
  const executionRate =
    quote.data !== undefined && amountIn
      ? Number(quote.data) / Number(amountIn)
      : undefined;
  const minimum =
    quote.data !== undefined && !slippageError
      ? minimumReceived(quote.data, slippageBps(slippage))
      : undefined;
  const canSwap =
    !!session &&
    !pending &&
    !balanceError &&
    !slippageError &&
    !!quote.data &&
    !quote.isFetching &&
    funded;
  const message = hasAmount
    ? (balanceError ?? slippageError ?? quote.error?.message)
    : slippageError;

  function reverseDirection() {
    if (quote.data && !numericError) setAmount(formatUnits(quote.data, 18));
    setInputToken(outputToken);
  }
  function actionLabel() {
    if (!session) return "Connect wallet";
    if (pending) return "Waiting for confirmation…";
    if (!funded) return "Pool needs liquidity";
    if (!hasAmount) return "Enter amount";
    if (numericError) return "Check amount";
    if (balanceError) return "Insufficient balance";
    if (slippageError) return "Check slippage";
    if (quote.isFetching) return "Getting quote…";
    if (!quote.data) return "Quote unavailable";
    return "Swap";
  }

  return (
    <div className="trade-layout">
      <form
        className="trade-card"
        aria-label="Swap tokens"
        onSubmit={(event) => {
          event.preventDefault();
          if (!session) {
            onOpenWallet();
            return;
          }
          if (canSwap && amountIn && quote.data) {
            run("Swap tokens", (writer) =>
              writer.swap(
                pool,
                inputToken,
                amountIn,
                quote.data!,
                slippageBps(slippage),
              ),
            );
          }
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
            aria-label="Active pool"
            value={poolKey(pool)}
            disabled={pending}
            onChange={(event) => onPoolChange(event.target.value)}
          >
            {snapshot.data?.pools.map((market) => (
              <option key={poolKey(market)} value={poolKey(market)}>
                {market.exchange.name} · {symbol(market.token0)}/
                {symbol(market.token1)}
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
                  aria-pressed={slippage === value}
                  onClick={() => setSlippage(value)}
                >
                  {value}%
                </button>
              ))}
              <div className="trade-custom-slippage">
                <input
                  id="trade-slippage"
                  aria-label="Slippage"
                  inputMode="decimal"
                  value={slippage}
                  onChange={(event) => setSlippage(event.target.value)}
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
              Balance: {balance === undefined ? "—" : formatAmount(balance)}
              {balance !== undefined && balance > 0n && (
                <button
                  type="button"
                  className="trade-max"
                  disabled={pending}
                  onClick={() => setAmount(formatUnits(balance, 18))}
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
              value={amount}
              disabled={pending}
              onChange={(event) => setAmount(event.target.value)}
            />
            <TokenSelector
              label="Pay token"
              value={inputToken}
              addresses={[pool.token0, pool.token1]}
              disabled={pending}
              onChange={setInputToken}
            />
          </div>
        </section>

        <div className="trade-direction-row">
          <button
            type="button"
            className="trade-direction"
            aria-label="Reverse swap direction"
            disabled={pending}
            onClick={reverseDirection}
          >
            ↓
          </button>
        </div>

        <section className="trade-amount-box" aria-label="Buy amount">
          <div className="trade-amount-label">
            <span>Buy</span>
            <span>
              Balance:{" "}
              {outputBalance === undefined ? "—" : formatAmount(outputBalance)}
            </span>
          </div>
          <div className="trade-amount-row">
            <output
              className="trade-output"
              aria-label="Estimated receive"
              title={quote.data ? formatUnits(quote.data, 18) : undefined}
            >
              {!hasAmount || numericError
                ? "0"
                : quote.isFetching
                  ? "…"
                  : quote.data !== undefined
                    ? formatAmount(quote.data, 6)
                    : "—"}
            </output>
            <TokenSelector
              label="Receive token"
              value={outputToken}
              addresses={[pool.token0, pool.token1]}
              disabled={pending}
              onChange={(address) => {
                setInputToken(
                  sameAddress(address, pool.token0) ? pool.token1 : pool.token0,
                );
              }}
            />
          </div>
        </section>

        {message && (
          <p className="trade-error" role="alert">
            {message}
          </p>
        )}
        {!message && impact !== undefined && impact >= 5 && (
          <p className="trade-impact-note" role="alert">
            Price impact is {impact.toFixed(2)}%. Review the received amount.
          </p>
        )}
        {!funded && (
          <p className="trade-error" role="alert">
            This pool has no liquidity yet. Add liquidity before trading.
          </p>
        )}

        <button
          className="trade-submit"
          type="submit"
          disabled={pending || (!!session && !canSwap)}
        >
          {actionLabel()}
        </button>

        {hasAmount && !numericError && (
          <div className="trade-summary">
            <span>0.3% pool fee</span>
            <span>Slippage {slippage}%</span>
          </div>
        )}
        {hasAmount && !numericError && quote.data !== undefined && (
          <details className="trade-details">
            <summary>
              <span>
                1 {symbol(inputToken)} ≈{" "}
                {executionRate?.toLocaleString("en-US", {
                  maximumFractionDigits: 6,
                })}{" "}
                {symbol(outputToken)}
              </span>
              <span>Trade details</span>
            </summary>
            <dl>
              <dt>Minimum received</dt>
              <dd>
                {minimum === undefined
                  ? "—"
                  : `${formatAmount(minimum, 6)} ${symbol(outputToken)}`}
              </dd>
              <dt>Price impact, including fee</dt>
              <dd
                className={
                  impact !== undefined && impact >= 5
                    ? "trade-impact-warning"
                    : undefined
                }
              >
                {impact === undefined ? "—" : `${impact.toFixed(3)}%`}
              </dd>
              <dt>Liquidity provider fee</dt>
              <dd>
                {amountIn
                  ? `${formatAmount((amountIn * 30n) / 10000n, 6)} ${symbol(inputToken)}`
                  : "—"}
              </dd>
              <dt>Deadline</dt>
              <dd>20 minutes</dd>
            </dl>
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
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {addresses.map((address) => (
          <option key={address} value={address}>
            {symbol(address)}
          </option>
        ))}
      </select>
    </div>
  );
}
