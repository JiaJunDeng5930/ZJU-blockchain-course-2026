import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatAmount, poolKey, reservePrice } from "../chain/amounts";
import { useDex } from "../chain/DexProvider";
import type { ArbitrageResult, Pool } from "../chain/types";
import {
  AmountField,
  FormError,
  SubmitButton,
  TokenSelect,
} from "../components/Forms";
import { arbitragePreview } from "../logic/arbitrage";

export function ArbitragePage({
  pool,
  onOpenSimulation,
}: {
  pool: Pool;
  onOpenSimulation: () => void;
}) {
  const { client, snapshot, symbol, run, pending, session } = useDex();
  const [tokenIn, setTokenIn] = useState(pool.token0);
  const [minimum, setMinimum] = useState("0.001");
  const [result, setResult] = useState<ArbitrageResult>();
  const routes = useQuery({
    queryKey: ["arbitrage", client.key, poolKey(pool), tokenIn],
    queryFn: () => client.opportunities(pool, snapshot.data!.pools, tokenIn),
    enabled: false,
  });
  const opportunity = routes.data?.[0];
  const [hasScanned, setHasScanned] = useState(false);
  const preview = arbitragePreview(
    client.deployment.arbitrage,
    opportunity,
    minimum,
    snapshot.data?.balances[tokenIn] ?? 0n,
  );
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
              +{formatAmount(opportunity.profit)} {symbol(tokenIn)}
            </strong>
            <p>
              Capital: {formatAmount(opportunity.amountIn)} {symbol(tokenIn)}
              <br />
              Expected return: {formatAmount(opportunity.amountOut)}
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
  const { symbol } = useDex();
  return (
    <div data-testid="arbitrage-result">
      <h3>
        Realized token profit: {formatAmount(result.profit)}{" "}
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
              (p) => poolKey(p) === poolKey(before),
            )!;
            return (
              <tr key={poolKey(before)}>
                <td>{before.exchange.name}</td>
                <td>
                  {formatAmount(before.reserve0)} /{" "}
                  {formatAmount(before.reserve1)}
                  <br />
                  {formatAmount(next.reserve0)} / {formatAmount(next.reserve1)}
                </td>
                <td>
                  {reservePrice(before)?.toFixed(6)}
                  <br />
                  {reservePrice(next)?.toFixed(6)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
