import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { poolKey } from "../chain/amounts";
import { useDex } from "../chain/DexProvider";
import type { ArbitrageResult, Pool } from "../chain/types";
import {
  AmountField,
  FormError,
  SubmitButton,
  TokenSelect,
} from "../components/Forms";
import { poolAssetsSupported } from "../logic/assets";
import { arbitragePreview } from "../logic/arbitrage";

export function ArbitragePage({
  pool,
  onOpenSimulation,
}: {
  pool: Pool;
  onOpenSimulation: () => void;
}) {
  const { client, snapshot, symbol, run, pending, tokens, amount } = useDex();
  const [tokenIn, setTokenIn] = useState(pool.token0);
  const [minimum, setMinimum] = useState("0.001");
  const [result, setResult] = useState<ArbitrageResult>();
  const supported = poolAssetsSupported(pool, tokens);
  const routes = useQuery({
    queryKey: [
      "arbitrage",
      client.key,
      poolKey(pool),
      tokenIn,
      tokens.map((token) => token.address),
    ],
    queryFn: () =>
      client.opportunities(pool, snapshot.data!.pools, tokenIn, tokens),
    enabled: false,
  });
  const opportunity = supported ? routes.data?.[0] : undefined;
  const [hasScanned, setHasScanned] = useState(false);
  const preview = arbitragePreview(
    client.deployment.arbitrage,
    opportunity,
    minimum,
    snapshot.data?.balances[tokenIn] ?? 0n,
    tokens.find(
      (token) => token.address.toLowerCase() === tokenIn.toLowerCase()
    )!
  );
  if (!supported) {
    return (
      <section className="card">
        <p role="status">Both pool assets must be verified before arbitrage.</p>
      </section>
    );
  }
  return (
    <div className="workspace">
      <form
        className="card form"
        onSubmit={(event) => {
          event.preventDefault();
          if (opportunity && preview.canExecute)
            run("Atomic arbitrage", async (writer) => {
              const execution = await writer.arbitrage(opportunity, minimum);
              setResult(execution);
              void routes.refetch();
            });
        }}
      >
        <TokenSelect
          label="Capital token"
          value={tokenIn}
          onChange={(address) => {
            setTokenIn(address);
            setHasScanned(false);
          }}
          addresses={[pool.token0, pool.token1]}
        />
        <button
          type="button"
          disabled={pending || routes.isFetching}
          onClick={() => {
            setHasScanned(true);
            void routes.refetch();
          }}
        >
          {routes.isFetching ? "Checking routes…" : "Find profitable route"}
        </button>
        {routes.error && (
          <p role="alert">Route scan failed: {routes.error.message}</p>
        )}
        {hasScanned && routes.isSuccess && (
          <p role="status">
            {opportunity
              ? "Profitable route found. Quotes exclude gas."
              : "No profitable route in the scanned input sizes after pool fees."}
          </p>
        )}
        {opportunity && (
          <div className="quote">
            <p>
              {opportunity.buy.exchange.name} → {opportunity.sell.exchange.name}
            </p>
            <strong>
              +{amount(opportunity.profit, tokenIn)} {symbol(tokenIn)}
            </strong>
            <p>
              Capital: {amount(opportunity.amountIn, tokenIn)} {symbol(tokenIn)}
              <br />
              Expected return: {amount(opportunity.amountOut, tokenIn)}
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
        <FormError message={preview.error ?? undefined} />
        <SubmitButton disabled={!preview.canExecute || routes.isFetching}>
          Approve & execute atomic arbitrage
        </SubmitButton>
        <p>
          Caller-funded, two-swap execution. Insufficient profit reverts both
          swaps. Gas is paid separately in ETH and is excluded from the token
          profit.
        </p>
      </form>
      <section className="card">
        <h2>Execution evidence</h2>
        {result ? (
          <ExecutionEvidence result={result} />
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
function ExecutionEvidence({ result }: { result: ArbitrageResult }) {
  const { symbol, amount, price } = useDex();
  return (
    <div data-testid="arbitrage-result">
      <h3>
        Realized token profit: {amount(result.profit, result.tokenIn)}{" "}
        {symbol(result.tokenIn)}
      </h3>
      <p>
        Confirmed in block {result.receipt.blockNumber.toString()}. Gas
        excluded.
      </p>
      <code>{result.receipt.transactionHash}</code>
      <table>
        <thead>
          <tr>
            <th>Exchange</th>
            <th>Reserves before / after</th>
            <th>Price before / after</th>
          </tr>
        </thead>
        <tbody>
          {result.before.map((before) => {
            const next = result.after.find(
              (p) => poolKey(p) === poolKey(before)
            )!;
            return (
              <tr key={poolKey(before)}>
                <td>{before.exchange.name}</td>
                <td>
                  {amount(before.reserve0, before.token0)} /{" "}
                  {amount(before.reserve1, before.token1)}
                  <br />
                  {amount(next.reserve0, next.token0)} /{" "}
                  {amount(next.reserve1, next.token1)}
                </td>
                <td>
                  {price(before)}
                  <br />
                  {price(next)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
