import { poolAssetsSupported, unsupportedPoolError } from "../logic/assets";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { poolKey, tokenLabel } from "../chain/amounts";
import { useDex } from "../chain/DexProvider";
import { poolPositions, positionView } from "../logic/liquidity";
import type { Pool } from "../chain/types";

export function PoolActivity({ pool }: { pool: Pool }) {
  const { tokens } = useDex();
  if (!poolAssetsSupported(pool, tokens))
    return <p role="status">{unsupportedPoolError}</p>;
  return <SupportedPoolActivity pool={pool} />;
}

function SupportedPoolActivity({ pool }: { pool: Pool }) {
  const { client, snapshot, symbol, amount, precision } = useDex();
  const exactAmount = (value: bigint, address: string) =>
    amount(value, address, precision(address));
  const token0 = tokenLabel(pool.token0, symbol(pool.token0));
  const token1 = tokenLabel(pool.token1, symbol(pool.token1));
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const activity = useQuery({
    queryKey: [
      "liquidity-activity",
      client.key,
      poolKey(pool),
      snapshot.data?.block,
    ],
    queryFn: () => client.liquidityActivity(pool, snapshot.data!.block),
    enabled: open && expanded,
  });
  const sources = poolPositions(snapshot.data?.positions ?? [], pool);
  const pageSize = 12;
  const events = activity.data?.events ?? [];
  const pageCount = Math.max(1, Math.ceil(events.length / pageSize));
  const visiblePage = Math.min(page, pageCount - 1);
  return (
    <details
      className="liquidity-pool-details"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label="Pool information">
        <span>Pool information</span>
      </summary>
      <div className="liquidity-pool-content">
        <dl className="liquidity-detail-list">
          <dt>DEX pool</dt>
          <dd>
            {pool.exchange.name} #{String(pool.id)} ·{" "}
            <code>{pool.exchange.address}</code>
          </dd>
          <dt>{symbol(pool.token0)} contract</dt>
          <dd>
            <code>{pool.token0}</code>
          </dd>
          <dt>{symbol(pool.token1)} contract</dt>
          <dd>
            <code>{pool.token1}</code>
          </dd>
          <dt>{symbol(pool.token0)} reserve</dt>
          <dd>{exactAmount(pool.reserve0, pool.token0)}</dd>
          <dt>{symbol(pool.token1)} reserve</dt>
          <dd>{exactAmount(pool.reserve1, pool.token1)}</dd>
          <dt>Trading fee</dt>
          <dd>0.30% retained by liquidity providers</dd>
        </dl>
        <h3>Position NFTs</h3>
        {snapshot.data && (
          <p>
            Active positions at block {snapshot.data.block}. Each current owner
            can redeem the NFT's share of reserves. Original deposits record
            what entered the pool; the current redeem quote includes retained
            fees, price changes and whole-unit rounding, and is not a measure of
            profit. Transfers change the owner, not the original deposit. The
            total shares include the pool's permanently locked liquidity.
          </p>
        )}
        <div className="liquidity-table-scroll">
          <table>
            <thead>
              <tr>
                <th>NFT</th>
                <th>Current owner</th>
                <th>
                  Original deposit ({token0} / {token1})
                </th>
                <th>
                  Current redeem quote ({token0} / {token1})
                </th>
                <th>Pool shares (position / total)</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.data && sources.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    No active position NFTs in this pool at block{" "}
                    {snapshot.data.block}.
                  </td>
                </tr>
              )}
              {sources.map((position) => {
                const { amounts } = positionView(pool, position);
                return (
                  <tr key={String(position.id)}>
                    <td>#{String(position.id)}</td>
                    <td>
                      <code>{position.owner}</code>
                    </td>
                    <td>
                      {exactAmount(position.amount0, pool.token0)} /{" "}
                      {exactAmount(position.amount1, pool.token1)}
                    </td>
                    <td>
                      {exactAmount(amounts[0], pool.token0)} /{" "}
                      {exactAmount(amounts[1], pool.token1)}
                    </td>
                    <td>
                      {position.shares.toString()} /{" "}
                      {pool.totalShares.toString()}
                    </td>
                    <td>
                      {new Date(
                        Number(position.createdAt) * 1000,
                      ).toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="liquidity-history-heading">
          <h3>Pool activity and fees</h3>
          <button
            className="secondary"
            onClick={() => {
              setExpanded(!expanded);
              setPage(0);
            }}
          >
            {expanded ? "Hide pool history" : "Show pool history"}
          </button>
        </div>
        {expanded && (
          <>
            {activity.isPending ? (
              <p>Reading pool activity…</p>
            ) : activity.error ? (
              <>
                <p role="alert">{activity.error.message}</p>
                <button
                  className="secondary"
                  disabled={activity.isFetching}
                  onClick={() => void activity.refetch()}
                >
                  {activity.isFetching
                    ? "Reading pool history…"
                    : "Read pool history again"}
                </button>
              </>
            ) : (
              <>
                <p>
                  History covers this DEX pool from creation through block{" "}
                  {activity.data.block}, including positions that have been
                  redeemed. Deposit events identify the original provider;
                  redemption events identify the owner who redeemed the NFT.
                </p>
                <dl className="liquidity-detail-list">
                  <dt>Swaps through block {activity.data.block}</dt>
                  <dd>{activity.data.swaps}</dd>
                  <dt>Cumulative input volume</dt>
                  <dd>
                    {exactAmount(activity.data.volume0, pool.token0)} {token0} /{" "}
                    {exactAmount(activity.data.volume1, pool.token1)} {token1}
                  </dd>
                  <dt>Estimated nominal input fees</dt>
                  <dd>
                    {exactAmount(activity.data.fees0, pool.token0)} {token0} /{" "}
                    {exactAmount(activity.data.fees1, pool.token1)} {token1}
                  </dd>
                </dl>
                <p>
                  This estimate adds 0.30% of each swap's input, rounded down to
                  that token's smallest unit per swap. A displayed zero can omit
                  fractional-unit fees. Fees stay in reserves and move with pool
                  ownership; this history is not a separate claimable balance or
                  an individual position's earnings.
                </p>
                <div className="liquidity-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Action</th>
                        <th>NFT</th>
                        <th>Provider / redeemed owner</th>
                        <th>
                          {token0} / {token1}
                        </th>
                        <th>Block / transaction</th>
                      </tr>
                    </thead>
                    <tbody>
                      {events
                        .slice(
                          visiblePage * pageSize,
                          (visiblePage + 1) * pageSize,
                        )
                        .map((event) => (
                          <tr key={`${event.hash}:${event.index}`}>
                            <td>{event.kind}</td>
                            <td>#{String(event.positionId)}</td>
                            <td>
                              <code>{event.actor}</code>
                            </td>
                            <td>
                              {exactAmount(event.amount0, pool.token0)} /{" "}
                              {exactAmount(event.amount1, pool.token1)}
                            </td>
                            <td>
                              {event.block}
                              <br />
                              <code>{event.hash}</code>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <div className="liquidity-pagination">
                  <button
                    className="secondary"
                    disabled={visiblePage === 0}
                    onClick={() => setPage(visiblePage - 1)}
                  >
                    Previous events
                  </button>
                  <span>
                    Page {visiblePage + 1} of {pageCount} · {events.length}{" "}
                    events
                  </span>
                  <button
                    className="secondary"
                    disabled={visiblePage + 1 === pageCount}
                    onClick={() => setPage(visiblePage + 1)}
                  >
                    Next events
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </details>
  );
}
