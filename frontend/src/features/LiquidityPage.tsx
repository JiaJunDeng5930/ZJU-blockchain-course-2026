import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  depositAmounts,
  formatAmount,
  positiveAmount,
  sameAddress,
  slippageBps,
} from "../chain/amounts";
import { useDex } from "../chain/DexProvider";
import type { Pool, Position } from "../chain/types";
import {
  AmountField,
  FormError,
  SubmitButton,
  amountError,
  toleranceError,
} from "../components/Forms";

export function LiquidityPage({ pool }: { pool: Pool }) {
  const { snapshot, session, symbol, run } = useDex();
  const [amount0, setAmount0] = useState("100");
  const [amount1, setAmount1] = useState("100");
  const [slippage, setSlippage] = useState("0.5");
  const error0 = amountError(amount0, snapshot.data?.balances[pool.token0]);
  const error1 = amountError(amount1, snapshot.data?.balances[pool.token1]);
  const errorSlippage = toleranceError(slippage);
  const invalid = error0 ?? error1 ?? errorSlippage;
  const used =
    !error0 && !error1
      ? depositAmounts(pool, positiveAmount(amount0), positiveAmount(amount1))
      : undefined;
  const positions = snapshot.data?.positions ?? [];
  const mine = positions.filter(
    (position) => session && sameAddress(position.owner, session.address),
  );
  const sources = positions.filter(
    (position) =>
      sameAddress(position.exchange.address, pool.exchange.address) &&
      position.poolId === pool.id,
  );
  return (
    <>
      <div className="workspace">
        <form
          className="card form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalid)
              run("Add liquidity", (writer) =>
                writer.addLiquidity(
                  pool,
                  positiveAmount(amount0),
                  positiveAmount(amount1),
                  slippageBps(slippage),
                ),
              );
          }}
        >
          <h2>Add liquidity</h2>
          <p>
            Supply both tokens to mint an ERC721 position. Existing pools take
            only the amounts needed at their current ratio.
          </p>
          <AmountField
            label={`${symbol(pool.token0)} maximum`}
            name="Liquidity token 0"
            value={amount0}
            onChange={setAmount0}
          />
          <AmountField
            label={`${symbol(pool.token1)} maximum`}
            name="Liquidity token 1"
            value={amount1}
            onChange={setAmount1}
          />
          <AmountField
            label="Slippage tolerance (%)"
            name="Liquidity slippage"
            value={slippage}
            onChange={setSlippage}
          />
          <FormError message={invalid} />
          {used && (
            <p>
              Estimated deposit: {formatAmount(used[0])} {symbol(pool.token0)} +{" "}
              {formatAmount(used[1])} {symbol(pool.token1)}. Remaining tokens
              stay in your wallet.
            </p>
          )}
          <SubmitButton disabled={!!invalid}>
            Approve & mint position NFT
          </SubmitButton>
        </form>
        <section className="card">
          <h2>My positions</h2>
          <p>
            Burn a position to receive its share of current reserves, including
            fees. Original deposited amounts are historical.
          </p>
          {mine.length === 0 && <p>No active positions in this account.</p>}
          {mine.map((position) => (
            <PositionCard
              key={`${position.exchange.address}:${position.id}`}
              position={position}
              slippage={slippage}
            />
          ))}
        </section>
      </div>
      <section className="card sources">
        <h2>Liquidity sources · active pool</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>NFT</th>
                <th>Current owner</th>
                <th>Initial deposit</th>
                <th>Shares</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((position) => (
                <tr key={String(position.id)}>
                  <td>#{String(position.id)}</td>
                  <td>
                    <code>{position.owner}</code>
                  </td>
                  <td>
                    {formatAmount(position.amount0)} /{" "}
                    {formatAmount(position.amount1)}
                  </td>
                  <td>{formatAmount(position.shares)}</td>
                  <td>
                    {new Date(
                      Number(position.createdAt) * 1000,
                    ).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
function PositionCard({
  position,
  slippage,
}: {
  position: Position;
  slippage: string;
}) {
  const { client, snapshot, symbol, pending, session, run } = useDex();
  const [showMetadata, setShowMetadata] = useState(false);
  const pool = snapshot.data!.pools.find(
    (p) =>
      sameAddress(p.exchange.address, position.exchange.address) &&
      p.id === position.poolId,
  )!;
  const amounts = [
    (pool.reserve0 * position.shares) / pool.totalShares,
    (pool.reserve1 * position.shares) / pool.totalShares,
  ] as const;
  const metadata = useQuery({
    queryKey: [
      "metadata",
      client.key,
      position.exchange.address,
      String(position.id),
    ],
    queryFn: () => client.metadata(position.id, position.exchange.address),
    enabled: showMetadata,
  });
  const invalidTolerance = toleranceError(slippage);
  return (
    <article className="position">
      <h3>
        {position.exchange.name} · NFT #{String(position.id)}
      </h3>
      <p>
        {symbol(pool.token0)}/{symbol(pool.token1)} · pool #{String(pool.id)}
      </p>
      <dl className="details">
        <dt>Shares</dt>
        <dd>{formatAmount(position.shares)}</dd>
        <dt>Initial deposit</dt>
        <dd>
          {formatAmount(position.amount0)} / {formatAmount(position.amount1)}
        </dd>
        <dt>Redeem quote</dt>
        <dd>
          {formatAmount(amounts[0])} {symbol(pool.token0)} /{" "}
          {formatAmount(amounts[1])} {symbol(pool.token1)}
        </dd>
        <dt>Created</dt>
        <dd>{new Date(Number(position.createdAt) * 1000).toLocaleString()}</dd>
      </dl>
      <button
        className="secondary"
        disabled={pending || !session || !!invalidTolerance}
        onClick={() =>
          run("Redeem position", (writer) =>
            writer.removeLiquidity(
              pool,
              position.id,
              amounts,
              slippageBps(slippage),
            ),
          )
        }
      >
        Burn NFT #{String(position.id)} & redeem
      </button>
      <button className="text" onClick={() => setShowMetadata(!showMetadata)}>
        View on-chain metadata
      </button>
      {showMetadata && (
        <div>
          {metadata.isPending ? (
            <p>Reading metadata…</p>
          ) : metadata.error ? (
            <p role="alert">{metadata.error.message}</p>
          ) : (
            <pre className="result">
              {JSON.stringify(metadata.data, null, 2)}
            </pre>
          )}
        </div>
      )}
    </article>
  );
}
