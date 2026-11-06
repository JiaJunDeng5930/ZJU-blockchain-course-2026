import { Fragment } from "react";
import {
  poolKey,
  poolLabel,
  sameAddress,
  tokenDecimals,
  tokenLabel,
} from "../chain/amounts";
import type { ArbitrageResult, Token } from "../chain/types";
import { arbitrageIntermediateToken } from "../logic/arbitrageReceipt";
import { formatPrice, formatUnits } from "../logic/units";
import "./ConfirmedArbitrageAction.css";

export function ConfirmedArbitrageAction({
  result,
  tokens,
}: {
  result: ArbitrageResult;
  tokens: readonly Token[];
}) {
  const symbol = (address: string) =>
    tokens.find((token) => sameAddress(token.address, address))!.symbol;
  const label = (address: string) => tokenLabel(address, symbol(address));
  const amount = (value: bigint, address: string) =>
    formatUnits(value, tokenDecimals(tokens, address));
  const buy = result.before[0]!;
  const middle = arbitrageIntermediateToken(
    buy.token0,
    buy.token1,
    result.tokenIn,
  );
  return (
    <section
      className="confirmed-arbitrage"
      data-testid="arbitrage-result"
      aria-label="Confirmed arbitrage action"
    >
      <h3>Confirmed arbitrage action</h3>
      <dl className="confirmed-arbitrage-values">
        <dt>Capital sent</dt>
        <dd>
          {amount(result.amountIn, result.tokenIn)} {label(result.tokenIn)}
        </dd>
        <dt>Bought and sold</dt>
        <dd>
          {amount(result.intermediateAmount, middle)} {label(middle)}
        </dd>
        <dt>Returned</dt>
        <dd>
          {amount(result.amountOut, result.tokenIn)} {symbol(result.tokenIn)}
        </dd>
        <dt>Realized token profit</dt>
        <dd>
          {amount(result.profit, result.tokenIn)} {symbol(result.tokenIn)}
        </dd>
      </dl>
      <p>Token profit excludes ETH gas.</p>
      <details>
        <summary>Transaction details</summary>
        <dl className="confirmed-arbitrage-values">
          <dt>Asset recipient</dt>
          <dd>
            <code>{result.trader}</code>
          </dd>
          <dt>Executed by</dt>
          <dd>
            <code>{result.receipt.from}</code>
          </dd>
          <dt>Execution fee</dt>
          <dd>{formatUnits(result.gasCostWei, 18)} ETH</dd>
          <dt>Confirmed block</dt>
          <dd>{result.receipt.blockNumber.toString()}</dd>
          <dt>Transaction</dt>
          <dd>
            <code>{result.receipt.transactionHash}</code>
          </dd>
        </dl>
      </details>
      <details>
        <summary>Pool changes</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Pool</th>
                <th>State</th>
                <th>Reserves</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              {result.before.map((before) => {
                const after = result.after.find(
                  (pool) => poolKey(pool) === poolKey(before),
                )!;
                return (
                  <Fragment key={poolKey(before)}>
                    {[
                      { state: "Before", pool: before },
                      { state: "After", pool: after },
                    ].map(({ state, pool }) => (
                      <tr key={state}>
                        {state === "Before" && (
                          <td rowSpan={2}>{poolLabel(before, symbol)}</td>
                        )}
                        <td>{state}</td>
                        <td>
                          {amount(pool.reserve0, pool.token0)}{" "}
                          {symbol(pool.token0)} /{" "}
                          {amount(pool.reserve1, pool.token1)}{" "}
                          {symbol(pool.token1)}
                        </td>
                        <td>
                          {formatPrice(
                            pool.reserve1,
                            tokenDecimals(tokens, pool.token1),
                            pool.reserve0,
                            tokenDecimals(tokens, pool.token0),
                          )}{" "}
                          {symbol(pool.token1)} per {symbol(pool.token0)}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <p>
          Before and after reserves come from this execution's contract events.
        </p>
      </details>
    </section>
  );
}
