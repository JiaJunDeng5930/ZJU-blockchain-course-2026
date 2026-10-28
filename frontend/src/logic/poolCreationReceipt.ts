import "./swapReceipt";
import { poolKey } from "../chain/amounts";
import { poolAssetsSupported } from "./assets";
import type { Pool, PoolCreationConfirmation, Token } from "../chain/types";

export type CreatedPoolContinuation =
  | { kind: "read-state" }
  | {
      kind: "connect-wallet" | "pending" | "unsupported-assets" | "ready";
      pool: Pool;
    };

export function createdPoolContinuation(
  result: PoolCreationConfirmation,
  pools: readonly Pool[] | undefined,
  tokens: readonly Token[],
  connected: boolean,
  pending: boolean,
): CreatedPoolContinuation {
  const byKey = new Map((pools ?? []).map((pool) => [poolKey(pool), pool]));
  const selection = JSON.parse(
    globalThis.DEXSwapReceipt.continueCreatedPool(
      JSON.stringify({
        requested: poolKey({ exchange: result.exchange, id: result.poolId }),
        available: [...byKey.keys()],
        supported: [...byKey]
          .filter(([, pool]) => poolAssetsSupported(pool, tokens))
          .map(([key]) => key),
        connected,
        pending,
      }),
    ),
  ) as
    | { kind: "read-state" }
    | {
        kind: "connect-wallet" | "pending" | "unsupported-assets" | "ready";
        key: string;
      };
  return selection.kind === "read-state"
    ? selection
    : { kind: selection.kind, pool: byKey.get(selection.key)! };
}
