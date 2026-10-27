import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ExchangeClient, type Writer } from "./client";
import { errorMessage, sameAddress } from "./amounts";
import {
  sessionIdentity,
  useWallet,
  type WalletSession,
} from "../wallet/session";
import { renderActivity } from "../wallet/kernel";
import type { JournalEntry, Token } from "./types";
import { AssetCatalog, catalogView } from "../logic/assets";

function useDexState(client: ExchangeClient) {
  const wallet = useWallet(client);
  const cache = useQueryClient();
  const registryKey = `twopool:v1:${client.key}:tokens`;
  const catalog = useMemo(() => {
    try {
      return new AssetCatalog(client.deployment.tokens, localStorage.getItem(registryKey) ?? "[]");
    } catch (error) {
      // DEFENSE: browser privacy settings can deny localStorage access.
      if (!(error instanceof DOMException)) throw error;
      const catalog = new AssetCatalog(client.deployment.tokens, "[]");
      catalog.storageError(`Token storage is unavailable: ${errorMessage(error)}`);
      return catalog;
    }
  }, [client, registryKey]);
  const catalogState = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const tokens = useMemo(() => catalogView(catalogState, []).tokens, [catalogState]);
  const registerTokens = useCallback((additions: Token[]) => {
    catalog.register(additions);
    try {
      localStorage.setItem(registryKey, JSON.stringify(catalogView(catalog.snapshot(), []).storedTokens));
    } catch (error) {
      // DEFENSE: a full browser quota or denied storage must not relabel a confirmed deployment as failed.
      if (!(error instanceof DOMException)) throw error;
      catalog.storageError(`Token metadata could not be saved: ${errorMessage(error)}`);
    }
  }, [catalog, registryKey]);
  const journal: JournalEntry[] = wallet.view.journal.map((entry) => {
    if (entry.state === "confirmed")
      return { ...entry, block: BigInt(entry.block), gas: BigInt(entry.gas) };
    if (entry.state === "failed")
      return {
        ...entry,
        block: entry.block === undefined ? undefined : BigInt(entry.block),
        gas: entry.gas === undefined ? undefined : BigInt(entry.gas),
      };
    return entry;
  });
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
  const catalogDisplay = catalogView(catalogState, snapshot.data?.pools ?? []);
  const unknownPoolTokens = catalogDisplay.discovery;
  const discoveries = useQueries({
    queries: unknownPoolTokens.map((address) => ({
      queryKey: ["token-metadata", client.deployment.rpcUrl, registryKey, address],
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
      await wallet.controller.perform(operation, () => {
        void cache.invalidateQueries({ queryKey: ["chain", client.key] });
      });
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
    catalogError: catalogDisplay.error,
    journal,
    history: wallet.view.history,
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
