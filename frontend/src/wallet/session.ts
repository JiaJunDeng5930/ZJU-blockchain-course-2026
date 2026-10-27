import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  createWalletClient,
  custom,
  getAddress,
  http,
  keccak256,
  stringToHex,
  type Address,
  type EIP1193Provider,
  type WalletClient,
  BaseError,
  type Hex,
  type TransactionReceipt,
  TransactionReceiptNotFoundError,
} from "viem";
import type { ExchangeClient, Writer } from "../chain/client";
import { errorMessage } from "../chain/amounts";
import {
  WalletKernel,
  accepted,
  type KernelReply,
  type KernelEvent,
  type WalletEffect,
  type WalletIdentity,
  type WalletSource,
  type TransactionDescriptor,
  type ReceiptSearchEffect,
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
export class WalletController {
  readonly kernel: WalletKernel;
  private started = false;
  private preferenceKey: string;
  private storage: Storage | null = null;
  private storageFailure =
    "History is unavailable. New activity is kept only in this page.";
  private loadingHistory: Promise<void> | undefined;
  private observingReceipts = new Set<string>();
  constructor(
    readonly client: ExchangeClient,
    options?: { storage?: Storage | null },
  ) {
    this.preferenceKey = `twopool:wallet:${client.deployment.chainId}:${client.deployment.rpcUrl}`;
    let source: string | null = null,
      address: string | null = null;
    try {
      this.storage =
        options?.storage === undefined
          ? globalThis.localStorage
          : options.storage;
      source = this.storage?.getItem(this.preferenceKey) ?? null;
      address =
        this.storage?.getItem(`${this.preferenceKey}:local-address`) ?? null;
    } catch (error) {
      // DEFENSE: browser privacy settings can deny obtaining or reading localStorage.
      if (!(error instanceof DOMException)) throw error;
      this.storage = null;
      this.storageFailure = `History is unavailable. New activity is kept only in this page: ${error.message}`;
    }
    this.kernel = new WalletKernel({
      chain: client.deployment.chainId.toString(),
      source,
      address: address ? getAddress(address) : null,
      instance:
        typeof globalThis.crypto?.randomUUID === "function"
          ? globalThis.crypto.randomUUID()
          : null,
    });
  }
  dispatch<T = unknown>(event: KernelEvent): KernelReply<T> {
    let reply = this.kernel.dispatch<T>(event);
    const effects: WalletEffect[] = [];
    for (const effect of reply.effects) {
      if (effect.kind === "save-history")
        reply = this.persist(effect) as KernelReply<T>;
      else effects.push(effect);
    }
    void this.execute(effects);
    return { ...reply, effects };
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
  private persist(
    effect: Extract<WalletEffect, { kind: "save-history" }>,
  ): KernelReply {
    if (this.storage === null)
      return this.kernel.dispatch({
        kind: "history-save-failed",
        message: this.storageFailure,
      });
    try {
      this.storage.setItem(effect.key, effect.archive);
      return this.kernel.dispatch({ kind: "history-saved" });
    } catch (error) {
      // DEFENSE: browser privacy settings and quota limits can reject an archive write.
      if (!(error instanceof DOMException)) throw error;
      return this.kernel.dispatch({
        kind: "history-save-failed",
        message: `New activity is kept only in this page because history could not be saved: ${error.message}`,
      });
    }
  }
  private loadHistory(): Promise<void> {
    if (this.loadingHistory) return this.loadingHistory;
    this.loadingHistory = this.readHistory().finally(() => {
      this.loadingHistory = undefined;
    });
    return this.loadingHistory;
  }
  private async readHistory(): Promise<void> {
    let key = "";
    let genesis;
    try {
      genesis = await this.client.rpc.getBlock({ blockNumber: 0n });
    } catch (error) {
      // DEFENSE: an unavailable RPC cannot identify which chain owns saved activity.
      this.dispatch({
        kind: "history-load-failed",
        key,
        message: `History could not be loaded. New activity is kept only in this page: ${errorMessage(error)}`,
      });
      return;
    }
    key = this.kernel.historyKey(
      genesis.hash,
      this.client.key,
      keccak256(stringToHex(this.client.deployment.rpcUrl)),
    );
    if (this.storage === null) {
      this.dispatch({
        kind: "history-load-failed",
        key,
        message: this.storageFailure,
      });
      return;
    }
    try {
      const snapshots: { owner: string; archive: string }[] = [];
      const prefix = `${key}:`;
      const keys = Array.from({ length: this.storage.length }, (_, index) =>
        this.storage!.key(index),
      );
      for (const storedKey of keys) {
        if (storedKey !== null && storedKey.startsWith(prefix)) {
          const archive = this.storage.getItem(storedKey);
          // DEFENSE: another tab can remove a key between enumeration and this read.
          if (archive !== null)
            snapshots.push({ owner: storedKey.slice(prefix.length), archive });
        }
      }
      this.dispatch({ kind: "history-loaded", key, snapshots });
    } catch (error) {
      // DEFENSE: browsers can deny Storage reads even when the Storage object exists.
      if (!(error instanceof DOMException)) throw error;
      this.dispatch({
        kind: "history-load-failed",
        key,
        message: `History could not be loaded. New activity is kept only in this page: ${error.message}`,
      });
    }
  }
  private transactionDescriptor(
    transaction: {
      hash: Hex;
      from: Address;
      nonce: number;
      to: Address | null;
      input: Hex;
      value: bigint;
      blockNumber?: bigint | null;
    },
    observedBlock: bigint,
  ): TransactionDescriptor {
    return {
      hash: transaction.hash.toLowerCase(),
      from: getAddress(transaction.from),
      nonce: transaction.nonce.toString(),
      to: transaction.to === null ? null : getAddress(transaction.to),
      input: transaction.input.toLowerCase(),
      value: transaction.value.toString(),
      observedBlock: (transaction.blockNumber ?? observedBlock).toString(),
    };
  }
  private replacementObserved(
    target: { instance: string | null; transaction: string },
    original: TransactionDescriptor,
    candidate: TransactionDescriptor,
    receipt: TransactionReceipt,
  ) {
    this.dispatch({
      kind: "transaction-replaced",
      ...target,
      original,
      candidate,
      hash: receipt.transactionHash.toLowerCase(),
      sender: getAddress(receipt.from),
      status: receipt.status,
      block: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      gasPrice: receipt.effectiveGasPrice.toString(),
    });
  }
  private async waitForRecordedReceipt(target: {
    instance: string | null;
    transaction: string;
    hash: Hex;
  }): Promise<TransactionReceipt> {
    const { rpc } = this.client;
    let observation:
      | {
          transaction: Awaited<ReturnType<typeof rpc.getTransaction>>;
          block: bigint;
        }
      | undefined;
    try {
      const transaction = await rpc.getTransaction({ hash: target.hash });
      observation = {
        transaction,
        block: transaction.blockNumber ?? (await rpc.getBlockNumber()),
      };
    } catch (error) {
      // DEFENSE: a node can omit a replaced hash or reject its metadata read while its saved nonce remains usable.
      this.dispatch({
        kind: "transaction-metadata-unavailable",
        instance: target.instance,
        transaction: target.transaction,
        message: `Transaction details are unavailable; checking the known hash and any saved nonce. ${errorMessage(error)}`,
      });
    }
    if (observation) {
      this.dispatch({
        kind: "transaction-described",
        instance: target.instance,
        transaction: target.transaction,
        descriptor: this.transactionDescriptor(
          observation.transaction,
          observation.block,
        ),
      });
    }
    try {
      return await rpc.getTransactionReceipt({ hash: target.hash });
    } catch (error) {
      // DEFENSE: an unmined or replaced hash has no receipt; unrelated RPC failures remain errors.
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    }
    const search = this.kernel.receiptSearch(
      target.instance,
      target.transaction,
      await rpc.getBlockNumber(),
    );
    const command = (event: object): ReceiptSearchEffect =>
      JSON.parse(search.command(JSON.stringify(event)));
    const nativeWait = () =>
      rpc.waitForTransactionReceipt({
        hash: target.hash,
        timeout: Number(search.timeoutMs),
        onReplaced: ({
          replacedTransaction,
          transaction,
          transactionReceipt,
        }) => {
          this.replacementObserved(
            target,
            this.transactionDescriptor(
              replacedTransaction,
              transactionReceipt.blockNumber,
            ),
            this.transactionDescriptor(
              transaction,
              transactionReceipt.blockNumber,
            ),
            transactionReceipt,
          );
        },
      });
    let request: ReceiptSearchEffect = JSON.parse(search.view());
    if (request.kind === "original") return nativeWait();
    let releaseHead: () => void = () => {};
    let rejectHead: ((error: Error) => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = async (): Promise<TransactionReceipt> => {
      for (;;) {
        switch (request.kind) {
          case "nonce": {
            try {
              const count = await rpc.getTransactionCount({
                address: getAddress(request.owner),
                blockNumber: BigInt(request.block),
              });
              request = command({
                kind: "nonce",
                block: request.block,
                count: count.toString(),
              });
            } catch (error) {
              request = command({
                kind: "failed",
                message: errorMessage(error),
              });
            }
            break;
          }
          case "block": {
            try {
              const block = await rpc.getBlock({
                blockNumber: BigInt(request.block),
                includeTransactions: true,
              });
              request = command({
                kind: "block",
                block: request.block,
                transactions: block.transactions.map((transaction) =>
                  this.transactionDescriptor(transaction, block.number),
                ),
              });
            } catch (error) {
              request = command({
                kind: "failed",
                message: errorMessage(error),
              });
            }
            break;
          }
          case "waiting": {
            request = await new Promise<ReceiptSearchEffect>(
              (resolve, reject) => {
                rejectHead = reject;
                const unwatch = rpc.watchBlockNumber({
                  emitOnBegin: true,
                  onBlockNumber: (block) => {
                    const next = command({
                      kind: "head",
                      block: block.toString(),
                    });
                    if (next.kind !== "waiting") {
                      unwatch();
                      releaseHead = () => {};
                      rejectHead = undefined;
                      resolve(next);
                    }
                  },
                  onError: (error) => {
                    unwatch();
                    releaseHead = () => {};
                    rejectHead = undefined;
                    reject(error);
                  },
                });
                releaseHead = unwatch;
              },
            );
            break;
          }
          case "receipt":
            return rpc.getTransactionReceipt({
              hash: request.candidate.hash as Hex,
            });
          case "replacement": {
            const receipt = await rpc.getTransactionReceipt({
              hash: request.candidate.hash as Hex,
            });
            // DEFENSE: a receipt RPC may finish after the observation timeout.
            const current: ReceiptSearchEffect = JSON.parse(search.view());
            if (current.kind === "unavailable")
              throw new Error(current.message);
            this.replacementObserved(
              target,
              request.original,
              request.candidate,
              receipt,
            );
            return receipt;
          }
          case "original":
            return nativeWait();
          case "unavailable":
            throw new Error(request.message);
        }
      }
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const effect = command({ kind: "expired" }) as Extract<
          ReceiptSearchEffect,
          { kind: "unavailable" }
        >;
        const error = new Error(effect.message);
        releaseHead();
        rejectHead?.(error);
        reject(error);
      }, Number(search.timeoutMs));
    });
    try {
      return await Promise.race([work(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      releaseHead();
    }
  }
  private async observeReceipt(
    effect: Extract<WalletEffect, { kind: "observe-receipt" }>,
  ): Promise<void> {
    const key = `${effect.instance}:${effect.transaction}`;
    // DEFENSE: recheck can be requested while the same saved hash is already being polled.
    if (this.observingReceipts.has(key)) return;
    this.observingReceipts.add(key);
    try {
      let receipt: TransactionReceipt;
      try {
        receipt = await this.waitForRecordedReceipt({
          instance: effect.instance,
          transaction: effect.transaction,
          hash: effect.hash as Hex,
        });
      } catch (error) {
        // DEFENSE: a saved hash may remain unmined, be absent after a chain reset, or have an unavailable RPC.
        this.dispatch({
          kind: "history-observation-failed",
          instance: effect.instance,
          transaction: effect.transaction,
          message: errorMessage(error),
        });
        return;
      }
      this.dispatch({
        kind: "history-receipt",
        instance: effect.instance,
        transaction: effect.transaction,
        hash: receipt.transactionHash.toLowerCase(),
        sender: getAddress(receipt.from),
        status: receipt.status,
        block: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        gasPrice: receipt.effectiveGasPrice.toString(),
      });
    } finally {
      this.observingReceipts.delete(key);
    }
  }
  session(): WalletSession | undefined {
    const wallet = this.kernel.getSnapshot().wallet;
    return wallet.kind === "ready"
      ? createSession(this.client, wallet.identity)
      : undefined;
  }
  async perform(
    operation: {
      label: string;
      perform: (writer: Writer) => Promise<unknown>;
      session: WalletSession | undefined;
    },
    onReceipt?: () => void,
  ): Promise<void> {
    const client = this.client;
    const captured = operation.session;
    const context = accepted<string>(
      this.dispatch({
        kind: "begin-operation",
        label: operation.label,
        identity: captured ? sessionIdentity(captured) : null,
      }),
    );
    const send = async (
      label: string,
      submit: () => Promise<Hex>,
      authority?: { kind: "dev-faucet"; sender: `0x${string}` },
    ): Promise<TransactionReceipt> => {
      const transaction = accepted<string>(
        this.dispatch({
          kind: "request-write",
          operation: context,
          label,
          authority: authority ?? null,
        }),
      );
      try {
        const observation = await this.read(captured!.kind);
        accepted(
          this.dispatch({
            kind: "authorize",
            operation: context,
            transaction,
            ...observation,
          }),
        );
      } catch (error) {
        this.dispatch({
          kind: "preflight-failed",
          transaction,
          message: errorMessage(error),
        });
        throw error;
      }
      let hash: Hex;
      try {
        hash = await submit();
      } catch (error) {
        this.dispatch({
          kind: "signature-failed",
          transaction,
          code: transportErrorCode(error),
          message: errorMessage(error),
        });
        throw error;
      }
      this.dispatch({
        kind: "broadcast",
        transaction,
        hash: hash.toLowerCase(),
      });
      let receipt: TransactionReceipt;
      try {
        receipt = await this.waitForRecordedReceipt({
          instance: null,
          transaction,
          hash,
        });
      } catch (error) {
        this.dispatch({
          kind: "receipt-unavailable",
          transaction,
          message: errorMessage(error),
        });
        throw error;
      }
      accepted(
        this.dispatch({
          kind: "receipt",
          transaction,
          hash: receipt.transactionHash.toLowerCase(),
          sender: getAddress(receipt.from),
          status: receipt.status,
          block: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          gasPrice: receipt.effectiveGasPrice.toString(),
        }),
      );
      onReceipt?.();
      return receipt;
    };
    try {
      // Accepted begin-operation witnesses that the captured identity exists and is current.
      await operation.perform(client.writer(captured!, send));
      this.dispatch({
        kind: "finish-operation",
        operation: context,
        error: null,
      });
    } catch (error) {
      this.dispatch({
        kind: "finish-operation",
        operation: context,
        error: errorMessage(error),
      });
      throw error;
    }
  }
  private async execute(effects: WalletEffect[]): Promise<void> {
    for (const effect of effects) {
      switch (effect.kind) {
        case "persist":
          try {
            this.storage?.setItem(this.preferenceKey, effect.preference.source);
            if (effect.preference.address !== null)
              this.storage?.setItem(
                `${this.preferenceKey}:local-address`,
                effect.preference.address,
              );
          } catch (error) {
            // DEFENSE: a denied preference write must not interrupt a wallet observation.
            if (!(error instanceof DOMException)) throw error;
            this.dispatch({
              kind: "history-preference-warning",
              message: `Wallet selection could not be saved: ${error.message}`,
            });
          }
          break;
        case "save-history":
          this.persist(effect);
          break;
        case "load-history":
          await this.loadHistory();
          break;
        case "observe-receipt":
          void this.observeReceipt(effect);
          break;
        case "observe": {
          let event: KernelEvent;
          if (effect.source === "injected" && !globalThis.window?.ethereum) {
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

function createSession(
  client: ExchangeClient,
  identity: WalletIdentity,
): WalletSession {
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
    return createSession(client, JSON.parse(identityKey));
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
