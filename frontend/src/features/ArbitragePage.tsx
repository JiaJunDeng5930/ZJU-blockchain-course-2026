import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { poolKey, poolLabel, tokenDecimals, tokenLabel } from "../chain/amounts";
import { useDex } from "../chain/DexProvider";
import type { ArbitrageResult, Opportunity, Pool } from "../chain/types";
import { ConfirmedArbitrageAction } from "../components/ConfirmedArbitrageAction";
import { ConfirmationDialog } from "../components/ConfirmationDialog";
import {
  AmountField,
  FormError,
  SubmitButton,
  TokenSelect,
} from "../components/Forms";
import { poolAssetsSupported } from "../logic/assets";
import { arbitrageCapitalInput, arbitragePreview } from "../logic/arbitrage";
import { formatUnits } from "../logic/units";
import "./ArbitragePage.css";

export function ArbitragePage({
  pool,
  onOpenSimulation,
}: {
  pool: Pool;
  onOpenSimulation: () => void;
}) {
  const { client, snapshot, symbol, run, pending, tokens, amount, session } = useDex();
  const [tokenIn, setTokenIn] = useState(pool.token0);
  const [capital, setCapital] = useState("");
  const [minimum, setMinimum] = useState("0");
  const [result, setResult] = useState<ArbitrageResult>();
  const [review, setReview] = useState<{
    route: Opportunity;
    minimum: string;
    caller: string;
    submit: typeof run;
  }>();
  useEffect(() => setReview(undefined), [
    session?.kind,
    session?.address,
    session?.chainId,
    session?.epoch,
  ]);
  const supported = poolAssetsSupported(pool, tokens);
  const principal = tokens.find(
    (token) => token.address.toLowerCase() === tokenIn.toLowerCase()
  );
  const capitalInput = supported && principal
    ? arbitrageCapitalInput(capital, tokenDecimals(tokens, tokenIn))
    : undefined;
  const routes = useQuery({
    queryKey: [
      "arbitrage",
      client.key,
      poolKey(pool),
      tokenIn,
      capital,
      tokens.map((token) => token.address),
    ],
    queryFn: () =>
      client.quoteArbitrage(pool, tokenIn, capital, tokens),
    enabled: false,
  });
  const opportunity = capitalInput?.canQuote && routes.isSuccess ? routes.data?.[0] : undefined;
  if (!supported || !principal) {
    return (
      <section className="card">
        <p role="status">Both pool assets must be verified before arbitrage.</p>
      </section>
    );
  }
  const balance = snapshot.data?.balances[tokenIn];
  // DEFENSE: anonymous and loading snapshots contain no wallet balance observation.
  // Do not turn that missing observation into an insufficient-capital quote.
  const preview = balance === undefined
    ? undefined
    : arbitragePreview(
        client.deployment.arbitrage, opportunity, minimum, balance, principal,
      );
  return (
    <div className="workspace">
      <form
        className="card form"
        onSubmit={(event) => {
          event.preventDefault();
          if (opportunity && preview?.canExecute && session)
            setReview({
              route: opportunity,
              minimum,
              caller: session.address,
              submit: run,
            });
        }}
      >
        <TokenSelect
          label="Capital token"
          value={tokenIn}
          onChange={setTokenIn}
          addresses={[pool.token0, pool.token1]}
        />
        <AmountField label="Capital amount" value={capital} onChange={setCapital} />
        <div className="arbitrage-capital-balance">
          <span>
            {balance === undefined
              ? (session ? "Capital balance unavailable." : "Connect a wallet to use its balance.")
              : `Balance: ${formatUnits(balance, tokenDecimals(tokens, tokenIn))} ${symbol(tokenIn)}`}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={balance === undefined || pending}
            onClick={() => setCapital(formatUnits(balance!, tokenDecimals(tokens, tokenIn)))}
          >
            Max
          </button>
        </div>
        <FormError message={capital === "" ? undefined : capitalInput?.error ?? undefined} />
        <button
          type="button"
          disabled={!capitalInput?.canQuote || pending || routes.isFetching}
          onClick={() => {
            void routes.refetch();
          }}
        >
          {routes.isFetching ? "Checking routes…" : "Find profitable route"}
        </button>
        {routes.error && (
          <p role="alert">Route scan failed: {routes.error.message}. Retry the scan to obtain a quote.</p>
        )}
        {routes.isSuccess && (
          <p role="status">
            {opportunity
              ? "Quoted route available. Pool fees are included; ETH gas is excluded."
              : "No profitable route for this capital amount after pool fees."}
          </p>
        )}
        {opportunity && (
          <div className="quote">
            <p>
              {poolLabel(opportunity.buy, symbol)} → {poolLabel(opportunity.sell, symbol)}
            </p>
            <strong>
              +{amount(opportunity.profit, tokenIn)} {symbol(tokenIn)}
            </strong>
            <p>
              Capital: {amount(opportunity.amountIn, tokenIn)} {symbol(tokenIn)}
              <br />
              Expected return: {amount(opportunity.amountOut, tokenIn)} {symbol(tokenIn)}
              <br />
              Quoted at block {opportunity.quotedAtBlock}
            </p>
          </div>
        )}
        <AmountField
          label="Minimum token profit"
          name="Minimum profit"
          value={minimum}
          onChange={setMinimum}
        />
        <FormError message={preview?.error ?? undefined} />
        <SubmitButton disabled={!preview?.canExecute || routes.isFetching}>
          Review atomic arbitrage
        </SubmitButton>
        <p>
          Caller-funded, two-swap execution. Insufficient profit reverts both
          swaps. Gas is paid separately in ETH and is excluded from the token
          profit.
        </p>
      </form>
      {review && (
        <ConfirmationDialog
          title="Review atomic arbitrage"
          onClose={() => setReview(undefined)}
        >
          <dl className="arbitrage-review-values">
            <dt>Trader</dt>
            <dd>{review.caller}</dd>
            <dt>Capital token</dt>
            <dd>{tokenLabel(review.route.tokenIn, symbol(review.route.tokenIn))}</dd>
            <dt>Capital committed</dt>
            <dd>{formatUnits(review.route.amountIn, tokenDecimals(tokens, review.route.tokenIn))}</dd>
            <dt>Buy pool</dt>
            <dd>{poolLabel(review.route.buy, symbol)}</dd>
            <dt>Sell pool</dt>
            <dd>{poolLabel(review.route.sell, symbol)}</dd>
            <dt>Quoted return</dt>
            <dd>{formatUnits(review.route.amountOut, tokenDecimals(tokens, review.route.tokenIn))}</dd>
            <dt>Quoted token profit</dt>
            <dd>{formatUnits(review.route.profit, tokenDecimals(tokens, review.route.tokenIn))}</dd>
            <dt>Minimum token profit</dt>
            <dd>{review.minimum}</dd>
            <dt>Quote block</dt>
            <dd>{review.route.quotedAtBlock}</dd>
          </dl>
          <p>
            Pool fees are included. ETH gas is paid separately, including if
            execution reverts. Token approval may require a separate transaction.
            Confirmation keeps this capital, route and minimum profit.
          </p>
          <button
            type="button"
            className="button-primary"
            disabled={pending}
            onClick={() => {
              const request = review;
              setReview(undefined);
              // The captured dispatcher carries the reviewed wallet session;
              // the wallet kernel rejects it after a wallet identity change.
              request.submit("Atomic arbitrage", async (writer) => {
                setResult(await writer.arbitrage(request.route, request.minimum));
                void routes.refetch();
              });
            }}
          >
            Confirm atomic arbitrage
          </button>
        </ConfirmationDialog>
      )}
      <section className="card">
        <h2>Execution evidence</h2>
        {result ? (
          <ConfirmedArbitrageAction result={result} tokens={tokens} />
        ) : (
          <p>No arbitrage executed in this session.</p>
        )}
        <div className="simulation">
          <button className="secondary" onClick={onOpenSimulation}>
            Open market simulation
          </button>
        </div>
      </section>
    </div>
  );
}
