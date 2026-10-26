import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import {
  AmountField,
  FormError,
  SubmitButton,
  TokenSelect,
  amountError,
  toleranceError,
} from "../components/Forms";

export function SwapPage({ pool }: { pool: Pool }) {
  const { client, snapshot, symbol, session, run } = useDex();
  const [inputToken, setInputToken] = useState(pool.token0);
  const [amount, setAmount] = useState("10");
  const [slippage, setSlippage] = useState("0.5");
  const outputToken = sameAddress(inputToken, pool.token0)
    ? pool.token1
    : pool.token0;
  const balance = session ? snapshot.data?.balances[inputToken] : undefined;
  const invalidAmount = amountError(amount, balance);
  const invalidTolerance = toleranceError(slippage);
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
    queryFn: () => client.quote(pool, inputToken, positiveAmount(amount)),
    enabled: !invalidAmount && funded,
  });
  const reserveIn = sameAddress(inputToken, pool.token0)
    ? pool.reserve0
    : pool.reserve1;
  const reserveOut = sameAddress(inputToken, pool.token0)
    ? pool.reserve1
    : pool.reserve0;
  const impact =
    quote.data && !invalidAmount
      ? Math.max(
          0,
          (1 -
            (Number(quote.data) * Number(reserveIn)) /
              (Number(positiveAmount(amount)) * Number(reserveOut))) *
            100,
        )
      : undefined;
  return (
    <div className="workspace">
      <form
        className="card form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalidAmount && !invalidTolerance && quote.data)
            run("Swap tokens", (writer) =>
              writer.swap(
                pool,
                inputToken,
                positiveAmount(amount),
                quote.data!,
                slippageBps(slippage),
              ),
            );
        }}
      >
        <h2>Swap tokens</h2>
        <TokenSelect
          label="Pay token"
          value={inputToken}
          onChange={setInputToken}
          addresses={[pool.token0, pool.token1]}
        />
        <AmountField
          label="Amount"
          name="Swap amount"
          value={amount}
          onChange={setAmount}
        />
        <small>
          Available: {balance === undefined ? "—" : formatAmount(balance)}{" "}
          {symbol(inputToken)}
        </small>
        <FormError message={invalidAmount} />
        <div className="quote">
          <small>Estimated receive · fee included</small>
          <strong>
            {quote.isFetching || invalidAmount
              ? "—"
              : quote.data !== undefined
                ? formatAmount(quote.data)
                : "—"}{" "}
            {symbol(outputToken)}
          </strong>
        </div>
        <AmountField
          label="Slippage tolerance (%)"
          name="Slippage"
          value={slippage}
          onChange={setSlippage}
        />
        <FormError message={invalidTolerance} />
        {!funded && (
          <p role="alert">Add initial liquidity before trading this pool.</p>
        )}
        {quote.error && (
          <p role="alert">Quote unavailable: {quote.error.message}</p>
        )}
        <SubmitButton
          disabled={
            !!invalidAmount ||
            !!invalidTolerance ||
            !quote.data ||
            quote.isFetching ||
            !funded
          }
        >
          Approve & swap
        </SubmitButton>
      </form>
      <section className="card">
        <h2>Trade details</h2>
        <dl className="details">
          <dt>Minimum received</dt>
          <dd>
            {quote.data && !invalidTolerance && !invalidAmount
              ? `${formatAmount(minimumReceived(quote.data, slippageBps(slippage)))} ${symbol(outputToken)}`
              : "—"}
          </dd>
          <dt>Price impact, including fee</dt>
          <dd>{impact === undefined ? "—" : `${impact.toFixed(3)}%`}</dd>
          <dt>Quote at block</dt>
          <dd>{snapshot.data?.block ?? "—"}</dd>
          <dt>Transaction deadline</dt>
          <dd>20 minutes after the latest chain block</dd>
        </dl>
        <p>
          The token approval and swap are separate transactions. A rejected swap
          does not undo an earlier confirmed approval.
        </p>
        <p>
          Quotes update with chain data. The contract enforces your minimum
          received amount at execution.
        </p>
      </section>
    </div>
  );
}
