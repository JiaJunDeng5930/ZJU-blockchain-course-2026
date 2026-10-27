import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getAddress, type Hex, type TransactionReceipt } from "viem";
import { ExchangeClient, type Writer } from "./client";
import { errorMessage, sameAddress } from "./amounts";
import {
  sessionIdentity,
  transportErrorCode,
  useWallet,
  type WalletSession,
} from "../wallet/session";
import { accepted, renderActivity } from "../wallet/kernel";
import type { JournalEntry, Token } from "./types";

function useDexState(client: ExchangeClient) {
  const wallet = useWallet(client);
  const cache = useQueryClient();
  const registryKey = `twopool:v1:${client.key}:tokens`;
  const [customTokens, setCustomTokens] = useState<Token[]>(() =>
    JSON.parse(localStorage.getItem(registryKey) ?? "[]"),
  );
  const journal: JournalEntry[] = wallet.view.journal.map((entry) => {
    if (entry.state === "confirmed")
      return { ...entry, block: BigInt(entry.block), gas: BigInt(entry.gas) };
    return entry;
  });
  const tokens = useMemo(
    () => [...client.deployment.tokens, ...customTokens],
    [client, customTokens],
  );
  const registerTokens = useCallback(
    (additions: Token[]) => {
      setCustomTokens((current) => {
        const known = [...client.deployment.tokens, ...current];
        const added = additions.filter(
          (token) =>
            !known.some((existing) =>
              sameAddress(existing.address, token.address),
            ),
        );
        if (added.length === 0) return current;
        const next = [...current, ...added];
        localStorage.setItem(registryKey, JSON.stringify(next));
        return next;
      });
    },
    [client, registryKey],
  );
  const session =
    wallet.state.kind === "ready" ? wallet.state.session : undefined;
  const accounts = useQuery({
    queryKey: ["accounts", client.key],
    queryFn: () => client.localAccounts(),
    staleTime: Infinity,
  });
  const snapshot = useQuery({
    queryKey: [
      "chain",
      client.key,
      session?.address,
      session?.epoch,
      tokens.map((token) => token.address).join(":"),
    ],
    queryFn: async () => ({
      ...(await client.snapshot(session?.address, tokens)),
      identity: session ? sessionIdentity(session) : null,
    }),
    // Catalog discovery must not unmount a trade in progress. A changed wallet
    // still waits for its own balances instead of displaying the previous owner’s.
    placeholderData: (previous) =>
      wallet.controller.kernel.retainsSnapshot(previous?.identity ?? null)
        ? previous
        : undefined,
    refetchInterval: 5000,
  });
  const unknownPoolTokens = [
    ...new Set(
      (snapshot.data?.pools ?? [])
        .flatMap((pool) => [pool.token0, pool.token1])
        .map((address) => address.toLowerCase()),
    ),
  ].filter(
    (address) => !tokens.some((token) => sameAddress(token.address, address)),
  );
  const discoveries = useQueries({
    queries: unknownPoolTokens.map((address) => ({
      queryKey: ["token-metadata", client.key, address],
      queryFn: () => client.importToken(address),
      staleTime: Infinity,
      // DEFENSE: permissionless pools can contain tokens without supported metadata;
      // keep their address visible without blocking other markets or retrying reads.
      retry: false,
      retryOnMount: false,
      refetchOnWindowFocus: false,
    })),
  });
  useEffect(() => {
    const found = discoveries.flatMap((query) =>
      query.data ? [query.data] : [],
    );
    if (found.length) registerTokens(found);
  }, [discoveries, registerTokens]);
  const mutation = useMutation({
    mutationFn: async (operation: {
      label: string;
      perform: (writer: Writer) => Promise<void>;
      session: WalletSession | undefined;
    }) => {
      const captured = operation.session;
      const context = accepted<string>(
        wallet.controller.dispatch({
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
          wallet.controller.dispatch({
            kind: "request-write",
            operation: context,
            label,
            authority: authority ?? null,
          }),
        );
        try {
          const observation = await wallet.controller.read(captured!.kind);
          accepted(
            wallet.controller.dispatch({
              kind: "authorize",
              operation: context,
              transaction,
              ...observation,
            }),
          );
        } catch (error) {
          wallet.controller.dispatch({
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
          wallet.controller.dispatch({
            kind: "signature-failed",
            transaction,
            code: transportErrorCode(error),
            message: errorMessage(error),
          });
          throw error;
        }
        wallet.controller.dispatch({ kind: "broadcast", transaction, hash });
        let receipt: TransactionReceipt;
        try {
          receipt = await client.rpc.waitForTransactionReceipt({ hash });
        } catch (error) {
          wallet.controller.dispatch({
            kind: "receipt-unavailable",
            transaction,
            message: errorMessage(error),
          });
          throw error;
        }
        accepted(
          wallet.controller.dispatch({
            kind: "receipt",
            transaction,
            hash: receipt.transactionHash,
            sender: getAddress(receipt.from),
            status: receipt.status,
            block: receipt.blockNumber.toString(),
            gasUsed: receipt.gasUsed.toString(),
            gasPrice: receipt.effectiveGasPrice.toString(),
          }),
        );
        void cache.invalidateQueries({ queryKey: ["chain", client.key] });
        return receipt;
      };
      try {
        // Accepted begin-operation witnesses that the captured identity exists and is current.
        await operation.perform(client.writer(captured!, send));
        wallet.controller.dispatch({
          kind: "finish-operation",
          operation: context,
          error: null,
        });
      } catch (error) {
        wallet.controller.dispatch({
          kind: "finish-operation",
          operation: context,
          error: errorMessage(error),
        });
        throw error;
      }
    },
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["chain", client.key] });
    },
  });
  function registerToken(token: Token) {
    registerTokens([token]);
  }
  return {
    client,
    wallet,
    session,
    accounts,
    snapshot,
    tokens,
    journal,
    status: renderActivity(wallet.view.activity, client.deployment.chainId),
    pending: wallet.view.pending,
    run: (label: string, perform: (writer: Writer) => Promise<void>) =>
      mutation.mutate({ label, perform, session }),
    registerToken,
    symbol: (address: string) =>
      tokens.find((t) => sameAddress(t.address, address))?.symbol ??
      `${address.slice(0, 6)}…${address.slice(-4)}`,
    refresh: () => cache.invalidateQueries({ queryKey: ["chain", client.key] }),
  };
}
type DexState = ReturnType<typeof useDexState>;
const DexContext = createContext<DexState | null>(null);
export function DexProvider({
  client,
  children,
}: {
  client: ExchangeClient;
  children: ReactNode;
}) {
  const state = useDexState(client);
  return <DexContext.Provider value={state}>{children}</DexContext.Provider>;
}
export function useDex() {
  const context = useContext(DexContext);
  if (!context) throw new Error("useDex requires DexProvider.");
  return context;
}
