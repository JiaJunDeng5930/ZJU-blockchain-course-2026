import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  createWalletClient,
  custom,
  getAddress,
  http,
  type Address,
  type EIP1193Provider,
  type WalletClient,
  BaseError,
} from "viem";
import type { ExchangeClient } from "../chain/client";
import { errorMessage } from "../chain/amounts";
import {
  WalletKernel,
  type KernelReply,
  type KernelEvent,
  type WalletEffect,
  type WalletIdentity,
  type WalletSource,
} from "./kernel";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}
export type WalletSession = {
  kind: WalletSource;
  address: Address;
  chainId: string;
  epoch: string;
  walletClient: WalletClient;
};
export function sessionIdentity(session: WalletSession): WalletIdentity {
  return {
    source: session.kind,
    address: session.address,
    chain: session.chainId,
    epoch: session.epoch,
  };
}
export function transportErrorCode(error: unknown): string | null {
  // Wallet errors may omit an EIP-1193 code; absence stays explicit at the model boundary.
  const cause =
    error instanceof BaseError
      ? error.walk((entry) =>
          Boolean(entry && typeof entry === "object" && "code" in entry),
        )
      : error;
  if (
    cause &&
    typeof cause === "object" &&
    "code" in cause &&
    typeof cause.code === "number"
  )
    return cause.code.toString();
  return null;
}

/** Executes the external operations emitted by Rocq; it does not decide connection policy. */
class WalletController {
  readonly kernel: WalletKernel;
  private started = false;
  private preferenceKey: string;
  constructor(readonly client: ExchangeClient) {
    this.preferenceKey = `twopool:wallet:${client.deployment.chainId}:${client.deployment.rpcUrl}`;
    const address = localStorage.getItem(`${this.preferenceKey}:local-address`);
    this.kernel = new WalletKernel({
      chain: client.deployment.chainId.toString(),
      source: localStorage.getItem(this.preferenceKey),
      address: address ? getAddress(address) : null,
    });
  }
  dispatch<T = unknown>(event: KernelEvent): KernelReply<T> {
    const reply = this.kernel.dispatch<T>(event);
    void this.execute(reply.effects);
    return reply;
  }
  async start() {
    const reply = this.started
      ? this.kernel.dispatch({ kind: "invalidate" })
      : this.kernel.start();
    this.started = true;
    await this.execute(reply.effects);
  }
  stop() {
    this.kernel.dispatch({ kind: "disconnect" });
  }
  async switchNetwork() {
    await this.execute(
      this.kernel.dispatch({ kind: "switch-network" }).effects,
    );
  }
  private async execute(effects: WalletEffect[]): Promise<void> {
    for (const effect of effects) {
      switch (effect.kind) {
        case "persist":
          localStorage.setItem(this.preferenceKey, effect.preference.source);
          if (effect.preference.address !== null)
            localStorage.setItem(
              `${this.preferenceKey}:local-address`,
              effect.preference.address,
            );
          break;
        case "observe": {
          let event: KernelEvent;
          if (effect.source === "injected" && !window.ethereum) {
            event = {
              kind: "observation-failed",
              request: effect.request,
              reason: "missing-provider",
            };
          } else {
            try {
              event = {
                kind: "observed",
                request: effect.request,
                ...(await this.observe(effect.source, effect.requestAccess)),
              };
            } catch (error) {
              event = {
                kind: "observation-failed",
                request: effect.request,
                reason: "request-failed",
                message: errorMessage(error),
              };
            }
          }
          await this.execute(this.kernel.dispatch(event).effects);
          break;
        }
        case "switch-network": {
          let event: KernelEvent;
          try {
            await window.ethereum!.request({
              method: "wallet_switchEthereumChain",
              params: [
                {
                  chainId: `0x${BigInt(this.client.deployment.chainId).toString(16)}`,
                },
              ],
            });
            event = {
              kind: "switched",
              request: effect.request,
              success: true,
              code: null,
              message: "",
            };
          } catch (error) {
            event = {
              kind: "switched",
              request: effect.request,
              success: false,
              code: transportErrorCode(error),
              message: errorMessage(error),
            };
          }
          await this.execute(this.kernel.dispatch(event).effects);
          break;
        }
        case "add-network": {
          let event: KernelEvent;
          try {
            await window.ethereum!.request({
              method: "wallet_addEthereumChain",
              params: [
                {
                  chainId: `0x${BigInt(this.client.deployment.chainId).toString(16)}`,
                  chainName: this.client.chain.name,
                  nativeCurrency: this.client.chain.nativeCurrency,
                  rpcUrls: [this.client.deployment.rpcUrl],
                },
              ],
            });
            event = {
              kind: "added",
              request: effect.request,
              success: true,
              code: null,
              message: "",
            };
          } catch (error) {
            event = {
              kind: "added",
              request: effect.request,
              success: false,
              code: transportErrorCode(error),
              message: errorMessage(error),
            };
          }
          await this.execute(this.kernel.dispatch(event).effects);
          break;
        }
      }
    }
  }
  read(source: WalletSource) {
    return this.observe(source, false);
  }
  private async observe(source: WalletSource, requestAccess: boolean) {
    if (source === "local") {
      const [accounts, chain] = await Promise.all([
        this.client.localAccounts(),
        this.client.rpc.request({ method: "eth_chainId" }),
      ]);
      return {
        accounts: accounts.map((address) => getAddress(address)),
        chain: BigInt(chain).toString(),
      };
    }
    const provider = window.ethereum;
    if (!provider) throw new Error("Browser wallet disconnected.");
    const [accounts, chain] = await Promise.all([
      provider.request({
        method: requestAccess ? "eth_requestAccounts" : "eth_accounts",
      }),
      provider.request({ method: "eth_chainId" }),
    ]);
    return {
      accounts: accounts.map((address) => getAddress(address)),
      chain: BigInt(chain).toString(),
    };
  }
}

export function useWallet(client: ExchangeClient) {
  const controller = useMemo(() => new WalletController(client), [client]);
  const view = useSyncExternalStore(
    controller.kernel.subscribe,
    controller.kernel.getSnapshot,
  );
  const wallet = view.wallet;
  const identityKey =
    wallet.kind === "ready" ? JSON.stringify(wallet.identity) : null;
  const session = useMemo<WalletSession | undefined>(() => {
    if (identityKey === null) return undefined;
    const identity: WalletIdentity = JSON.parse(identityKey);
    return {
      kind: identity.source,
      address: getAddress(identity.address),
      chainId: identity.chain,
      epoch: identity.epoch,
      walletClient: createWalletClient({
        account: getAddress(identity.address),
        chain: client.chain,
        transport:
          identity.source === "local"
            ? http(client.deployment.rpcUrl)
            : custom(window.ethereum!),
      }),
    };
  }, [client, identityKey]);
  useEffect(() => {
    const provider = window.ethereum;
    const invalidate = () => {
      controller.dispatch({ kind: "provider-changed", source: "injected" });
    };
    const disconnected = () => {
      controller.dispatch({
        kind: "provider-disconnected",
        source: "injected",
      });
    };
    provider?.on("accountsChanged", invalidate);
    provider?.on("chainChanged", invalidate);
    provider?.on("disconnect", disconnected);
    void controller.start();
    return () => {
      provider?.removeListener("accountsChanged", invalidate);
      provider?.removeListener("chainChanged", invalidate);
      provider?.removeListener("disconnect", disconnected);
      controller.stop();
    };
  }, [controller]);
  const state =
    wallet.kind === "ready"
      ? { kind: "ready" as const, session: session! }
      : wallet.kind === "connecting"
        ? { kind: "connecting" as const }
        : {
            kind: "unavailable" as const,
            source: wallet.source,
            reason: wallet.reason,
            message: wallet.message,
          };
  return {
    state,
    source: wallet.source,
    controller,
    view,
    selectLocal: (address: string) => {
      controller.dispatch({
        kind: "select-local",
        address: getAddress(address),
      });
    },
    connectInjected: () => {
      controller.dispatch({ kind: "connect-browser" });
    },
    switchNetwork: () => controller.switchNetwork(),
  };
}
