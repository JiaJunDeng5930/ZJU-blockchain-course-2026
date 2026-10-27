import { tokenLabel } from "../chain/amounts";
import type { AssetFundingConfirmation } from "../chain/types";
import { useDex } from "../chain/DexProvider";
import "./OnboardingGuide.css";

export function OnboardingGuide({ captureFunding }: {
  captureFunding: () => ((confirmation: AssetFundingConfirmation) => void) | undefined;
}) {
  const { client, wallet, session, snapshot, pending, run, refresh } = useDex();
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
  const ready = plan.kind === "ready";

  return (
    <details className="onboarding" open={!ready}>
      <summary>
        {ready
          ? "Test assets available · getting started"
          : "Get ready for your first trade"}
      </summary>
      <ol>
        <li>
          <strong>{session ? "Wallet connected" : "Choose a wallet"}</strong>
          <p>
            Use a funded local test account to try the exchange immediately, or
            connect your browser wallet. Local accounts are signed by the
            development node; browser wallets ask you to approve each
            transaction.
          </p>
        </li>
        <li>
          <strong>
            {ready ? "Test assets available" : "Prepare test assets"}
          </strong>
          <p>
            ETH pays transaction gas. The local faucets provide test assets
            without importing a development private key. WETH is created by
            wrapping ETH, rather than claimed from a faucet. Use Wrap / unwrap
            next to your wallet's WETH balance; keep some ETH for gas.
          </p>
          {plan.kind === "awaiting-balances" && (
            <p role="status">
              Funding is confirmed. Refresh balances before preparing assets again.
              <button type="button" disabled={pending || snapshot.isFetching}
                onClick={() => { void refresh(); }}>Refresh balances</button>
            </p>
          )}
          {plan.kind === "need-funding" && (
            <p>
              Still needed: {[...(plan.native ? ["local ETH"] : []), ...plan.tokens.map((address) => {
                const token = client.deployment.tokens.find((candidate) => candidate.address === address)!;
                return tokenLabel(token.address, token.symbol);
              })].join(", ")}. Only missing assets will be claimed.
            </p>
          )}
          {plan.kind === "need-funding" && (
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
          )}
          {!session && wallet.state.kind === "unavailable" && (
            <p>
              Resolve the wallet connection above, or choose a local test
              account.
            </p>
          )}
        </li>
        <li>
          <strong>
            {ready ? "Choose a pool and trade" : "Then choose a pool"}
          </strong>
          <p>
            Open Swap, select a pair and exchange, enter the amount, then choose
            Review swap. Confirm the route and minimum received before approving
            the transaction. The wallet may first ask for an ERC20 approval; if
            you reject a later step, earlier confirmed approvals stay in place.
          </p>
        </li>
      </ol>
    </details>
  );
}
