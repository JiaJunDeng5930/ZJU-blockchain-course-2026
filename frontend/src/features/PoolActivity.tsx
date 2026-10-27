import { poolAssetsSupported, unsupportedPoolError } from "../logic/assets";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { poolKey } from "../chain/amounts";
import { useDex } from "../chain/DexProvider";
import { poolPositions } from "../logic/liquidity";
import type { Pool } from "../chain/types";

export function PoolActivity({ pool }: { pool: Pool }) {
  const { tokens } = useDex();
  if (!poolAssetsSupported(pool, tokens))
    return <p role="status">{unsupportedPoolError}</p>;
  return <SupportedPoolActivity pool={pool} />;
}

function SupportedPoolActivity({ pool }: { pool: Pool }) {
  const { client, snapshot, symbol, amount } = useDex();
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
          <dt>{symbol(pool.token0)} reserve</dt>
          <dd>{amount(pool.reserve0, pool.token0)}</dd>
          <dt>{symbol(pool.token1)} reserve</dt>
          <dd>{amount(pool.reserve1, pool.token1)}</dd>
          <dt>Trading fee</dt>
          <dd>0.30% retained by liquidity providers</dd>
        </dl>
        <h3>Position NFTs</h3>
        <div className="liquidity-table-scroll">
          <table>
            <thead>
              <tr>
                <th>NFT</th>
                <th>Current owner</th>
                <th>
                  Initial deposit ({symbol(pool.token0)} / {symbol(pool.token1)})
                </th>
                <th>Shares</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.data && sources.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    No active position NFTs in this pool at block{" "}
                    {snapshot.data.block}.
                  </td>
                </tr>
              )}
              {sources.map((position) => (
                <tr key={String(position.id)}>
                  <td>#{String(position.id)}</td>
                  <td>
                    <code>{position.owner}</code>
                  </td>
                  <td>
                    {amount(position.amount0, pool.token0)} /{" "}
                    {amount(position.amount1, pool.token1)}
                  </td>
                  <td>{position.shares.toString()}</td>
                  <td>
                    {new Date(
                      Number(position.createdAt) * 1000
                    ).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="liquidity-history-heading">
          <div>
            <h3>Pool activity and fees</h3>
            <p className="liquidity-small">
              Includes deposits and redemptions of closed positions.
            </p>
          </div>
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
              <p role="alert">{activity.error.message}</p>
            ) : (
              <>
                <dl className="liquidity-detail-list">
                  <dt>Swaps through block {activity.data.block}</dt>
                  <dd>{activity.data.swaps}</dd>
                  <dt>Cumulative input volume</dt>
                  <dd>
                    {amount(activity.data.volume0, pool.token0)}{" "}
                    {symbol(pool.token0)} /{" "}
                    {amount(activity.data.volume1, pool.token1)}{" "}
                    {symbol(pool.token1)}
                  </dd>
                  <dt>Pool trading fees generated</dt>
                  <dd>
                    {amount(activity.data.fees0, pool.token0)}{" "}
                    {symbol(pool.token0)} /{" "}
                    {amount(activity.data.fees1, pool.token1)}{" "}
                    {symbol(pool.token1)}
                  </dd>
                </dl>
                <p className="liquidity-small">
                  These are cumulative pool fees, not a separate balance owed to
                  a position. Fees remain in reserves and can change token
                  composition through later trades.
                </p>
                <div className="liquidity-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Action</th>
                        <th>NFT</th>
                        <th>Provider / redeemed owner</th>
                        <th>
                          {symbol(pool.token0)} / {symbol(pool.token1)}
                        </th>
                        <th>Block / transaction</th>
                      </tr>
                    </thead>
                    <tbody>
                      {events
                        .slice(
                          visiblePage * pageSize,
                          (visiblePage + 1) * pageSize
                        )
                        .map((event) => (
                          <tr key={`${event.hash}:${event.index}`}>
                            <td>{event.kind}</td>
                            <td>#{String(event.positionId)}</td>
                            <td>
                              <code>{event.actor}</code>
                            </td>
                            <td>
                              {amount(event.amount0, pool.token0)} /{" "}
                              {amount(event.amount1, pool.token1)}
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
