import "../generated/dex_logic.js";
import type {
  SimulationJob,
  SimulationOptions,
} from "../../../contracts/scripts/simulation-protocol";
export type SimulationDraft = {
  rounds: string;
  seed: string;
  duration: string;
  interval: string;
};
export type SimulationView = {
  data: SimulationJob | null;
  draft: SimulationDraft;
  canStart: boolean;
  canStop: boolean;
  canRefresh: boolean;
  active: boolean;
  busy: boolean;
  invalidOptions: boolean;
  error: string;
  uncertain: boolean;
};
export type SimulationEffect = { requestId: string } & (
  | { kind: "read" }
  | { kind: "start"; options: SimulationOptions }
  | { kind: "stop"; jobId: string }
);
export type SimulationEvent =
  | { type: "poll" | "start" | "stop" }
  | { type: "edit"; draft: SimulationDraft }
  | { type: "success"; requestId: string; data: SimulationJob }
  | { type: "failure"; requestId: string; error: string };
export type SimulationTransition = {
  view: SimulationView;
  effect: SimulationEffect | null;
  refreshAssets: boolean;
};
declare global {
  var DEXSimulation: {
    create(): { view(): string; dispatch(event: string): string };
  };
}
export class SimulationController {
  private readonly kernel = globalThis.DEXSimulation.create();
  view(): SimulationView {
    return JSON.parse(this.kernel.view());
  }
  dispatch(event: SimulationEvent): SimulationTransition {
    return JSON.parse(this.kernel.dispatch(JSON.stringify(event)));
  }
}
/** HTTP is an external effect. A rejected send may already have reached the server. */
export async function performSimulation(
  effect: SimulationEffect,
): Promise<SimulationJob> {
  const response = await fetch(
    `/api/simulation${effect.kind === "read" ? "" : `/${effect.kind}`}`,
    effect.kind === "read"
      ? { signal: AbortSignal.timeout(15000) }
      : {
          signal: AbortSignal.timeout(15000),
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            effect.kind === "start" ? effect.options : { jobId: effect.jobId },
          ),
        },
  );
  if (!response.headers.get("content-type")?.includes("json"))
    throw new Error(
      "Simulation service unavailable. Start npm run simulation:server in contracts.",
    );
  const value = (await response.json()) as SimulationJob & { error?: string };
  if (!response.ok)
    throw new Error(value.error ?? "Simulation request failed.");
  return value;
}
