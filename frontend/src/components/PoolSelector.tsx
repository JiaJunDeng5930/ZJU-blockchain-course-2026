import { formatAmount, poolKey, reservePrice } from "../chain/amounts";
import { useDex } from "../chain/DexProvider";
import type { Pool } from "../chain/types";
export function PoolSelector({
  pool,
  onChange,
}: {
  pool: Pool | undefined;
  onChange: (key: string) => void;
}) {
  const { snapshot, symbol } = useDex();
  return (
    <section className="pool-strip">
      <label>
        Active pool
        <select
          aria-label="Active pool"
          value={pool ? poolKey(pool) : ""}
          onChange={(event) => onChange(event.target.value)}
        >
          {snapshot.data?.pools.map((p) => (
            <option key={poolKey(p)} value={poolKey(p)}>
              {p.exchange.name} #{String(p.id)} · {symbol(p.token0)}/
              {symbol(p.token1)}
            </option>
          ))}
        </select>
      </label>
      {pool && (
        <>
          <div>
            <small>
              Reserves · {symbol(pool.token0)} / {symbol(pool.token1)}
            </small>
            <strong>
              {formatAmount(pool.reserve0)} / {formatAmount(pool.reserve1)}
            </strong>
          </div>
          <div>
            <small>1 {symbol(pool.token0)} =</small>
            <strong>
              {reservePrice(pool)?.toFixed(6) ?? "Unfunded"}{" "}
              {symbol(pool.token1)}
            </strong>
          </div>
          <div>
            <small>Fee retained by LPs</small>
            <strong>0.30%</strong>
          </div>
        </>
      )}
    </section>
  );
}
