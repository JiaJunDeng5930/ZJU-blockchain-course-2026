import { BrowserProvider, type Eip1193Provider, type Signer } from "ethers";
import { useEffect, useState } from "react";
import type { ExchangeClient } from "../chain/client";
import { errorMessage, sameAddress } from "../chain/amounts";

type InjectedProvider = Eip1193Provider & {
  on(event: "accountsChanged", listener: (accounts: string[]) => void): void;
  on(event: "chainChanged", listener: (chain: string) => void): void;
  on(event: "disconnect", listener: () => void): void;
  removeListener(
    event: "accountsChanged",
    listener: (accounts: string[]) => void,
  ): void;
  removeListener(
    event: "chainChanged",
    listener: (chain: string) => void,
  ): void;
  removeListener(event: "disconnect", listener: () => void): void;
};
declare global {
  interface Window {
    ethereum?: InjectedProvider;
  }
}
export type WalletSession = {
  kind: "local" | "injected";
  address: string;
  signer: Signer;
};
type WalletState =
  | { kind: "connecting" }
  | { kind: "ready"; session: WalletSession }
  | { kind: "unavailable"; message: string; source: "local" | "injected" };

export function useWallet(client: ExchangeClient) {
  const [state, setState] = useState<WalletState>({ kind: "connecting" });
  const [source, setSource] = useState<"local" | "injected">("local");
  const [localAddress, setLocalAddress] = useState("");
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    let revision = 0;
    async function synchronize(requestAccess = false) {
      const pending = ++revision;
      setState({ kind: "connecting" });
      try {
        let session: WalletSession;
        if (source === "local") {
          const address = localAddress || (await client.localAccounts())[0];
          if (!address)
            throw new Error("No unlocked local test accounts are available.");
          session = {
            kind: "local",
            address,
            signer: await client.rpc.getSigner(address),
          };
        } else {
          const injected = window.ethereum;
          if (!injected)
            throw new Error(
              "No browser wallet found. Install an EIP-1193 wallet or use a local test account.",
            );
          const accounts = (await injected.request({
            method: requestAccess ? "eth_requestAccounts" : "eth_accounts",
          })) as string[];
          if (accounts.length === 0)
            throw new Error(
              "Wallet disconnected. Connect browser wallet to continue.",
            );
          const chainId = Number(
            await injected.request({ method: "eth_chainId" }),
          );
          if (chainId !== client.deployment.chainId)
            throw new Error(
              `Wrong wallet network. Switch to chain ${client.deployment.chainId}.`,
            );
          const provider = new BrowserProvider(injected);
          session = {
            kind: "injected",
            address: accounts[0],
            signer: await provider.getSigner(accounts[0]),
          };
        }
        if (current && pending === revision)
          setState({ kind: "ready", session });
      } catch (error) {
        if (current && pending === revision)
          setState({
            kind: "unavailable",
            message: errorMessage(error),
            source,
          });
      }
    }
    void synchronize(source === "injected");
    const onAccounts = () => {
      void synchronize();
    };
    const onChain = () => {
      void synchronize();
    };
    const onDisconnect = () => {
      ++revision;
      setState({
        kind: "unavailable",
        message: "Wallet disconnected. Reconnect to continue.",
        source: "injected",
      });
    };
    const injected = window.ethereum;
    if (source === "injected" && injected) {
      injected.on("accountsChanged", onAccounts);
      injected.on("chainChanged", onChain);
      injected.on("disconnect", onDisconnect);
    }
    return () => {
      current = false;
      if (source === "injected" && injected) {
        injected.removeListener("accountsChanged", onAccounts);
        injected.removeListener("chainChanged", onChain);
        injected.removeListener("disconnect", onDisconnect);
      }
    };
  }, [client, source, localAddress, connectionAttempt]);
  return {
    state,
    selectLocal(address: string) {
      setSource("local");
      setLocalAddress(address);
    },
    connectInjected() {
      setSource("injected");
      setLocalAddress("");
      setConnectionAttempt((attempt) => attempt + 1);
    },
  };
}

export async function assertWalletSession(
  session: WalletSession,
  chainId: number,
) {
  if (session.kind === "local") return;
  const injected = window.ethereum;
  if (!injected) throw new Error("Browser wallet disconnected.");
  const [accounts, chain] = await Promise.all([
    injected.request({ method: "eth_accounts" }) as Promise<string[]>,
    injected.request({ method: "eth_chainId" }) as Promise<string>,
  ]);
  // DEFENSE: a user may change wallet account/network while an earlier approval prompt is open.
  if (
    Number(chain) !== chainId ||
    !accounts[0] ||
    !sameAddress(accounts[0], session.address)
  )
    throw new Error(
      "Wallet account or network changed during the operation. Review it and submit again.",
    );
}
