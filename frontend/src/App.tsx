import { useEffect, useRef, useState } from "react";
import { BrowserRouter, useSearchParams } from "react-router-dom";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createChainQueryClient } from "./chain/queryClient";
import { ExchangeClient } from "./chain/client";
import { DexProvider, useDex } from "./chain/DexProvider";
import { HistoryStatus } from "./components/HistoryStatus";
import { ChainDataStatus } from "./components/ChainDataStatus";
import type { Deployment } from "./chain/types";
import { poolKey } from "./chain/amounts";
import { resolvePoolSelection } from "./logic/poolSelection";
import { WalletMenu } from "./components/WalletMenu";
import { PoolSelector } from "./components/PoolSelector";
import { SwapPage } from "./features/SwapPage";
import { LiquidityPage } from "./features/LiquidityPage";
import { PoolsPage } from "./features/PoolsPage";
import { ArbitragePage } from "./features/ArbitragePage";
import { SimulationPage } from "./features/SimulationPage";
import { AllowancesPage } from "./features/AllowancesPage";
import { TransactionsPage } from "./features/TransactionsPage";
import type { Pool } from "./chain/types";
import "./App.css";

const queries = createChainQueryClient();
const workspaces = [
  { name: "Swap", route: "swap" },
  { name: "Liquidity", route: "liquidity" },
  { name: "Pools & tokens", route: "tokens" },
  { name: "Arbitrage", route: "arbitrage" },
  { name: "Simulation", route: "simulation" },
  { name: "Transactions", route: "activity" },
  { name: "Token approvals", route: "approvals" },
] as const;
type WorkspaceName = (typeof workspaces)[number]["name"];
export default function App() {
  return (
    <BrowserRouter>
      <QueryClientProvider client={queries}>
        <Bootstrap />
      </QueryClientProvider>
    </BrowserRouter>
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
          "Deployment file missing. Start the local app with npm run dev from the repository root.",
        );
      const config: Deployment = await response.json();
      if (config.schemaVersion !== 1)
        throw new Error(
          "The deployment file needs updating. Run npm run deploy in contracts.",
        );
      const client = new ExchangeClient(config);
      await client.verifyDeployment();
      return client;
    },
    staleTime: Infinity,
  });
  if (!deployment.data)
    return (
      <main className="connection-screen">
        <a className="wordmark" href="/">
          twopool<span>↗</span>
        </a>
        {deployment.error ? (
          <>
            <h1>Local network unavailable</h1>
            <p role="alert">{deployment.error.message}</p>
            <button
              className="button-primary"
              disabled={deployment.isFetching}
              onClick={() => {
                void deployment.refetch();
              }}
            >
              {deployment.isFetching ? "Connecting…" : "Retry connection"}
            </button>
          </>
        ) : (
          <p role="status">Connecting to your local exchange…</p>
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
  const { snapshot, history } = useDex();
  const [search, setSearch] = useSearchParams();
  const [walletOpen, setWalletOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  // History navigation must not carry an open position form to a different pool.
  const [creatingPositionFor, setCreatingPositionFor] = useState<string>();
  const tools = useRef<HTMLDivElement>(null);
  const toolsButton = useRef<HTMLButtonElement>(null);
  const page =
    workspaces.find((workspace) => workspace.route === search.get("view"))
      ?.name ?? "Swap";
  const selected = search.get("pool");
  const selection = resolvePoolSelection(selected, snapshot.data?.pools ?? []);
  const pool = selection.kind === "selected" ? selection.pool : undefined;
  function goTo(name: WorkspaceName, nextPool?: string) {
    const route = workspaces.find(
      (workspace) => workspace.name === name,
    )!.route;
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      next.set("view", route);
      if (nextPool !== undefined) next.set("pool", nextPool);
      return next;
    });
    setToolsOpen(false);
    setWalletOpen(false);
    setCreatingPositionFor(undefined);
  }
  function provideLiquidity(next: Pool) {
    goTo("Liquidity", poolKey(next));
    setCreatingPositionFor(poolKey(next));
  }
  function selectPool(key: string) {
    setCreatingPositionFor(undefined);
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      next.set("pool", key);
      return next;
    });
  }
  function selectDefaultPool() {
    setCreatingPositionFor(undefined);
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      next.delete("pool");
      return next;
    });
  }
  useEffect(() => {
    if (!toolsOpen) return;
    function outside(event: PointerEvent) {
      if (!tools.current?.contains(event.target as Node)) setToolsOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [toolsOpen]);
  return (
    <div className="app-shell">
      <header className="app-header">
        <a
          className="wordmark"
          href="?view=swap"
          onClick={(event) => {
            event.preventDefault();
            goTo("Swap");
          }}
        >
          twopool<span>↗</span>
        </a>
        <nav className="primary-nav" aria-label="Workspace">
          <button
            className={page === "Swap" ? "active" : ""}
            aria-current={page === "Swap" ? "page" : undefined}
            onClick={() => goTo("Swap")}
          >
            Swap
          </button>
          <button
            className={page === "Liquidity" ? "active" : ""}
            aria-current={page === "Liquidity" ? "page" : undefined}
            onClick={() => goTo("Liquidity")}
          >
            Liquidity
          </button>
          <div className="tools-navigation" ref={tools}>
            <button
              ref={toolsButton}
              className={
                page !== "Swap" && page !== "Liquidity" ? "active" : ""
              }
              aria-haspopup="menu"
              aria-expanded={toolsOpen}
              onClick={() => setToolsOpen(!toolsOpen)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setToolsOpen(true);
                  requestAnimationFrame(() =>
                    tools.current
                      ?.querySelector<HTMLButtonElement>("[role=menuitem]")
                      ?.focus(),
                  );
                }
              }}
            >
              Tools <span aria-hidden="true">⌄</span>
            </button>
            {toolsOpen && (
              <div
                className="tools-menu"
                role="menu"
                aria-label="Tools"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setToolsOpen(false);
                    toolsButton.current?.focus();
                    return;
                  }
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp")
                    return;
                  event.preventDefault();
                  const items = [
                    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      "[role=menuitem]",
                    ),
                  ];
                  const index = items.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  items[
                    (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      items.length) %
                      items.length
                  ]?.focus();
                }}
              >
                {workspaces.slice(2).map((workspace) => (
                  <button
                    key={workspace.route}
                    role="menuitem"
                    onClick={() => goTo(workspace.name)}
                  >
                    {workspace.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </nav>
        <WalletMenu
          open={walletOpen}
          onOpen={() => setWalletOpen(true)}
          onClose={() => setWalletOpen(false)}
        />
      </header>
      <main
        className={`workspace-content ${page === "Swap" ? "swap-workspace" : "tool-workspace"}`}
      >
        {page !== "Transactions" && <HistoryStatus history={history} quiet />}
        <ChainDataStatus />
        {page === "Simulation" ? (
          <SimulationPage />
        ) : page === "Token approvals" ? (
          <AllowancesPage />
        ) : page === "Transactions" ? (
          <TransactionsPage onProvideLiquidity={provideLiquidity} />
        ) : !snapshot.data ? (
          <div
            className="workspace-loading"
            role={snapshot.error ? undefined : "status"}
          >
            {snapshot.error
              ? "No market snapshot is available. Use Refresh above to try again."
              : "Loading markets…"}
          </div>
        ) : page === "Pools & tokens" ? (
          <PoolsPage
            onSelect={(next) => goTo("Swap", poolKey(next))}
            onProvideLiquidity={provideLiquidity}
          />
        ) : selection.kind === "missing" ? (
          <section className="empty-state missing-pool">
            <h1>Requested pool unavailable</h1>
            <p>
              This target is not present in the market snapshot at block{" "}
              {snapshot.data.block}. Refresh chain data above to check again, or
              choose a pool from this deployment.
            </p>
            <code className="missing-pool-key">
              {selection.requested || "(empty pool parameter)"}
            </code>
            <PoolSelector pool={undefined} onChange={selectPool} />
            <button className="button-primary" onClick={selectDefaultPool}>
              Use default pool
            </button>
          </section>
        ) : !pool ? (
          <section className="empty-state">
            <h1>No pools yet</h1>
            <p>Create a token pair to start trading.</p>
            <button
              className="button-primary"
              onClick={() => goTo("Pools & tokens")}
            >
              Create a pool
            </button>
          </section>
        ) : page === "Swap" ? (
          <SwapPage
            key={`${pool.token0}:${pool.token1}`}
            pool={pool}
            onPoolChange={selectPool}
            onOpenWallet={() => setWalletOpen(true)}
          />
        ) : page === "Liquidity" ? (
          <LiquidityPage
            key={poolKey(pool)}
            pool={pool}
            creating={creatingPositionFor === poolKey(pool)}
            onCreatingChange={(creating) =>
              setCreatingPositionFor(creating ? poolKey(pool) : undefined)
            }
          />
        ) : (
          <>
            <div className="tool-page-heading">
              <h1>Arbitrage</h1>
            </div>
            <PoolSelector pool={pool} onChange={selectPool} />
            <ArbitragePage
              key={poolKey(pool)}
              pool={pool}
              onOpenSimulation={() => goTo("Simulation")}
            />
          </>
        )}
      </main>
      <TransactionNotice onOpenActivity={() => goTo("Transactions")} />
    </div>
  );
}
function TransactionNotice({ onOpenActivity }: { onOpenActivity: () => void }) {
  const { journal, status, pending } = useDex();
  const latest = journal[0];
  const [dismissed, setDismissed] = useState<string>();
  const key = latest ? `${latest.id}:${latest.state}` : undefined;
  useEffect(() => {
    if (!key || pending || latest?.state !== "confirmed") return;
    const timer = setTimeout(() => setDismissed(key), 8000);
    return () => clearTimeout(timer);
  }, [key, pending, latest?.state]);
  if (!latest || dismissed === key) return null;
  return (
    <aside
      className={`transaction-notice${latest.state === "failed" || latest.state === "submission-unknown" ? " transaction-error" : ""}`}
    >
      <p role="status" aria-live="polite">
        {status}
      </p>
      <button className="text" onClick={onOpenActivity}>
        View activity
      </button>
      {!pending && (
        <button
          className="notice-dismiss"
          aria-label="Dismiss notification"
          onClick={() => setDismissed(key)}
        >
          ×
        </button>
      )}
    </aside>
  );
}
