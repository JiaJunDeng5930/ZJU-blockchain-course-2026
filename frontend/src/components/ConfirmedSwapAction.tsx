import { useEffect, useRef } from "react";
import { formatUnits } from "viem";
import {
  sameAddress,
  shorten,
  tokenDecimals,
  tokenLabel,
} from "../chain/amounts";
import type { SwapExecution, SwapResult, Token } from "../chain/types";
import {
  swapExecutionPrice,
  swapSettlementView,
} from "../logic/swapSettlement";
import "./ConfirmedSwapAction.css";

export function ConfirmedSwapAction({
  execution,
  tokens,
  quote,
}: {
  execution: SwapExecution;
  tokens: readonly Token[];
  quote?: Pick<SwapResult, "quoted" | "minimum">;
}) {
  const symbol = (address: string) =>
    tokens.find((token) => sameAddress(token.address, address))!.symbol;
  const label = (address: string) => tokenLabel(address, symbol(address));
  const amount = (value: bigint, address: string) =>
    formatUnits(value, tokenDecimals(tokens, address));
  const price = swapExecutionPrice(execution, tokens);
  const comparison = quote
    ? swapSettlementView({ ...execution, ...quote }, tokens)
    : undefined;
  const result = useRef<HTMLElement>(null);
  useEffect(() => {
    result.current!.focus();
  }, [execution.receipt.transactionHash]);
  return (
    <section
      ref={result}
      tabIndex={-1}
      className="confirmed-swap"
      aria-label="Confirmed swap"
    >
      <h2>Confirmed swap</h2>
      <dl>
        <dt>Paid</dt>
        <dd>
          {amount(execution.amountIn, execution.tokenIn)}{" "}
          {label(execution.tokenIn)}
        </dd>
        <dt>Received</dt>
        <dd>
          {amount(execution.amountOut, execution.tokenOut)}{" "}
          {label(execution.tokenOut)}
        </dd>
        <dt>Venue</dt>
        <dd>
          {execution.pool.exchange.name} #{String(execution.pool.id)}
        </dd>
        <dt>Trader</dt>
        <dd title={execution.trader}>{shorten(execution.trader)}</dd>
      </dl>
      <details>
        <summary>Transaction details</summary>
        <dl>
          <dt>Execution price</dt>
          <dd>
            {price ?? "—"} {label(execution.tokenOut)} per 1{" "}
            {label(execution.tokenIn)}
          </dd>
          {quote && comparison && (
            <>
              <dt>Quoted receive</dt>
              <dd>
                {amount(quote.quoted, execution.tokenOut)}{" "}
                {label(execution.tokenOut)}
              </dd>
              <dt>Minimum receive</dt>
              <dd>
                {amount(quote.minimum, execution.tokenOut)}{" "}
                {label(execution.tokenOut)}
              </dd>
              <dt>Compared with quote</dt>
              <dd>
                {comparison.comparison === "same" ? (
                  "Matched quote"
                ) : (
                  <>
                    {amount(comparison.quoteDifference, execution.tokenOut)}{" "}
                    {label(execution.tokenOut)} (
                    {comparison.comparison === "more"
                      ? "more received"
                      : "less received"}
                    )
                  </>
                )}
              </dd>
            </>
          )}
          <dt>Exchange contract</dt>
          <dd>
            <code>{execution.pool.exchange.address}</code>
          </dd>
          <dt>Trader address</dt>
          <dd>
            <code>{execution.trader}</code>
          </dd>
          <dt>Asset recipient</dt>
          <dd>
            <code>{execution.recipient}</code>
          </dd>
          <dt>ETH fee payer</dt>
          <dd>
            <code>{execution.receipt.from}</code>
          </dd>
          <dt>Execution fee</dt>
          <dd>{formatUnits(execution.gasCostWei, 18)} ETH</dd>
          <dt>Confirmed block</dt>
          <dd>{String(execution.receipt.blockNumber)}</dd>
          <dt>Transaction</dt>
          <dd>
            <code>{execution.receipt.transactionHash}</code>
          </dd>
        </dl>
        <p>
          Pool fees are included in the amounts. ETH gas excludes earlier
          approvals.
        </p>
      </details>
    </section>
  );
}
