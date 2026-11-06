import { ConfirmedLiquidityAction } from "../components/ConfirmedLiquidityAction";
import {
  assetPoolPrice,
  poolAssetsSupported,
  unsupportedPoolError,
} from "../logic/assets";
import { formatUnits } from "../logic/units";
import { Fragment, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ConfirmationDialog } from "../components/ConfirmationDialog";
import { AmountField, FormError, toleranceError } from "../components/Forms";
import {
  minimumReceived,
  poolKey,
  poolLabel,
  sameAddress,
  shorten,
  slippageBps,
  tokenLabel,
} from "../chain/amounts";
import { useDex } from "../chain/DexProvider";
import type { LiquidityConfirmation, Pool, Position } from "../chain/types";
import {
  counterpartAmount,
  depositPreview,
  depositBalancePreview,
  ownedPositions,
  positionView,
  prepareTransfer,
  type DepositPlan,
} from "../logic/liquidity";
import { PoolActivity } from "./PoolActivity";
import "./LiquidityPage.css";

export function LiquidityPage({
  pool,
  creating,
  onCreatingChange: setCreating,
}: {
  pool: Pool;
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
}) {
  const { snapshot, session, pending, symbol, tokens } = useDex();
  const [managed, setManaged] = useState<string>();
  const [confirmation, setConfirmation] = useState<LiquidityConfirmation>();
  const [inspectedPool, setInspectedPool] = useState(poolKey(pool));
  const confirmed = (result: LiquidityConfirmation) => {
    setConfirmation(result);
    setInspectedPool(poolKey(result.pool));
    if (result.kind === "deposit")
      setManaged(`${result.pool.exchange.address}:${result.positionId}`);
  };
  const pools = snapshot.data?.pools ?? [];
  const supportedPools = pools.filter((candidate) =>
    poolAssetsSupported(candidate, tokens),
  );
  const positions = ownedPositions(
    snapshot.data?.positions ?? [],
    session?.address ?? "",
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
      {confirmation && (
        <ConfirmedLiquidityAction result={confirmation} tokens={tokens} />
      )}
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
                  onConfirmed={confirmed}
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
      {/* Keep the draft mounted so wallet cancellation does not discard inputs. */}
      {supportedPools.length > 0 && (
        <CreatePosition
          key={poolKey(pool)}
          open={creating}
          pools={supportedPools}
          initialPool={
            supportedPools.find(
              (candidate) => poolKey(candidate) === poolKey(pool),
            ) ?? supportedPools[0]
          }
          onConfirmed={confirmed}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

function CreatePosition({
  open,
  initialPool,
  pools,
  onClose,
  onConfirmed,
}: {
  open: boolean;
  onConfirmed: (result: LiquidityConfirmation) => void;
  initialPool: Pool;
  pools: Pool[];
  onClose: () => void;
}) {
  const { snapshot, symbol, pending, session, run, precision, tokens, amount } =
    useDex();
  const [selection, setSelection] = useState(poolKey(initialPool));
  const [amount0, setAmount0] = useState("");
  const [amount1, setAmount1] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [review, setReview] = useState<{
    pool: Pool;
    plan: DepositPlan;
    slippage: bigint;
    tolerance: string;
    caller: string;
    block: number;
    submit: typeof run;
  }>();
  useEffect(
    () => setReview(undefined),
    [session?.kind, session?.address, session?.chainId, session?.epoch],
  );
  if (!open) return null;
  const pool =
    review?.pool ??
    pools.find((candidate) => poolKey(candidate) === selection)!;
  const balance0 = snapshot.data?.balances[pool.token0];
  const balance1 = snapshot.data?.balances[pool.token1];
  const balanceDecision = depositBalancePreview(
    pool,
    slippage,
    balance0,
    balance1,
  );
  // DEFENSE: anonymous/loading observations do not supply wallet balances.
  const decision =
    review || balance0 === undefined || balance1 === undefined
      ? undefined
      : depositPreview(
          pool,
          amount0,
          amount1,
          slippage,
          balance0,
          balance1,
          tokens,
        );
  const exactAmount = (value: bigint, token: string) =>
    formatUnits(value, precision(token));
  const invalid = decision?.ok ? undefined : (decision?.error ?? undefined);
  const plan = review?.plan ?? (decision?.ok ? decision : undefined);
  const used = plan ? ([plan.used0, plan.used1] as const) : undefined;
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
      title={review ? "Review new position" : "New liquidity position"}
      onClose={() => {
        setReview(undefined);
        onClose();
      }}
    >
      {review && used ? (
        <div className="liquidity-create-review">
          <p className="liquidity-market-name">{poolLabel(pool, symbol)}</p>
          <p>You receive an ERC721 position NFT.</p>
          <table className="liquidity-review-budget">
            <caption>Approximate amounts</caption>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Deposit</th>
                <th>Spending limit</th>
                <th>Minimum deposited</th>
              </tr>
            </thead>
            <tbody>
              {([0, 1] as const).map((index) => {
                const token = index === 0 ? pool.token0 : pool.token1;
                return (
                  <tr key={token}>
                    <th scope="row" title={token}>
                      {symbol(pool.token0) === symbol(pool.token1)
                        ? tokenLabel(token, symbol(token))
                        : symbol(token)}
                    </th>
                    <td title={exactAmount(used[index], token)}>
                      {amount(used[index], token, 6)}
                    </td>
                    <td
                      title={exactAmount(
                        index === 0
                          ? review.plan.desired0
                          : review.plan.desired1,
                        token,
                      )}
                    >
                      {amount(
                        index === 0
                          ? review.plan.desired0
                          : review.plan.desired1,
                        token,
                        6,
                      )}
                    </td>
                    <td
                      title={exactAmount(
                        index === 0
                          ? review.plan.minimum0
                          : review.plan.minimum1,
                        token,
                      )}
                    >
                      {amount(
                        index === 0
                          ? review.plan.minimum0
                          : review.plan.minimum1,
                        token,
                        6,
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {(review.plan.unused0 > 0n || review.plan.unused1 > 0n) && (
            <p className="liquidity-small">
              Unused budget stays in your wallet.
            </p>
          )}
          <dl className="liquidity-detail-list">
            <dt>
              {pool.totalShares === 0n ? "Starting price" : "Deposit ratio"}
            </dt>
            <dd>
              {assetPoolPrice(
                used[0],
                used[1],
                precision(pool.token0),
                precision(pool.token1),
                symbol(pool.token0),
                symbol(pool.token1),
              )}
            </dd>
            <dt>Slippage tolerance</dt>
            <dd>{review.tolerance}%</dd>
            <dt>Recipient</dt>
            <dd>
              <code>{review.caller}</code>
            </dd>
          </dl>
          {pool.totalShares === 0n && (
            <>
              <p className="liquidity-small">
                The first deposit sets the price. Permanently locked shares are
                excluded from your NFT; compare the deposit with its immediate
                redeem quote.
              </p>
              <dl className="liquidity-detail-list">
                <dt>Immediate redeem quote · {symbol(pool.token0)}</dt>
                <dd>{exactAmount(review.plan.redeemable0, pool.token0)}</dd>
                <dt>Immediate redeem quote · {symbol(pool.token1)}</dt>
                <dd>{exactAmount(review.plan.redeemable1, pool.token1)}</dd>
              </dl>
            </>
          )}
          <details className="liquidity-calculation">
            <summary>Exact amounts and pool shares</summary>
            <dl className="liquidity-detail-list">
              {([0, 1] as const).map((index) => {
                const token = index === 0 ? pool.token0 : pool.token1;
                return (
                  <Fragment key={token}>
                    <dt>Deposit {tokenLabel(token, symbol(token))}</dt>
                    <dd>{exactAmount(used[index], token)}</dd>
                    <dt>Spending limit {symbol(token)}</dt>
                    <dd>
                      {exactAmount(
                        index === 0
                          ? review.plan.desired0
                          : review.plan.desired1,
                        token,
                      )}
                    </dd>
                    <dt>Minimum deposited {symbol(token)}</dt>
                    <dd>
                      {exactAmount(
                        index === 0
                          ? review.plan.minimum0
                          : review.plan.minimum1,
                        token,
                      )}
                    </dd>
                    <dt>Unspent {symbol(token)}</dt>
                    <dd>
                      {exactAmount(
                        index === 0 ? review.plan.unused0 : review.plan.unused1,
                        token,
                      )}
                    </dd>
                  </Fragment>
                );
              })}
              <dt>NFT shares / pool shares after deposit</dt>
              <dd>
                {review.plan.shares.toString()} /{" "}
                {review.plan.totalSharesAfter.toString()}
              </dd>
              <dt>New permanently locked shares</dt>
              <dd>{review.plan.newLockedShares.toString()}</dd>
              <dt>Quote block</dt>
              <dd>{review.block}</dd>
            </dl>
            <p className="liquidity-small">
              Redeem quotes use this pool state and whole-unit rounding. Later
              pool changes can change your claim.
            </p>
          </details>
          <div className="liquidity-dialog-actions">
            <button className="secondary" onClick={() => setReview(undefined)}>
              Back
            </button>
            <button
              className="button-primary"
              disabled={pending}
              onClick={() => {
                setReview(undefined);
                onClose();
                review.submit("Add liquidity", async (writer) => {
                  const result = await writer.addLiquidity(
                    review.pool,
                    review.plan.desired0,
                    review.plan.desired1,
                    review.slippage,
                  );
                  onConfirmed(result);
                });
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
            if (decision?.ok && session) {
              setReview({
                pool,
                plan: decision,
                slippage: slippageBps(slippage),
                tolerance: slippage,
                caller: session.address,
                block: snapshot.data!.block,
                submit: run,
              });
            }
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
          <button
            className="secondary"
            type="button"
            disabled={pending || !balanceDecision.ok}
            title={
              balanceDecision.ok
                ? undefined
                : (balanceDecision.error ?? undefined)
            }
            onClick={() => {
              if (balanceDecision.ok) {
                // Keep both spending limits: feeding ratio-rounded used amounts
                // back through the planner can round the deposit down again.
                setAmount0(exactAmount(balanceDecision.desired0, pool.token0));
                setAmount1(exactAmount(balanceDecision.desired1, pool.token1));
              }
            }}
          >
            Use available balances
          </button>
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
              {balance0 === undefined
                ? "—"
                : exactAmount(balance0, pool.token0)}{" "}
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
              {balance1 === undefined
                ? "—"
                : exactAmount(balance1, pool.token1)}{" "}
              {symbol(pool.token1)}
            </small>
          </div>
          {(balance0 === undefined || balance1 === undefined) && (
            <p role="status">
              {session
                ? "Wallet balances are not available yet."
                : "Connect a wallet to prepare a deposit."}
            </p>
          )}
          {decision?.ok && (
            <p className="liquidity-deposit-estimate" role="status">
              Expected deposit: {exactAmount(decision.used0, pool.token0)}{" "}
              {symbol(pool.token0)}
              {" + "}
              {exactAmount(decision.used1, pool.token1)} {symbol(pool.token1)}.{" "}
              Unused: {exactAmount(decision.unused0, pool.token0)}{" "}
              {symbol(pool.token0)}
              {" + "}
              {exactAmount(decision.unused1, pool.token1)} {symbol(pool.token1)}{" "}
              stay in your wallet.
            </p>
          )}
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
            disabled={pending || !decision?.ok || !session}
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
  onConfirmed: (result: LiquidityConfirmation) => void;
  position: Position;
  expanded: boolean;
  onToggle: () => void;
};
type PositionIntent = {
  pool: Pool;
  position: Position;
  caller: string;
  submit: ReturnType<typeof useDex>["run"];
};
type PositionTransferReview = PositionIntent & { kind: "transfer" };
type PositionRedemptionReview = PositionIntent & {
  kind: "redeem";
  amounts: readonly [bigint, bigint];
  block: number;
};
function PositionCard(props: PositionCardProps) {
  const { snapshot, tokens } = useDex();
  const [recipient, setRecipient] = useState("");
  const { position } = props;
  const pool = snapshot.data!.pools.find(
    (candidate) =>
      sameAddress(candidate.exchange.address, position.exchange.address) &&
      candidate.id === position.poolId,
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
      onConfirmed={props.onConfirmed}
      recipient={recipient}
      onRecipientChange={setRecipient}
    />
  );
}

function SupportedPositionCard({
  position,
  expanded,
  onToggle,
  onConfirmed,
  pool,
  recipient,
  onRecipientChange,
}: PositionCardProps & { pool: Pool } & TransferDraft) {
  const { client, symbol, pending, session, run, snapshot, precision } =
    useDex();
  const [showMetadata, setShowMetadata] = useState(false);
  const [review, setReview] = useState<
    PositionRedemptionReview | PositionTransferReview
  >();
  const [slippage, setSlippage] = useState("0.5");
  useEffect(
    () => setReview(undefined),
    [session?.kind, session?.address, session?.chainId, session?.epoch],
  );
  const view = positionView(pool, position);
  const { amounts, currentValue, valueChange } = view;
  const exactAmount = (value: bigint, token: string) =>
    formatUnits(value, precision(token));
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
          <h3 title={position.exchange.address}>
            {position.exchange.name} · pool #{String(pool.id)} · NFT #
            {String(position.id)}
          </h3>
        </div>
        <div className="liquidity-position-assets">
          <span>
            {exactAmount(amounts[0], pool.token0)}{" "}
            {tokenLabel(pool.token0, symbol(pool.token0))}
          </span>
          <span>
            {exactAmount(amounts[1], pool.token1)}{" "}
            {tokenLabel(pool.token1, symbol(pool.token1))}
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
            <dd title={`${position.shares} / ${pool.totalShares}`}>
              {view.sharePercent}%
            </dd>
            <dt>Initial deposit</dt>
            <dd>
              {exactAmount(position.amount0, pool.token0)} {symbol(pool.token0)}{" "}
              / {exactAmount(position.amount1, pool.token1)}{" "}
              {symbol(pool.token1)}
            </dd>
            <dt>Redeem quote</dt>
            <dd>
              {exactAmount(amounts[0], pool.token0)} {symbol(pool.token0)} /{" "}
              {exactAmount(amounts[1], pool.token1)} {symbol(pool.token1)}
            </dd>
            <dt>Created</dt>
            <dd>
              {new Date(Number(position.createdAt) * 1000).toLocaleString()}
            </dd>
          </dl>
          <p className="liquidity-small">
            Redeem amounts include retained pool fees.
          </p>
          <details className="liquidity-calculation">
            <summary>Value comparison</summary>
            <dl className="liquidity-detail-list">
              <dt>Current value at pool price</dt>
              <dd>
                {exactAmount(currentValue, pool.token1)} {symbol(pool.token1)}
              </dd>
              <dt>Compared with holding the initial deposit</dt>
              <dd>
                {view.valueSign}
                {exactAmount(valueChange, pool.token1)} {symbol(pool.token1)}
              </dd>
            </dl>
            <p className="liquidity-small">
              The comparison includes price changes and impermanent loss, not a
              separate fee balance.
            </p>
          </details>
          <div className="liquidity-position-actions">
            <button
              className="button-primary"
              disabled={pending || !session || !snapshot.data}
              onClick={() => {
                if (session && snapshot.data)
                  setReview({
                    kind: "redeem",
                    pool,
                    position,
                    amounts,
                    caller: session.address,
                    submit: run,
                    block: snapshot.data.block,
                  });
              }}
            >
              Burn NFT #{String(position.id)} & redeem
            </button>
            <button
              className="secondary"
              disabled={pending || !session}
              onClick={() => {
                if (session)
                  setReview({
                    kind: "transfer",
                    pool,
                    position,
                    caller: session.address,
                    submit: run,
                  });
              }}
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
                <>
                  <p role="alert">{metadata.error.message}</p>
                  <button
                    type="button"
                    className="text"
                    disabled={metadata.isFetching}
                    onClick={() => void metadata.refetch()}
                  >
                    {metadata.isFetching
                      ? "Reading metadata…"
                      : "Read metadata again"}
                  </button>
                </>
              ) : (
                <pre className="liquidity-metadata">
                  {JSON.stringify(metadata.data, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
      {review?.kind === "redeem" && (
        <ConfirmationDialog
          title="Review position redemption"
          onClose={() => setReview(undefined)}
        >
          <p>
            {review.position.exchange.name} (
            {shorten(review.position.exchange.address)}), pool #
            {String(review.position.poolId)}: NFT #{String(review.position.id)}{" "}
            will be permanently burned. Assets and retained fees go to the
            owner:
          </p>
          <code className="liquidity-recipient">{review.position.owner}</code>
          <dl className="liquidity-detail-list">
            <dt title={review.pool.token0}>
              Expected{" "}
              {tokenLabel(review.pool.token0, symbol(review.pool.token0))}
            </dt>
            <dd>
              {formatUnits(review.amounts[0], precision(review.pool.token0))}
            </dd>
            <dt title={review.pool.token1}>
              Expected{" "}
              {tokenLabel(review.pool.token1, symbol(review.pool.token1))}
            </dt>
            <dd>
              {formatUnits(review.amounts[1], precision(review.pool.token1))}
            </dd>
          </dl>
          <AmountField
            label="Redemption slippage (%)"
            value={slippage}
            onChange={setSlippage}
          />
          <p className="liquidity-small">
            Minima apply to this quote; later pool changes can cause a revert.
          </p>
          <FormError message={invalidTolerance} />
          {!invalidTolerance && (
            <p className="liquidity-small">
              Minimum received:{" "}
              {formatUnits(
                minimumReceived(review.amounts[0], slippageBps(slippage)),
                precision(review.pool.token0),
              )}{" "}
              {symbol(review.pool.token0)} and{" "}
              {formatUnits(
                minimumReceived(review.amounts[1], slippageBps(slippage)),
                precision(review.pool.token1),
              )}{" "}
              {symbol(review.pool.token1)}.
            </p>
          )}
          <button
            className="button-primary"
            disabled={pending || !!invalidTolerance}
            onClick={() => {
              setReview(undefined);
              review.submit("Redeem position", async (writer) => {
                onConfirmed(
                  await writer.removeLiquidity(
                    review.pool,
                    review.position.id,
                    review.amounts,
                    slippageBps(slippage),
                  ),
                );
              });
            }}
          >
            Confirm redemption
          </button>
        </ConfirmationDialog>
      )}
      {review?.kind === "transfer" && (
        <TransferPositionDialog
          recipient={recipient}
          onRecipientChange={onRecipientChange}
          onConfirmed={onConfirmed}
          review={review}
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
  onConfirmed,
}: {
  pool: Pool;
  position: Position;
  onConfirmed: (result: LiquidityConfirmation) => void;
} & TransferDraft) {
  const { pending, session, run } = useDex();
  const [review, setReview] = useState<PositionTransferReview>();
  useEffect(
    () => setReview(undefined),
    [session?.kind, session?.address, session?.chainId, session?.epoch],
  );
  return (
    <article className="liquidity-position">
      <h3>
        {position.exchange.name} · pool #{String(pool.id)} · NFT #
        {String(position.id)}
      </h3>
      <FormError message={unsupportedPoolError} />
      <button
        disabled={pending || !session}
        onClick={() => {
          if (session)
            setReview({
              kind: "transfer",
              pool,
              position,
              caller: session.address,
              submit: run,
            });
        }}
      >
        Transfer NFT
      </button>
      {review && (
        <TransferPositionDialog
          recipient={recipient}
          onRecipientChange={onRecipientChange}
          onConfirmed={onConfirmed}
          review={review}
          onClose={() => setReview(undefined)}
        />
      )}
    </article>
  );
}

function TransferPositionDialog({
  review,
  onClose,
  recipient,
  onRecipientChange,
  onConfirmed,
}: {
  review: PositionTransferReview;
  onClose: () => void;
  onConfirmed: (result: LiquidityConfirmation) => void;
} & TransferDraft) {
  const { pending, symbol } = useDex();
  const { pool, position, caller, submit } = review;
  const plan = prepareTransfer(position.owner, caller, recipient);
  return (
    <ConfirmationDialog title="Transfer liquidity position" onClose={onClose}>
      <p>
        Transfer {poolLabel(pool, symbol)} position NFT #{String(position.id)}{" "}
        and its redemption rights to the recipient.
      </p>
      <dl className="liquidity-detail-list">
        <dt>Current owner</dt>
        <dd className="liquidity-recipient">{position.owner}</dd>
      </dl>
      <label>
        Recipient address
        <input
          value={recipient}
          onChange={(event) => onRecipientChange(event.target.value)}
          placeholder="0x…"
        />
      </label>
      {recipient && !plan.ok && <FormError message={plan.error} />}
      <button
        className="button-primary"
        disabled={pending || !plan.ok}
        onClick={() => {
          if (plan.ok) {
            onClose();
            submit("Transfer position", async (writer) => {
              onConfirmed(
                await writer.transferPosition(
                  pool,
                  position.id,
                  plan.recipient,
                ),
              );
            });
          }
        }}
      >
        Confirm transfer
      </button>
    </ConfirmationDialog>
  );
}
