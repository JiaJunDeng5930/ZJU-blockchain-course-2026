import type { KernelView } from "../wallet/kernel";

type Props = {
  history: KernelView["history"];
  quiet?: boolean;
};

export function HistoryStatus({ history, quiet = false }: Props) {
  if (
    quiet &&
    (history.kind === "ready" || history.kind === "saving") &&
    !history.error
  )
    return null;
  const message =
    history.kind === "memory"
      ? history.error
      : history.kind === "loading"
        ? "Loading saved history. New activity is not saved yet."
        : history.kind === "saving"
          ? "Saving activity…"
          : "New activity is saved in this browser.";
  return (
    <div className="history-status">
      <p role={history.kind === "memory" ? "alert" : "status"}>{message}</p>
      {history.kind !== "memory" && history.error && (
        <p role="alert">{history.error}</p>
      )}
    </div>
  );
}
