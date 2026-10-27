import { formatUnits } from "viem";
import type { WrappingConfirmation } from "../chain/types";
import "./ConfirmedWrappingAction.css";

export function ConfirmedWrappingAction({ result }: { result: WrappingConfirmation }) {
  return (
  <section className="wrapping-confirmation" aria-label="Confirmed ETH conversion">
    <h3>{result.kind === "wrap" ? "ETH wrapped" : "WETH unwrapped"}</h3>
    <dl className="wrapping-confirmation-values">
      <dt>Conversion principal</dt>
      <dd>{formatUnits(result.amount, 18)} {result.kind === "wrap" ? "ETH → WETH" : "WETH → ETH"}</dd>
      <dt>ETH change for this transaction</dt>
      <dd>{formatUnits(result.nativeChangeWei, 18)} ETH</dd>
      <dt>WETH change for this transaction</dt>
      <dd>{formatUnits(result.wrappedChange, 18)} WETH</dd>
      <dt>Execution fee</dt>
      <dd>{formatUnits(result.gasCostWei, 18)} ETH</dd>
      <dt>Owner and fee payer</dt>
      <dd><code>{result.owner}</code></dd>
      <dt>WETH contract</dt>
      <dd><code>{result.token}</code></dd>
      <dt>Confirmed block</dt>
      <dd>{String(result.receipt.blockNumber)}</dd>
      <dt>Transaction</dt>
      <dd><code>{result.receipt.transactionHash}</code></dd>
    </dl>
    <p>
      These changes account for this conversion and its actual ETH fee.
      They are not a later wallet balance observation. WETH principal
      converts 1:1; gas does not reduce the WETH minted or burned.
    </p>
  </section>
  );
}
