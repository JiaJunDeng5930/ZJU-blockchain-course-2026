import "./ConfirmedLiquidityAction.css";
import { formatUnits } from "viem";
import { poolLabel, sameAddress, tokenLabel } from "../chain/amounts";
import type { LiquidityConfirmation, Token } from "../chain/types";

export function ConfirmedLiquidityAction({
  result,
  tokens,
}: {
  result: LiquidityConfirmation;
  tokens: readonly Token[];
}) {
  const token = (address: string) =>
    tokens.find((item) => sameAddress(item.address, address))!;
  const symbol = (address: string) => token(address).symbol;
  const precision = (address: string) => token(address).decimals;
  const { pool, receipt } = result;
  return (
    <section
      className="liquidity-confirmation"
      aria-label="Confirmed liquidity action"
    >
      <h2>Confirmed liquidity action</h2>
      <dl>
        <dt>Action</dt>
        <dd>
          {
            {
              deposit: "Position NFT minted",
              redeem: "Position NFT redeemed and burned",
              transfer: "Position NFT transferred",
            }[result.kind]
          }
        </dd>
        <dt>Pool</dt>
        <dd>{poolLabel(pool, symbol)}</dd>
        <dt>Exchange contract</dt>
        <dd>
          <code>{pool.exchange.address}</code>
        </dd>
        <dt>NFT</dt>
        <dd>#{String(result.positionId)}</dd>
        {result.kind === "transfer" ? (
          <>
            <dt>Transferred from</dt>
            <dd>
              <code>{result.from}</code>
            </dd>
            <dt>Transferred to</dt>
            <dd>
              <code>{result.to}</code>
            </dd>
          </>
        ) : (
          <>
            <dt>
              {result.kind === "deposit" ? "Minted to" : "Asset recipient"}
            </dt>
            <dd>
              <code>{result.owner}</code>
            </dd>
            <dt>
              {tokenLabel(pool.token0, symbol(pool.token0))}{" "}
              {result.kind === "deposit" ? "deposited" : "received"}
            </dt>
            <dd>{formatUnits(result.amount0, precision(pool.token0))}</dd>
            <dt>
              {tokenLabel(pool.token1, symbol(pool.token1))}{" "}
              {result.kind === "deposit" ? "deposited" : "received"}
            </dt>
            <dd>{formatUnits(result.amount1, precision(pool.token1))}</dd>
            <dt>Position shares</dt>
            <dd>{String(result.shares)}</dd>
          </>
        )}
        <dt>Executed by</dt>
        <dd>
          <code>{receipt.from}</code>
        </dd>
        <dt>Execution fee</dt>
        <dd>{formatUnits(result.gasCostWei, 18)} ETH</dd>
        <dt>Confirmed block</dt>
        <dd>{String(receipt.blockNumber)}</dd>
        <dt>Transaction</dt>
        <dd>
          <code>{receipt.transactionHash}</code>
        </dd>
      </dl>
      <p>
        The executing account pays the ETH fee for this transaction. Any earlier
        ERC20 approvals have separate fees. Token quantities and ETH fees are
        reported separately.
      </p>
      {result.kind === "deposit" && (
        <p>
          Token amounts come from this receipt; unused budget stayed in your
          wallet.
        </p>
      )}
      {result.kind === "redeem" && (
        <p>
          Received tokens include this position's share of retained pool fees.
          Changes from the initial deposit also reflect market prices.
        </p>
      )}
    </section>
  );
}
