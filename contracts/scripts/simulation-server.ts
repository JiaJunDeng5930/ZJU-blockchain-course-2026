import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  SimulationJob,
  SimulationMessage,
  SimulationOptions,
  SimulationReport,
} from "./simulation-protocol.js";

const port = Number(process.env.SIMULATION_PORT ?? 8787);
const workerPath = fileURLToPath(new URL("./simulate.ts", import.meta.url));
const reportPath = fileURLToPath(
  new URL("../../shared/simulation-report.json", import.meta.url),
);
const webPort = Number(process.env.DEX_WEB_PORT ?? 3000);
const allowedOrigins = new Set([
  `http://127.0.0.1:${webPort}`,
  `http://localhost:${webPort}`,
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
]);
let worker: ChildProcess | null = null;
let report: SimulationReport | null = null;
let job: SimulationJob = {
  id: null,
  state: "idle",
  options: null,
  progress: null,
  finishedAt: null,
  error: null,
  reportAvailable: false,
  rollback: null,
};
class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function respond(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}
async function body(request: IncomingMessage): Promise<unknown> {
  // DEFENSE: a browser on another site must not spend the unlocked local test accounts through this service.
  if (!request.headers.origin || !allowedOrigins.has(request.headers.origin))
    throw new RequestError(
      403,
      "Use the local DEX website to control simulations.",
    );
  if (request.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new RequestError(
      415,
      "Simulation requests require application/json.",
    );
  let text = "";
  for await (const chunk of request) {
    text += chunk.toString();
    // DEFENSE: the public start endpoint accepts only four scalar options, never an unbounded request body.
    if (Buffer.byteLength(text) > 2048)
      throw new RequestError(413, "Simulation options exceed 2 KiB.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError(400, "Simulation options must be valid JSON.");
  }
}
function options(value: unknown): SimulationOptions {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError(400, "Expected simulation options.");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        !["rounds", "seed", "durationSeconds", "intervalMs"].includes(key),
    )
  )
    throw new RequestError(400, "Unknown simulation option.");
  const read = (name: string, minimum: number, maximum: number) => {
    const item = input[name];
    if (
      typeof item !== "number" ||
      !Number.isSafeInteger(item) ||
      item < minimum ||
      item > maximum
    )
      throw new RequestError(
        400,
        `${name} must be an integer from ${minimum} to ${maximum}.`,
      );
    return item;
  };
  return {
    rounds: read("rounds", 20, 1000),
    seed: read("seed", 0, 4294967295),
    durationSeconds: read("durationSeconds", 0, 600),
    intervalMs: read("intervalMs", 0, 5000),
  };
}
function start(input: SimulationOptions) {
  if (worker)
    throw new RequestError(
      409,
      "A simulation is already running. Stop or wait for it before starting another.",
    );
  report = null;
  const id = randomUUID();
  job = {
    id,
    state: "starting",
    options: input,
    progress: null,
    finishedAt: null,
    error: null,
    reportAvailable: false,
    rollback: null,
  };
  // Only this project-owned worker and bounded numeric options can be executed; request text is never a command.
  const child = fork(workerPath, [], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    execArgv: ["--experimental-strip-types"],
    env: {
      ...process.env,
      SIM_ROUNDS: String(input.rounds),
      SIM_SEED: String(input.seed),
      SIM_DURATION_SECONDS: String(input.durationSeconds),
      SIM_INTERVAL_MS: String(input.intervalMs),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  worker = child;
  let diagnostic = "";
  let finalReport: SimulationReport | null = null;
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-8000);
  });
  child.on("message", (incoming: unknown) => {
    const message = incoming as SimulationMessage;
    if (message.type === "progress") {
      job = {
        ...job,
        progress: message.progress,
        state: job.state === "stopping" ? "stopping" : "running",
      };
    } else if (message.type === "finished") {
      finalReport = message.report;
    }
  });
  child.once("error", (error) => {
    diagnostic = error.message;
  });
  // A terminal job permits another start. Publish it only when the worker has
  // closed, after queued IPC/stdio delivery, and release the worker in this turn.
  child.once("close", (code, signal) => {
    worker = null;
    if (finalReport) {
      report = finalReport;
      job = {
        ...job,
        state: report.status,
        finishedAt: report.finishedAt,
        reportAvailable: true,
        rollback: report.rollback,
      };
    } else {
      job = {
        ...job,
        state: "failed",
        error:
          diagnostic.trim() ||
          `Simulation worker exited before producing a report (${signal ?? code}).`,
        finishedAt: new Date().toISOString(),
      };
    }
  });
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const pathname = url.pathname;
    if (request.method === "GET" && pathname === "/api/simulation")
      return respond(response, 200, job);
    if (request.method === "GET" && pathname === "/api/simulation/report") {
      // DEFENSE: an already displayed download link must not return a newer job's report.
      if (
        url.searchParams.has("jobId") &&
        url.searchParams.get("jobId") !== job.id
      )
        throw new RequestError(
          409,
          "Simulation changed. Refresh before downloading its report.",
        );
      if (!report)
        throw new RequestError(
          404,
          "Finish or stop a simulation before downloading its report.",
        );
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="twopool-simulation-${job.id}.json"`,
        "cache-control": "no-store",
      });
      return response.end(JSON.stringify(report, null, 2));
    }
    if (request.method === "POST" && pathname === "/api/simulation/start") {
      const input = options(await body(request));
      start(input);
      return respond(response, 202, job);
    }
    if (request.method === "POST" && pathname === "/api/simulation/stop") {
      const input = await body(request);
      // DEFENSE: a stale page must never stop a different simulation started after its last observation.
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        !("jobId" in input) ||
        input.jobId !== job.id
      )
        throw new RequestError(
          409,
          "Simulation changed. Refresh before stopping it.",
        );
      if (!worker || !["starting", "running", "stopping"].includes(job.state))
        throw new RequestError(409, "There is no running simulation to stop.");
      job = { ...job, state: "stopping" };
      // DEFENSE: a finished worker disconnects IPC before close; a stop can
      // arrive in that interval and must wait for its existing final report.
      if (worker.connected) worker.send({ type: "stop" });
      return respond(response, 202, job);
    }
    throw new RequestError(404, "Simulation endpoint not found.");
  } catch (error) {
    respond(response, error instanceof RequestError ? error.status : 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Simulation service listening on http://127.0.0.1:${port}`),
);
process.on("SIGTERM", () => {
  if (worker) worker.send({ type: "stop" });
  server.close();
});
