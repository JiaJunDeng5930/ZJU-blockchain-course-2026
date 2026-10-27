import "./assets";
import { poolKey } from "../chain/amounts";
import type { Pool } from "../chain/types";

type SelectionWire =
  | { kind: "selected"; key: string }
  | { kind: "missing"; requested: string }
  | { kind: "empty" };

export type PoolSelection =
  | { kind: "selected"; pool: Pool }
  | { kind: "missing"; requested: string }
  | { kind: "empty" };

export function resolvePoolSelection(
  requested: string | null,
  pools: readonly Pool[],
): PoolSelection {
  const byKey = new Map(pools.map((pool) => [poolKey(pool), pool]));
  const selection: SelectionWire = JSON.parse(
    globalThis.DEXAssets.poolSelection(
      JSON.stringify({ requested, available: [...byKey.keys()] }),
    ),
  );
  return selection.kind === "selected"
    ? { kind: "selected", pool: byKey.get(selection.key)! }
    : selection;
}
