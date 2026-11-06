import { tokenLabel } from "../chain/amounts";
import type { AssetFundingConfirmation } from "../chain/types";
import { useDex } from "../chain/DexProvider";
import "./OnboardingGuide.css";

export function OnboardingGuide({
  captureFunding,
}: {
  captureFunding: () =>
    ((confirmation: AssetFundingConfirmation) => void) | undefined;
}) {
  const { client, wallet, snapshot, pending, run, refresh } = useDex();
  const observed = snapshot.data;
  // DEFENSE: Anonymous snapshots contain no token balances, including while a wallet reconnects.
  const plan = wallet.controller.kernel.fundingPlanAfterConfirmations(
    observed?.identity
      ? {
          identity: observed.identity,
          ether: observed.ether.toString(),
          tokens: client.deployment.tokens.map((token) => ({
            address: token.address,
            kind: token.kind,
            balance: observed.balances[token.address].toString(),
          })),
        }
      : null,
    observed?.block.toString() ?? null,
  );
  if (plan.kind !== "need-funding" && plan.kind !== "awaiting-balances")
    return null;

  return (
    <section className="onboarding" aria-label="Prepare test assets">
      {plan.kind === "awaiting-balances" ? (
        <>
          <p role="status">
            Funding confirmed. Refresh to view the received assets.
          </p>
          <button
            type="button"
            disabled={pending || snapshot.isFetching}
            onClick={() => {
              void refresh();
            }}
          >
            Refresh balances
          </button>
        </>
      ) : (
        <>
          <p>
            Still needed:{" "}
            {[
              ...(plan.native ? ["local ETH"] : []),
              ...plan.tokens.map((address) => {
                const token = client.deployment.tokens.find(
                  (candidate) => candidate.address === address,
                )!;
                return tokenLabel(token.address, token.symbol);
              }),
            ].join(", ")}
            .
          </p>
          <button
            disabled={pending}
            onClick={() => {
              const confirmed = captureFunding();
              if (!confirmed) return;
              run("Prepare test assets", async (writer) => {
                if (plan.native) confirmed(await writer.claimEther());
                for (const address of plan.tokens) {
                  const token = client.deployment.tokens.find(
                    (token) => token.address === address,
                  )!;
                  confirmed(await writer.faucet(token));
                }
              });
            }}
          >
            Prepare test assets
          </button>
        </>
      )}
    </section>
  );
}
