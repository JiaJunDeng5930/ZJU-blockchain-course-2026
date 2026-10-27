import { useReducer, useState } from "react";
import { useDex } from "../chain/DexProvider";
import { FormError } from "../components/Forms";
import { selectWrappedAddress, WrappingController } from "../logic/wrapping";

export function WrapAssets() {
  const { client, session, snapshot, run, pending } = useDex();
  const [controller] = useState(() => new WrappingController());
  const [, render] = useReducer((version: number) => version + 1, 0);
  const token = selectWrappedAddress(client.deployment.tokens);
  const environment = {
    connected: Boolean(session),
    pending,
    token,
    native: snapshot.data?.ether ?? null,
    wrapped: token ? snapshot.data?.balances[token] ?? null : null,
  };
  const view = controller.view(environment);
  const submit = (withdraw: boolean) => {
    const request = controller.submit(withdraw, environment);
    if (request) run(request.withdraw ? "Unwrap WETH" : "Wrap ETH", writer => writer.wrap(request.amount, request.withdraw));
  };
  return <section className="card form">
    <h2>ETH / WETH</h2>
    <label>Amount
      <input inputMode="decimal" value={view.value} disabled={pending} onChange={event => {
        controller.edit(event.target.value, environment);
        render();
      }} />
    </label>
    <FormError message={view.inputError ?? undefined} />
    <div className="row">
      <button type="button" disabled={view.wrap.kind === "rejected"} title={view.wrap.kind === "rejected" ? view.wrap.error : undefined}
        onClick={() => submit(false)}>Wrap ETH</button>
      <button type="button" className="secondary" disabled={view.unwrap.kind === "rejected"} title={view.unwrap.kind === "rejected" ? view.unwrap.error : undefined}
        onClick={() => submit(true)}>Unwrap WETH</button>
    </div>
  </section>;
}
