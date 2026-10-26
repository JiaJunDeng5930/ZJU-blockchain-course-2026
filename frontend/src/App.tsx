import { useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { ExchangeClient } from "./chain/client";
import { DexProvider, useDex } from "./chain/DexProvider";
import type { Deployment } from "./chain/types";
import { poolKey } from "./chain/amounts";
import { WalletBar } from "./components/WalletBar";
import { PoolSelector } from "./components/PoolSelector";
import { SwapPage } from "./features/SwapPage";
import { LiquidityPage } from "./features/LiquidityPage";
import { PoolsPage } from "./features/PoolsPage";
import { ArbitragePage } from "./features/ArbitragePage";
import { TransactionsPage } from "./features/TransactionsPage";
import "./App.css";

const queries = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 2000, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});
const pages = [
  "Swap",
  "Liquidity",
  "Pools & tokens",
  "Arbitrage",
  "Transactions",
] as const;
type Page = (typeof pages)[number];
export default function App() {
  return (
    <QueryClientProvider client={queries}>
      <Bootstrap />
    </QueryClientProvider>
  );
}
function Bootstrap() {
  const deployment = useQuery({
    queryKey: ["deployment"],
    queryFn: async () => {
      const response = await fetch(
        `${import.meta.env.BASE_URL}deployment.json`,
        { cache: "no-store" },
      );
      if (
        !response.ok ||
        !response.headers.get("content-type")?.includes("json")
      )
        throw new Error(
          "Deployment file missing. Start the node and run npm run deploy in contracts.",
        );
      const config: Deployment = await response.json();
      if (config.schemaVersion !== 1)
        throw new Error(
          "Deployment format is outdated. Run npm run deploy again.",
        );
      const client = new ExchangeClient(config);
      await client.verifyDeployment();
      return client;
    },
    staleTime: Infinity,
  });
  if (!deployment.data)
    return (
      <main className="loading">
        <h1>TwoPool DEX</h1>
        {deployment.error ? (
          <>
            <p role="alert">{deployment.error.message}</p>
            <pre>
              cd contracts{`\n`}npm run node{`\n`}# another terminal{`\n`}npm
              run deploy
            </pre>
            <button
              onClick={() => {
                void deployment.refetch();
              }}
            >
              Retry connection
            </button>
          </>
        ) : (
          <p role="status">Connecting to deployment…</p>
        )}
      </main>
    );
  return (
    <DexProvider client={deployment.data}>
      <Workspace />
    </DexProvider>
  );
}
function Workspace() {
  const { client, snapshot, status, pending, journal } = useDex();
  const [page, setPage] = useState<Page>("Swap");
  const [selection, setSelection] = useState("");
  const pool =
    snapshot.data?.pools.find((p) => poolKey(p) === selection) ??
    snapshot.data?.pools[0];
  const poolPage =
    page === "Swap" || page === "Liquidity" || page === "Arbitrage";
  return (
    <div className="shell">
      <header>
        <div>
          <h1>TwoPool DEX</h1>
          <p>
            Harbor / Summit · Local Ethereum · Chain {client.deployment.chainId}
          </p>
        </div>
        <small>0.3% trading fee · ERC721 liquidity positions</small>
      </header>
      <WalletBar />
      <div className="operation-status">
        <p role="status" aria-live="polite">
          {status}
        </p>
        {pending && (
          <small>
            You can inspect the transaction journal while confirmation is
            pending.
          </small>
        )}
      </div>
      {snapshot.error && (
        <p role="alert" className="read-error">
          Chain data refresh failed: {snapshot.error.message}. Confirmed
          transaction records remain available.
        </p>
      )}
      <nav aria-label="Workspace">
        {pages.map((label) => (
          <button
            key={label}
            className={label === page ? "active" : ""}
            aria-current={label === page ? "page" : undefined}
            onClick={() => setPage(label)}
          >
            {label}
            {label === "Transactions" && journal.length
              ? ` (${journal.length})`
              : ""}
          </button>
        ))}
      </nav>
      {poolPage && <PoolSelector pool={pool} onChange={setSelection} />}
      {page === "Transactions" ? (
        <TransactionsPage />
      ) : !snapshot.data ? (
        <p role="status">Reading chain data…</p>
      ) : page === "Pools & tokens" ? (
        <PoolsPage
          onSelect={(next) => {
            setSelection(poolKey(next));
            setPage("Swap");
          }}
        />
      ) : !pool ? (
        <p>Create a pool in Pools & tokens to begin.</p>
      ) : page === "Swap" ? (
        <SwapPage key={poolKey(pool)} pool={pool} />
      ) : page === "Liquidity" ? (
        <LiquidityPage key={poolKey(pool)} pool={pool} />
      ) : (
        <ArbitragePage key={poolKey(pool)} pool={pool} />
      )}
      <footer>
        Local teaching network · Test tokens have no monetary value · Token
        profit excludes ETH gas costs
      </footer>
    </div>
  );
}
