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
import type { TransactionResponse } from "ethers";
import { ExchangeClient, type Writer } from "./client";
import { errorMessage, sameAddress } from "./amounts";
import { assertWalletSession, useWallet } from "../wallet/session";
import type { JournalEntry, Token } from "./types";

function useDexState(client: ExchangeClient) {
  const wallet = useWallet(client);
  const cache = useQueryClient();
  const registryKey = `twopool:v1:${client.key}:tokens`;
  const [customTokens, setCustomTokens] = useState<Token[]>(() =>
    JSON.parse(localStorage.getItem(registryKey) ?? "[]"),
  );
  const [journal, setJournal] = useState<JournalEntry[]>([]);
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
      tokens.map((token) => token.address).join(":"),
    ],
    queryFn: () => client.snapshot(session?.address, tokens),
    // Catalog discovery must not unmount a trade in progress. A changed wallet
    // still waits for its own balances instead of displaying the previous owner’s.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === session?.address ? previous : undefined,
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
    }) => {
      if (!session)
        throw new Error(
          "Connect a wallet on the correct network before submitting.",
        );
      const send = async (
        label: string,
        submit: () => Promise<TransactionResponse>,
      ) => {
        const id = crypto.randomUUID();
        const base = { id, label, account: session.address };
        const update = (entry: JournalEntry) =>
          setJournal((entries) =>
            entries.some((e) => e.id === id)
              ? entries.map((e) => (e.id === id ? entry : e))
              : [entry, ...entries],
          );
        update({ ...base, state: "awaiting-wallet" });
        let hash: string | undefined;
        try {
          await assertWalletSession(session, client.deployment.chainId);
          const transaction = await submit();
          hash = transaction.hash;
          update({ ...base, state: "submitted", hash });
          const receipt = await transaction.wait();
          if (!receipt || receipt.status !== 1)
            throw new Error("Transaction reverted on chain.");
          update({
            ...base,
            state: "confirmed",
            hash,
            block: receipt.blockNumber,
            gas: receipt.fee,
          });
          void cache.invalidateQueries({ queryKey: ["chain", client.key] });
          return receipt;
        } catch (error) {
          update({
            ...base,
            state: "failed",
            hash,
            message: errorMessage(error),
          });
          throw error;
        }
      };
      await operation.perform(client.writer(session, send));
    },
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["chain", client.key] });
    },
  });
  function operationStatus() {
    const latest = journal[0];
    if (mutation.isPending) {
      if (latest?.state === "awaiting-wallet")
        return `${latest.label}: confirm in wallet`;
      if (latest?.state === "submitted")
        return `${latest.label}: waiting for block confirmation`;
      return mutation.variables.label;
    }
    if (mutation.isError)
      return `Operation stopped: ${errorMessage(mutation.error)}`;
    if (latest?.state === "confirmed")
      return `${latest.label} confirmed in block ${latest.block}`;
    return `Connected to chain ${client.deployment.chainId}`;
  }
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
    status: operationStatus(),
    pending: mutation.isPending,
    run: (label: string, perform: (writer: Writer) => Promise<void>) =>
      mutation.mutate({ label, perform }),
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
