import type { PendingRecoveryView } from "../wallet/kernel";

export function PendingRecoveryStatus({
  recovery,
}: {
  recovery: PendingRecoveryView;
}) {
  return recovery.error ? (
    <p className="storage-warning" role="status">
      {recovery.error}
    </p>
  ) : null;
}
