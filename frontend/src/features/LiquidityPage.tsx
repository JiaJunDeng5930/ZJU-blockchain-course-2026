import { poolAssetsSupported, unsupportedPoolError } from "../logic/assets";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ConfirmationDialog } from "../components/ConfirmationDialog";
import { AmountField, FormError, toleranceError } from "../components/Forms";
import {
  minimumReceived,
  poolKey,
  poolLabel,
  positiveAmount,
  sameAddress,
  shorten,
  slippageBps,
  tokenLabel,
} from "../chain/amounts";
import { useDex } from "../chain/DexProvider";
import type { Pool, Position } from "../chain/types";
import {
  counterpartAmount,
  depositPreview,
  ownedPositions,
  positionView,
  transferError,
} from "../logic/liquidity";
import { PoolActivity } from "./PoolActivity";
import "./LiquidityPage.css";

export function LiquidityPage({ pool }: { pool: Pool }) {
  const { snapshot, session, pending, symbol, tokens } = useDex();
  const [creating, setCreating] = useState(false);
  const [managed, setManaged] = useState<string>();
  const [inspectedPool, setInspectedPool] = useState(poolKey(pool));
  const pools = snapshot.data?.pools ?? [];
  const supportedPools = pools.filter((candidate) =>
    poolAssetsSupported(candidate, tokens)
  );
  const positions = ownedPositions(
    snapshot.data?.positions ?? [],
    session?.address ?? ""
  );
  const inspected =
    pools.find((candidate) => poolKey(candidate) === inspectedPool) ?? pool;

  return (
    <div className="liquidity-page">
      <header className="liquidity-heading">
        <div>
          <h1>Liquidity</h1>
        </div>
        <button
          className="button-primary liquidity-new"
          disabled={pending || !session || supportedPools.length === 0}
          onClick={() => setCreating(true)}
        >
          New position
        </button>
      </header>
      <section className="liquidity-positions" aria-label="My positions">
        {!session ? (
          <div className="liquidity-empty">
            <h3>Connect a wallet to see your positions</h3>
            <p>
              Your ERC721 positions give you the right to redeem a share of the
              pool.
            </p>
          </div>
        ) : positions.length === 0 ? (
          <div className="liquidity-empty">
            <div className="liquidity-empty-mark" aria-hidden="true">
              +
            </div>
            <h3>No liquidity positions yet</h3>
            <p>
              Add two tokens to a pool and receive a position NFT. Trading fees
              remain in the pool and contribute to its reserves.
            </p>
            <button
              className="button-primary"
              disabled={pending || supportedPools.length === 0}
              onClick={() => setCreating(true)}
            >
              Create your first position
            </button>
          </div>
        ) : (
          <div className="liquidity-position-list">
            {positions.map((position) => {
              const key = `${position.exchange.address}:${position.id}`;
              return (
                <PositionCard
                  key={key}
                  position={position}
                  expanded={managed === key}
                  onToggle={() => setManaged(managed === key ? undefined : key)}
                />
              );
            })}
          </div>
        )}
      </section>
      <section
        className="liquidity-explore"
        aria-label="Explore pool liquidity"
      >
        <div>
          <h2>Explore a pool</h2>
        </div>
        <div className="liquidity-pool-select">
          <select
            aria-label="Liquidity pool"
            value={poolKey(inspected)}
            onChange={(event) => setInspectedPool(event.target.value)}
          >
            {pools.map((candidate) => (
              <option
                key={poolKey(candidate)}
                value={poolKey(candidate)}
                title={`${candidate.exchange.address} · ${candidate.token0} / ${candidate.token1}`}
              >
                {poolLabel(candidate, symbol)}
              </option>
            ))}
          </select>
        </div>
        <PoolActivity key={poolKey(inspected)} pool={inspected} />
      </section>
      {creating && supportedPools.length > 0 && (
        <CreatePosition
          pools={supportedPools}
          initialPool={
            supportedPools.find(
              (candidate) => poolKey(candidate) === poolKey(pool)
            ) ?? supportedPools[0]
          }
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

function CreatePosition({
  initialPool,
  pools,
  onClose,
}: {
  initialPool: Pool;
  pools: Pool[];
  onClose: () => void;
}) {
  const { snapshot, symbol, pending, session, run, amount, precision, tokens } =
    useDex();
  const [selection, setSelection] = useState(poolKey(initialPool));
  const [amount0, setAmount0] = useState("");
  const [amount1, setAmount1] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [reviewing, setReviewing] = useState(false);
  const pool = pools.find((candidate) => poolKey(candidate) === selection)!;
  const decision = depositPreview(
    pool,
    amount0,
    amount1,
    slippage,
    snapshot.data!.balances[pool.token0] ?? 0n,
    snapshot.data!.balances[pool.token1] ?? 0n,
    tokens
  );
  const invalid = decision.ok ? undefined : decision.error ?? undefined;
  const used = decision.ok
    ? ([decision.used0, decision.used1] as const)
    : undefined;
  function changeAmount(value: string, index: 0 | 1) {
    if (index === 0) setAmount0(value);
    else setAmount1(value);
    const other = counterpartAmount(pool, value, index, tokens);
    if (other !== null) {
      if (index === 0) setAmount1(other);
      else setAmount0(other);
    }
  }
  return (
    <ConfirmationDialog
      title={reviewing ? "Review new position" : "New liquidity position"}
      onClose={onClose}
    >
      {reviewing && used ? (
        <div className="liquidity-create-review">
          <p className="liquidity-market-name">
            {poolLabel(pool, symbol)}
          </p>
          <dl className="liquidity-review-amounts">
            <dt title={pool.token0}>
              {tokenLabel(pool.token0, symbol(pool.token0))}
            </dt>
            <dd>{amount(used[0], pool.token0, 8)}</dd>
            <dt title={pool.token1}>
              {tokenLabel(pool.token1, symbol(pool.token1))}
            </dt>
            <dd>{amount(used[1], pool.token1, 8)}</dd>
          </dl>
          <p>
            You receive an ERC721 position NFT. Its share of both pool assets,
            including retained trading fees, can be redeemed later.
          </p>
          <dl className="liquidity-detail-list">
            <dt title={pool.token0}>
              Minimum {tokenLabel(pool.token0, symbol(pool.token0))} deposited
            </dt>
            <dd>
              {amount(
                minimumReceived(used[0], slippageBps(slippage)),
                pool.token0,
                8
              )}
            </dd>
            <dt title={pool.token1}>
              Minimum {tokenLabel(pool.token1, symbol(pool.token1))} deposited
            </dt>
            <dd>
              {amount(
                minimumReceived(used[1], slippageBps(slippage)),
                pool.token1,
                8
              )}
            </dd>
            <dt>Slippage tolerance</dt>
            <dd>{slippage}%</dd>
            <dt>Recipient</dt>
            <dd>
              <code>{session?.address}</code>
            </dd>
          </dl>
          <p className="liquidity-small">
            Approve each token if needed, then confirm the deposit. Unused
            amounts stay in your wallet.
          </p>
          <div className="liquidity-dialog-actions">
            <button className="secondary" onClick={() => setReviewing(false)}>
              Back
            </button>
            <button
              className="button-primary"
              disabled={pending || !session || !decision.ok}
              onClick={() => {
                onClose();
                run("Add liquidity", (writer) =>
                  writer.addLiquidity(
                    pool,
                    positiveAmount(amount0, precision(pool.token0)),
                    positiveAmount(amount1, precision(pool.token1)),
                    slippageBps(slippage)
                  )
                );
              }}
            >
              Approve & mint position NFT
            </button>
          </div>
        </div>
      ) : (
        <form
          className="liquidity-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (decision.ok) setReviewing(true);
          }}
        >
          <label>
            Pool
            <select
              aria-label="Position pool"
              value={selection}
              onChange={(event) => {
                setSelection(event.target.value);
                setAmount0("");
                setAmount1("");
              }}
            >
              {pools.map((candidate) => (
                <option
                  key={poolKey(candidate)}
                  value={poolKey(candidate)}
                  title={`${candidate.exchange.address} · ${candidate.token0} / ${candidate.token1}`}
                >
                  {poolLabel(candidate, symbol)}
                </option>
              ))}
            </select>
          </label>
          {pool.totalShares === 0n && (
            <p className="liquidity-notice">
              This pool has no liquidity. Your first deposit sets the starting
              price.
            </p>
          )}
          <div className="liquidity-deposit-token">
            <AmountField
              label={tokenLabel(pool.token0, symbol(pool.token0))}
              name="Liquidity token 0"
              value={amount0}
              onChange={(value) => changeAmount(value, 0)}
            />
            <small>
              Balance{" "}
              {amount(snapshot.data!.balances[pool.token0] ?? 0n, pool.token0)}{" "}
              {symbol(pool.token0)}
            </small>
          </div>
          <div className="liquidity-deposit-token">
            <AmountField
              label={tokenLabel(pool.token1, symbol(pool.token1))}
              name="Liquidity token 1"
              value={amount1}
              onChange={(value) => changeAmount(value, 1)}
            />
            <small>
              Balance{" "}
              {amount(snapshot.data!.balances[pool.token1] ?? 0n, pool.token1)}{" "}
              {symbol(pool.token1)}
            </small>
          </div>
          <FormError message={amount0 || amount1 ? invalid : undefined} />
          <details className="liquidity-settings">
            <summary>Settings · {slippage}% slippage</summary>
            <AmountField
              label="Slippage tolerance (%)"
              name="Liquidity slippage"
              value={slippage}
              onChange={setSlippage}
            />
            <FormError message={toleranceError(slippage)} />
          </details>
          <button
            className="button-primary liquidity-review-button"
            type="submit"
            disabled={pending || !decision.ok}
          >
            Review position
          </button>
        </form>
      )}
    </ConfirmationDialog>
  );
}

type TransferDraft = {
  recipient: string;
  onRecipientChange: (value: string) => void;
};
type PositionCardProps = {
  position: Position;
  expanded: boolean;
  onToggle: () => void;
};
function PositionCard(props: PositionCardProps) {
  const { snapshot, tokens } = useDex();
  const [recipient, setRecipient] = useState("");
  const { position } = props;
  const pool = snapshot.data!.pools.find(
    (candidate) =>
      sameAddress(candidate.exchange.address, position.exchange.address) &&
      candidate.id === position.poolId
  )!;
  return poolAssetsSupported(pool, tokens) ? (
    <SupportedPositionCard
      {...props}
      pool={pool}
      recipient={recipient}
      onRecipientChange={setRecipient}
    />
  ) : (
    <UnsupportedPositionCard
      pool={pool}
      position={position}
      recipient={recipient}
      onRecipientChange={setRecipient}
    />
  );
}

function SupportedPositionCard({
  position,
  expanded,
  onToggle,
  pool,
  recipient,
  onRecipientChange,
}: PositionCardProps & { pool: Pool } & TransferDraft) {
  const { client, symbol, pending, session, run, amount } = useDex();
  const [showMetadata, setShowMetadata] = useState(false);
  const [review, setReview] = useState<"redeem" | "transfer">();
  const [slippage, setSlippage] = useState("0.5");
  const view = positionView(pool, position);
  const { amounts, currentValue, valueChange, sharePercent } = view;
  const metadata = useQuery({
    queryKey: [
      "metadata",
      client.key,
      position.exchange.address,
      String(position.id),
    ],
    queryFn: () => client.metadata(position.id, position.exchange.address),
    enabled: showMetadata,
  });
  const invalidTolerance = toleranceError(slippage);

  return (
    <article className="liquidity-position">
      <div className="liquidity-position-summary">
        <div className="liquidity-position-identity">
          <div className="liquidity-token-pair" aria-hidden="true">
            <span>{symbol(pool.token0).slice(0, 1)}</span>
            <span>{symbol(pool.token1).slice(0, 1)}</span>
          </div>
          <div>
            <strong>
              {symbol(pool.token0)} / {symbol(pool.token1)}
            </strong>
            <h3>
              {position.exchange.name} · NFT #{String(position.id)}
            </h3>
          </div>
        </div>
        <div className="liquidity-position-assets">
          <span>
            {amount(amounts[0], pool.token0)} {symbol(pool.token0)}
          </span>
          <span>
            {amount(amounts[1], pool.token1)} {symbol(pool.token1)}
          </span>
        </div>
        <button
          className="secondary liquidity-manage"
          aria-label={`Manage NFT #${position.id}`}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? "Close" : "Manage"}
        </button>
      </div>
      {expanded && (
        <div className="liquidity-position-detail">
          <dl className="liquidity-detail-list">
            <dt>Shares / pool ownership</dt>
            <dd>
              {position.shares.toString()} / {sharePercent}%
            </dd>
            <dt>Initial deposit</dt>
            <dd>
              {amount(position.amount0, pool.token0)} {symbol(pool.token0)} /{" "}
              {amount(position.amount1, pool.token1)} {symbol(pool.token1)}
            </dd>
            <dt>Redeem quote</dt>
            <dd>
              {amount(amounts[0], pool.token0)} {symbol(pool.token0)} /{" "}
              {amount(amounts[1], pool.token1)} {symbol(pool.token1)}
            </dd>
            <dt>Current value at pool price</dt>
            <dd>
              {amount(currentValue, pool.token1)} {symbol(pool.token1)}
            </dd>
            <dt>Compared with holding the initial deposit</dt>
            <dd>
              {view.valueSign}
              {amount(valueChange, pool.token1)} {symbol(pool.token1)}
            </dd>
            <dt>Created</dt>
            <dd>
              {new Date(Number(position.createdAt) * 1000).toLocaleString()}
            </dd>
          </dl>
          <p className="liquidity-small">
            Fees are included in the redeem quote. The value comparison also
            reflects price changes and impermanent loss; it is not a separate
            fee balance or a guaranteed return.
          </p>
          <div className="liquidity-position-actions">
            <button
              className="button-primary"
              disabled={pending || !session}
              onClick={() => setReview("redeem")}
            >
              Burn NFT #{String(position.id)} & redeem
            </button>
            <button
              className="secondary"
              disabled={pending || !session}
              onClick={() => setReview("transfer")}
            >
              Transfer position
            </button>
            <button
              className="text"
              onClick={() => setShowMetadata(!showMetadata)}
            >
              View on-chain metadata
            </button>
          </div>
          {showMetadata && (
            <div>
              {metadata.isPending ? (
                <p>Reading metadata…</p>
              ) : metadata.error ? (
                <p role="alert">{metadata.error.message}</p>
              ) : (
                <pre className="liquidity-metadata">
                  {JSON.stringify(metadata.data, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
      {review === "redeem" && (
        <ConfirmationDialog
          title="Review position redemption"
          onClose={() => setReview(undefined)}
        >
          <p>
            {position.exchange.name} ({shorten(position.exchange.address)}),
            pool #{String(position.poolId)}: NFT #{String(position.id)} will be
            permanently burned. Both assets, including your share of fees, will
            be sent to its current owner:
          </p>
          <code className="liquidity-recipient">{position.owner}</code>
          <dl className="liquidity-detail-list">
            <dt title={pool.token0}>
              Expected {tokenLabel(pool.token0, symbol(pool.token0))}
            </dt>
            <dd>{amount(amounts[0], pool.token0)}</dd>
            <dt title={pool.token1}>
              Expected {tokenLabel(pool.token1, symbol(pool.token1))}
            </dt>
            <dd>{amount(amounts[1], pool.token1)}</dd>
          </dl>
          <AmountField
            label="Redemption slippage (%)"
            value={slippage}
            onChange={setSlippage}
          />
          <FormError message={invalidTolerance} />
          {!invalidTolerance && (
            <p className="liquidity-small">
              Minimum received:{" "}
              {amount(
                minimumReceived(amounts[0], slippageBps(slippage)),
                pool.token0
              )}{" "}
              {symbol(pool.token0)} and{" "}
              {amount(
                minimumReceived(amounts[1], slippageBps(slippage)),
                pool.token1
              )}{" "}
              {symbol(pool.token1)}.
            </p>
          )}
          <button
            className="button-primary"
            disabled={pending || !!invalidTolerance}
            onClick={() => {
              setReview(undefined);
              run("Redeem position", (writer) =>
                writer.removeLiquidity(
                  pool,
                  position.id,
                  amounts,
                  slippageBps(slippage)
                )
              );
            }}
          >
            Confirm redemption
          </button>
        </ConfirmationDialog>
      )}
      {review === "transfer" && (
        <TransferPositionDialog
          recipient={recipient}
          onRecipientChange={onRecipientChange}
          pool={pool}
          position={position}
          onClose={() => setReview(undefined)}
        />
      )}
    </article>
  );
}

function UnsupportedPositionCard({
  pool,
  position,
  recipient,
  onRecipientChange,
}: { pool: Pool; position: Position } & TransferDraft) {
  const { pending, session } = useDex();
  const [transferring, setTransferring] = useState(false);
  return (
    <article className="liquidity-position">
      <h3>Position NFT #{String(position.id)}</h3>
      <FormError message={unsupportedPoolError} />
      <button
        disabled={pending || !session}
        onClick={() => setTransferring(true)}
      >
        Transfer NFT
      </button>
      {transferring && (
        <TransferPositionDialog
          recipient={recipient}
          onRecipientChange={onRecipientChange}
          pool={pool}
          position={position}
          onClose={() => setTransferring(false)}
        />
      )}
    </article>
  );
}

function TransferPositionDialog({
  pool,
  position,
  onClose,
  recipient,
  onRecipientChange,
}: { pool: Pool; position: Position; onClose: () => void } & TransferDraft) {
  const { pending, session, run } = useDex();
  const recipientError = transferError(
    position.owner,
    session?.address ?? "",
    recipient
  );
  return (
    <ConfirmationDialog title="Transfer liquidity position" onClose={onClose}>
      <p>
        Transfer NFT #{String(position.id)} and all redemption rights to the
        recipient. You will no longer be able to redeem this position.
      </p>
      <label>
        Recipient address
        <input
          value={recipient}
          onChange={(event) => onRecipientChange(event.target.value)}
          placeholder="0x…"
        />
      </label>
      {recipient && <FormError message={recipientError} />}
      <button
        className="button-primary"
        disabled={pending || !!recipientError}
        onClick={() => {
          onClose();
          run("Transfer position", (writer) =>
            writer.transferPosition(pool, position.id, recipient)
          );
        }}
      >
        Confirm transfer
      </button>
    </ConfirmationDialog>
  );
}
