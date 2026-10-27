import { ConfirmedWrappingAction } from "../components/ConfirmedWrappingAction";
import { useEffect, useReducer, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { tokenLabel } from "../chain/amounts";
import { useDex } from "../chain/DexProvider";
import { ConfirmationDialog } from "../components/ConfirmationDialog";
import { FormError } from "../components/Forms";
import {
  selectWrappedAddress,
  WrappingController,
  type WrappingRequest,
} from "../logic/wrapping";
import { formatUnits } from "../logic/units";
import type { WrappingConfirmation } from "../chain/types";
import "./WrapAssets.css";

export function WrapAssets() {
  const { client, session, snapshot, run, pending } = useDex();
  const location = useLocation();
  const section = useRef<HTMLElement>(null);
  const [controller] = useState(() => new WrappingController());
  const [withdraw, setWithdraw] = useState(false);
  const [confirmation, setConfirmation] = useState<WrappingConfirmation>();
  const [, render] = useReducer((version: number) => version + 1, 0);
  const [review, setReview] = useState<{
    request: WrappingRequest;
    owner: string;
    submit: typeof run;
  }>();
  useEffect(
    () => setReview(undefined),
    [session?.kind, session?.address, session?.chainId, session?.epoch],
  );
  useEffect(() => {
    if (location.hash === "#wrap-assets") section.current?.scrollIntoView();
  }, [location]);

  const token = selectWrappedAddress(client.deployment.tokens);
  const wrapped = token ? snapshot.data?.balances[token] : undefined;
  const environment = {
    connected: Boolean(session),
    pending,
    token,
    native: snapshot.data?.ether ?? null,
    wrapped: wrapped ?? null,
  };
  const view = controller.view(environment);
  const decision = withdraw ? view.unwrap : view.wrap;
  const submit = () => {
    const request = controller.submit(withdraw, environment);
    render();
    if (request && session) setReview({ request, owner: session.address, submit: run });
  };
  return (
    <section className="card form wrapping" id="wrap-assets" ref={section}>
      <h2>ETH / WETH</h2>
      <p>
        Wrap ETH to use it in ERC20 pools, or unwrap WETH to receive ETH. The
        conversion is 1:1. Both directions require ETH for network fees, so keep
        some ETH unwrapped.
      </p>
      <dl className="wrapping-balances">
        <dt>ETH available</dt>
        <dd>
          {snapshot.data ? formatUnits(snapshot.data.ether, 18) : "—"} ETH
        </dd>
        <dt title={token ?? undefined}>
          {token ? tokenLabel(token, "WETH") : "WETH"} available
        </dt>
        <dd>{wrapped === undefined ? "—" : formatUnits(wrapped, 18)} WETH</dd>
      </dl>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div
          className="wrapping-direction"
          role="group"
          aria-label="Conversion direction"
        >
          <button
            type="button"
            className={withdraw ? "secondary" : undefined}
            aria-pressed={!withdraw}
            disabled={pending}
            onClick={() => setWithdraw(false)}
          >
            Wrap ETH
          </button>
          <button
            type="button"
            className={withdraw ? undefined : "secondary"}
            aria-pressed={withdraw}
            disabled={pending}
            onClick={() => setWithdraw(true)}
          >
            Unwrap WETH
          </button>
        </div>
        <label htmlFor="wrapping-amount">
          {withdraw ? "WETH" : "ETH"} amount
        </label>
        <input
          id="wrapping-amount"
          inputMode="decimal"
          autoComplete="off"
          value={view.value}
          disabled={pending}
          onChange={(event) => {
            controller.edit(event.target.value, environment);
            render();
          }}
        />
        <FormError
          message={
            view.inputError ??
            (view.value !== "" && decision.kind === "rejected"
              ? decision.error
              : undefined)
          }
        />
        <div className="wrapping-actions">
          <button type="submit" disabled={decision.kind === "rejected"}>
            {withdraw ? "Review unwrap" : "Review wrap"}
          </button>
        </div>
      </form>
      {review && (
        <ConfirmationDialog
          title={review.request.withdraw ? "Review unwrap" : "Review wrap"}
          onClose={() => setReview(undefined)}
        >
          <dl className="wrapping-review-values">
            <dt>Pay</dt>
            <dd>
              {formatUnits(review.request.amount, 18)}{" "}
              {review.request.withdraw ? "WETH" : "ETH"}
            </dd>
            <dt>Receive</dt>
            <dd>
              {formatUnits(review.request.amount, 18)}{" "}
              {review.request.withdraw ? "ETH" : "WETH"}
            </dd>
            <dt>WETH contract</dt>
            <dd title={review.request.token}>
              {tokenLabel(review.request.token, "WETH")}
            </dd>
            <dt>Recipient</dt>
            <dd>
              <code>{review.owner}</code>
            </dd>
          </dl>
          <p>
            This calls the WETH contract directly. No token approval is needed.
            Gas is paid from the wallet's existing ETH. The ETH released by an
            unwrap is shown before this fee; the wallet's net ETH change can be
            negative for a small unwrap. The amount and account stay fixed when
            you confirm.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              const { request, submit } = review;
              setReview(undefined);
              submit(request.withdraw ? "Unwrap WETH" : "Wrap ETH", async (writer) => {
                setConfirmation(await writer.wrap(request.amount, request.withdraw));
              });
            }}
          >
            {review.request.withdraw ? "Confirm unwrap" : "Confirm wrap"}
          </button>
        </ConfirmationDialog>
      )}
      {confirmation && (
        <ConfirmedWrappingAction result={confirmation} />
      )}
    </section>
  );
}
