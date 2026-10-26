import { parseEther } from "ethers";
import { useDex } from "../chain/DexProvider";
import "./OnboardingGuide.css";

const minimumGasBalance = parseEther("0.01");

export function OnboardingGuide() {
  const { client, wallet, session, snapshot, pending, run } = useDex();
  const testTokens = client.deployment.tokens.filter(
    (token) => token.kind === "faucet",
  );
  const hasGas =
    snapshot.data !== undefined && snapshot.data.ether >= minimumGasBalance;
  const missingTokens = testTokens.filter(
    (token) => (snapshot.data?.balances[token.address] ?? 0n) === 0n,
  );
  const funded = hasGas && missingTokens.length === 0;
  const ready = session !== undefined && snapshot.data !== undefined && funded;

  return (
    <details className="onboarding" open={!ready}>
      <summary>
        {ready
          ? "Ready to trade · getting started"
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
            {funded ? "Test assets available" : "Prepare test assets"}
          </strong>
          <p>
            ETH pays transaction gas.{" "}
            {testTokens.map((token) => token.symbol).join(" and ")} are the
            tokens you trade. The local faucet can fund a new wallet without
            importing a development private key.
          </p>
          {session && snapshot.data && !funded && (
            <button
              disabled={pending}
              onClick={() =>
                run("Prepare test assets", async (writer) => {
                  if (!hasGas) await writer.claimEther();
                  for (const token of missingTokens) await writer.faucet(token);
                })
              }
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
            Open Swap, select Harbor or Summit, enter the amount and review the
            minimum received. Approve &amp; swap first authorizes only that
            token amount, then submits the swap. If you reject a later step,
            earlier confirmed approvals stay in place.
          </p>
        </li>
      </ol>
    </details>
  );
}
