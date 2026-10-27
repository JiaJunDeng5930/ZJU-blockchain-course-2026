import {
  BrowserProvider,
  JsonRpcSigner,
  type Eip1193Provider,
  type Signer,
} from "ethers";
import { useEffect, useRef, useState } from "react";
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
  | {
      kind: "unavailable";
      message: string;
      source: "local" | "injected";
      reason?: "wrong-network";
    };

export function useWallet(client: ExchangeClient) {
  const [state, setState] = useState<WalletState>({ kind: "connecting" });
  const preferenceKey = `twopool:wallet:${client.deployment.chainId}:${client.deployment.rpcUrl}`;
  const [source, setSource] = useState<"local" | "injected">(() =>
    localStorage.getItem(preferenceKey) === "injected" ? "injected" : "local",
  );
  const [localAddress, setLocalAddress] = useState(
    () => localStorage.getItem(`${preferenceKey}:local-address`) ?? "",
  );
  const requestAccess = useRef(false);
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
          if (chainId !== client.deployment.chainId) {
            if (current && pending === revision)
              setState({
                kind: "unavailable",
                source: "injected",
                reason: "wrong-network",
                message: `Wrong wallet network. Switch to chain ${client.deployment.chainId}.`,
              });
            return;
          }
          const provider = new BrowserProvider(injected);
          session = {
            kind: "injected",
            address: accounts[0],
            // Constructing the signer cannot request fresh account access during restoration.
            signer: new JsonRpcSigner(provider, accounts[0]),
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
    const authorize = requestAccess.current;
    requestAccess.current = false;
    void synchronize(authorize);
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
  async function switchNetwork() {
    const injected = window.ethereum;
    if (!injected) return;
    const chainId = `0x${client.deployment.chainId.toString(16)}`;
    setState({ kind: "connecting" });
    try {
      try {
        await injected.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId }],
        });
      } catch (error) {
        // DEFENSE: EIP-3326 wallets reject unknown networks with 4902; add this deployment before retrying.
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === 4902
        ))
          throw error;
        await injected.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId,
              chainName: "TwoPool Local Ethereum",
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: [client.deployment.rpcUrl],
            },
          ],
        });
        await injected.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId }],
        });
      }
      setConnectionAttempt((attempt) => attempt + 1);
    } catch (error) {
      setState({
        kind: "unavailable",
        source: "injected",
        reason: "wrong-network",
        message:
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === 4001
            ? "Network change rejected. You can retry or choose a local test account."
            : `Network change failed: ${errorMessage(error)}`,
      });
    }
  }
  return {
    state,
    source,
    switchNetwork,
    selectLocal(address: string) {
      localStorage.setItem(preferenceKey, "local");
      localStorage.setItem(`${preferenceKey}:local-address`, address);
      requestAccess.current = false;
      setSource("local");
      setLocalAddress(address);
    },
    connectInjected() {
      localStorage.setItem(preferenceKey, "injected");
      requestAccess.current = true;
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
