import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  poolKey,
  poolLabel,
  tokenDecimals,
  tokenLabel,
} from "../chain/amounts";
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
  const { client, snapshot, symbol, run, pending, tokens, amount, session } =
    useDex();
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
  useEffect(
    () => setReview(undefined),
    [session?.kind, session?.address, session?.chainId, session?.epoch],
  );
  const supported = poolAssetsSupported(pool, tokens);
  const principal = tokens.find(
    (token) => token.address.toLowerCase() === tokenIn.toLowerCase(),
  );
  const capitalInput =
    supported && principal
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
    queryFn: () => client.quoteArbitrage(pool, tokenIn, capital, tokens),
    enabled: false,
  });
  const opportunity =
    capitalInput?.canQuote && routes.isSuccess ? routes.data?.[0] : undefined;
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
  const preview =
    balance === undefined
      ? undefined
      : arbitragePreview(
          client.deployment.arbitrage,
          opportunity,
          minimum,
          balance,
          principal,
        );
  return (
    <div className="workspace arbitrage-workspace">
      <details
        className="card arbitrage-settings"
        key={result?.receipt.transactionHash ?? "setup"}
        open={!result}
      >
        <summary>
          {result ? "Find another arbitrage" : "Arbitrage settings"}
        </summary>
        <form
          className="form"
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
          <AmountField
            label="Capital amount"
            value={capital}
            onChange={setCapital}
          />
          <div className="arbitrage-capital-balance">
            <span>
              {balance === undefined
                ? session
                  ? "Capital balance unavailable."
                  : "Connect a wallet to use its balance."
                : `Balance: ${formatUnits(balance, tokenDecimals(tokens, tokenIn))} ${symbol(tokenIn)}`}
            </span>
            <button
              type="button"
              className="secondary"
              disabled={balance === undefined || pending}
              onClick={() =>
                setCapital(
                  formatUnits(balance!, tokenDecimals(tokens, tokenIn)),
                )
              }
            >
              Max
            </button>
          </div>
          <FormError
            message={
              capital === "" ? undefined : (capitalInput?.error ?? undefined)
            }
          />
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
            <p role="alert">
              Route scan failed: {routes.error.message}. Retry the scan to
              obtain a quote.
            </p>
          )}
          {routes.isSuccess && !opportunity && (
            <p role="status">
              No profitable route for this capital amount after pool fees.
            </p>
          )}
          {opportunity && (
            <div className="quote">
              <p>
                {opportunity.buy.exchange.name} #{String(opportunity.buy.id)} →{" "}
                {opportunity.sell.exchange.name} #{String(opportunity.sell.id)}
              </p>
              <strong>
                +{amount(opportunity.profit, tokenIn)} {symbol(tokenIn)}
              </strong>
              <p>
                Capital: {amount(opportunity.amountIn, tokenIn)}{" "}
                {symbol(tokenIn)}
                <br />
                Expected return: {amount(opportunity.amountOut, tokenIn)}{" "}
                {symbol(tokenIn)}
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
          <p>Token profit includes pool fees; ETH gas is separate.</p>
        </form>
      </details>
      {review && (
        <ConfirmationDialog
          title="Review atomic arbitrage"
          onClose={() => setReview(undefined)}
        >
          <dl className="arbitrage-review-values">
            <dt>Trader</dt>
            <dd>{review.caller}</dd>
            <dt>Capital committed</dt>
            <dd>
              {formatUnits(
                review.route.amountIn,
                tokenDecimals(tokens, review.route.tokenIn),
              )}{" "}
              {tokenLabel(review.route.tokenIn, symbol(review.route.tokenIn))}
            </dd>
            <dt>Buy pool</dt>
            <dd>{poolLabel(review.route.buy, symbol)}</dd>
            <dt>Sell pool</dt>
            <dd>{poolLabel(review.route.sell, symbol)}</dd>
            <dt>Quoted return</dt>
            <dd>
              {formatUnits(
                review.route.amountOut,
                tokenDecimals(tokens, review.route.tokenIn),
              )}
            </dd>
            <dt>Quoted token profit</dt>
            <dd>
              {formatUnits(
                review.route.profit,
                tokenDecimals(tokens, review.route.tokenIn),
              )}
            </dd>
            <dt>Minimum token profit</dt>
            <dd>{review.minimum}</dd>
          </dl>
          <p>
            Your capital funds both swaps. Insufficient profit reverts
            execution. ETH gas and any required token approval are paid
            separately.
          </p>
          <details>
            <summary>Quote details</summary>
            <p>Quoted at block {review.route.quotedAtBlock}.</p>
          </details>
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
                setResult(
                  await writer.arbitrage(request.route, request.minimum),
                );
                void routes.refetch();
              });
            }}
          >
            Confirm atomic arbitrage
          </button>
        </ConfirmationDialog>
      )}
      {result && (
        <section className="card">
          <ConfirmedArbitrageAction result={result} tokens={tokens} />
          <div className="simulation">
            <button className="secondary" onClick={onOpenSimulation}>
              Open market simulation
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
