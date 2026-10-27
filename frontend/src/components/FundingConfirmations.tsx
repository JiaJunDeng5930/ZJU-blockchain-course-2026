import type { AssetFundingConfirmation } from "../chain/types";
import { tokenLabel } from "../chain/amounts";
import { formatUnits } from "../logic/units";
import "./FundingConfirmations.css";

export function FundingConfirmations({ confirmations }: {
  confirmations: readonly AssetFundingConfirmation[];
}) {
  if (confirmations.length === 0) return null;
  return (
    <section className="funding-confirmations" aria-label="Confirmed test assets">
      <h3>Confirmed test assets</h3>
      <p>These receipts confirm the grants. Wallet balances are read separately.</p>
      {confirmations.map((confirmation) => {
        const token = confirmation.kind === "token" ? confirmation.token : undefined;
        const unit = token ? tokenLabel(token.address, token.symbol) : "ETH";
        return (
          <details key={confirmation.receipt.transactionHash}>
            <summary title={token?.address}>
              {formatUnits(confirmation.amount, token?.decimals ?? 18)} {unit} confirmed
            </summary>
            <dl>
              {token && <><dt>Token contract</dt><dd><code>{token.address}</code></dd></>}
              <dt>Received by</dt><dd><code>{confirmation.recipient}</code></dd>
              <dt>Sender / fee payer</dt><dd><code>{confirmation.receipt.from}</code></dd>
              <dt>Execution fee</dt><dd>{formatUnits(confirmation.gasCostWei, 18)} ETH</dd>
              <dt>Confirmed block</dt><dd>{String(confirmation.receipt.blockNumber)}</dd>
              <dt>Transaction</dt><dd><code>{confirmation.receipt.transactionHash}</code></dd>
            </dl>
          </details>
        );
      })}
    </section>
  );
}
