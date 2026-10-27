import { useDex } from "../chain/DexProvider";
import { shorten } from "../chain/amounts";
import "./ChainDataStatus.css";

export function ChainDataStatus() {
  const { client, snapshot } = useDex();
  if (!snapshot.data && !snapshot.error) return null;

  return (
    <section className="chain-data-status" aria-label="Chain data">
      <div className="chain-data-summary">
        <p>
          Chain {client.deployment.chainId}
          {snapshot.data ? (
            <>
              {" · "}Block {snapshot.data.block}
              {snapshot.data.identity ? (
                <>
                  {" · "}Balances for{" "}
                  <span title={snapshot.data.identity.address}>
                    {shorten(snapshot.data.identity.address)}
                  </span>
                </>
              ) : (
                " · Public pool data"
              )}
              {snapshot.isPlaceholderData
                ? " · Updating assets"
                : snapshot.isFetching
                  ? " · Refreshing"
                  : null}
            </>
          ) : snapshot.isFetching ? (
            " · Reading chain data"
          ) : (
            " · Chain data unavailable"
          )}
        </p>
        <button
          className="button-secondary"
          aria-label="Refresh chain data"
          disabled={snapshot.isFetching}
          onClick={() => {
            void snapshot.refetch();
          }}
        >
          Refresh
        </button>
      </div>
      {snapshot.error && (
        <p role="alert" className="chain-data-error">
          {snapshot.data
            ? "Last refresh failed. The displayed snapshot is retained."
            : "Unable to read pools, balances and positions."}{" "}
          Confirmed transactions remain available in Activity.{" "}
          {snapshot.error.message}
        </p>
      )}
    </section>
  );
}
