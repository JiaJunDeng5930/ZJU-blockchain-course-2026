import { createContext, useContext, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  const tokens = [...client.deployment.tokens, ...customTokens];
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
    refetchInterval: 5000,
  });
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
    if (tokens.some((existing) => sameAddress(existing.address, token.address)))
      return;
    const next = [...customTokens, token];
    localStorage.setItem(registryKey, JSON.stringify(next));
    setCustomTokens(next);
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
