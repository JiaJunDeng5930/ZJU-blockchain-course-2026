import { useEffect, useRef } from "react";
import { useDex } from "../chain/DexProvider";
import { tokenLabel } from "../chain/amounts";
import type { Pool, PoolCreationConfirmation } from "../chain/types";
import { createdPoolContinuation } from "../logic/poolCreationReceipt";
import { executionFeeWei } from "../logic/receipts";
import { formatUnits } from "../logic/units";
import "./ConfirmedCreation.css";

export function ConfirmedPoolCreation({
  result,
  onProvideLiquidity,
  focusOnReceipt = false,
}: {
  result: PoolCreationConfirmation;
  onProvideLiquidity: (pool: Pool) => void;
  focusOnReceipt?: boolean;
}) {
  const { client, snapshot, symbol, tokens, session, pending } = useDex();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusOnReceipt) {
      panel.current!.focus({ preventScroll: true });
      panel.current!.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [focusOnReceipt, result.receipt.transactionHash]);
  const continuation = createdPoolContinuation(
    result,
    snapshot.data?.pools,
    tokens,
    !!session,
    pending,
  );
  const blocked = {
    "connect-wallet":
      "Open wallet to connect an account before preparing a deposit.",
    pending:
      "Wait for the pending wallet operation before preparing a deposit.",
    "unsupported-assets":
      "Use Pools & tokens to import or read both asset addresses before preparing a deposit.",
  };
  return (
    <section
      ref={panel}
      tabIndex={-1}
      className="card creation-result"
      aria-label="Confirmed pool creation"
    >
      <h2>Pool created</h2>
      <p>
        {result.exchange.name} · pool #{result.poolId.toString()} created.
        Creating a pool does not deposit tokens.
      </p>
      <dl className="creation-result-values">
        <dt>Exchange</dt>
        <dd>
          <code>{result.exchange.address}</code>
        </dd>
        <dt>First asset</dt>
        <dd>
          {tokenLabel(result.token0, symbol(result.token0))}
          <code>{result.token0}</code>
        </dd>
        <dt>Second asset</dt>
        <dd>
          {tokenLabel(result.token1, symbol(result.token1))}
          <code>{result.token1}</code>
        </dd>
        <dt>Created by</dt>
        <dd>
          <code>{result.receipt.from}</code>
        </dd>
        <dt>Chain</dt>
        <dd>{client.deployment.chainId}</dd>
        <dt>Confirmed block</dt>
        <dd>{result.receipt.blockNumber.toString()}</dd>
        <dt>Execution fee</dt>
        <dd>{formatUnits(executionFeeWei(result.receipt), 18)} ETH</dd>
        <dt>Transaction</dt>
        <dd>
          <code>{result.receipt.transactionHash}</code>
        </dd>
      </dl>
      {continuation.kind === "read-state" ? (
        <>
          <p role="status">
            Creation is confirmed. Read this pool's current state before
            preparing a deposit.
          </p>
          <button
            type="button"
            disabled={snapshot.isFetching}
            onClick={() => void snapshot.refetch()}
          >
            {snapshot.isFetching
              ? "Reading created pool…"
              : "Read created pool"}
          </button>
        </>
      ) : (
        <>
          <p>
            Pool state observed at block {snapshot.data!.block}. Add liquidity
            using this observed state.
          </p>
          {continuation.kind === "ready" ? (
            <button
              type="button"
              onClick={() => onProvideLiquidity(continuation.pool)}
            >
              Add liquidity to this pool
            </button>
          ) : (
            <p role="status">{blocked[continuation.kind]}</p>
          )}
        </>
      )}
    </section>
  );
}
