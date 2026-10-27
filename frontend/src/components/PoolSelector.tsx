import { poolKey, poolLabel } from "../chain/amounts";
import { useDex } from "../chain/DexProvider";
import type { Pool } from "../chain/types";
export function PoolSelector({
  pool,
  onChange,
}: {
  pool: Pool | undefined;
  onChange: (key: string) => void;
}) {
  const { snapshot, symbol, amount, price } = useDex();
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
            <option
              key={poolKey(p)}
              value={poolKey(p)}
              title={`${p.exchange.address} · ${p.token0} / ${p.token1}`}
            >
              {poolLabel(p, symbol)}
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
              {amount(pool.reserve0, pool.token0)} /{" "}
              {amount(pool.reserve1, pool.token1)}
            </strong>
          </div>
          <div>
            <small>1 {symbol(pool.token0)} =</small>
            <strong>
              {price(pool) ?? "Unfunded"} {symbol(pool.token1)}
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
