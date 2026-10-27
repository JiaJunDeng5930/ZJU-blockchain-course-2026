import "./formal-environment.mjs";
import { spawn } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const contracts = join(root, "contracts");
const frontend = join(root, "frontend");
const logDirectory = join(root, ".local/logs");
const hardhat = join(contracts, "node_modules/hardhat/dist/src/cli.js");
const vite = join(frontend, "node_modules/vite/bin/vite.js");
const rpcPort = Number(process.env.DEX_RPC_PORT ?? 8545);
const webPort = Number(process.env.DEX_WEB_PORT ?? 3000);
const simulationPort = Number(process.env.SIMULATION_PORT ?? 8787);
const rpcUrl = `http://127.0.0.1:${rpcPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const simulationUrl = `http://127.0.0.1:${simulationPort}/api/simulation`;
const environment = {
  ...process.env,
  LOCAL_RPC_URL: rpcUrl,
  SIMULATION_PORT: String(simulationPort),
  DEX_WEB_PORT: String(webPort),
};
const children = new Set();
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    // Each owned service has its own process group, including any simulation worker.
    process.kill(-child.pid, "SIGTERM");
  }
  if (children.size === 0) process.exit(code);
  const deadline = setTimeout(() => {
    for (const child of children) process.kill(-child.pid, "SIGKILL");
    process.exit(code);
  }, 5000);
  for (const child of children)
    child.once("exit", () => {
      if (children.size === 0) {
        clearTimeout(deadline);
        process.exit(code);
      }
    });
}
process.once("SIGINT", () => stop(130));
process.once("SIGTERM", () => stop(143));

function start(name, entry, args, cwd, persistent = false) {
  const path = join(logDirectory, `${name}.log`);
  const fd = openSync(path, "w");
  const child = spawn(
    process.execPath,
    [
      ...(entry.endsWith(".ts") ? ["--experimental-strip-types"] : []),
      entry,
      ...args,
    ],
    { cwd, detached: true, stdio: ["ignore", fd, fd], env: environment },
  );
  closeSync(fd);
  children.add(child);
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      children.delete(child);
      if (!stopping && (persistent || code !== 0))
        reject(new Error(`${name} exited (${code ?? signal}). See ${path}`));
      else resolve();
    });
  });
  if (persistent)
    completed.catch((error) => {
      console.error(error.message);
      stop(1);
    });
  return completed;
}
async function fetchAvailable(url, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(2000) });
  } catch (error) {
    // DEFENSE: an unstarted local service refuses connections during normal first-run startup.
    if (error.cause?.code === "ECONNREFUSED") return undefined;
    throw error;
  }
}
async function rpc(method, params = []) {
  const response = await fetchAvailable(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response) return undefined;
  const body = await response.json();
  if (body.error) throw new Error(`Local RPC ${method}: ${body.error.message}`);
  return body.result;
}
async function waitFor(label, probe) {
  const until = Date.now() + 30000;
  do {
    if (await probe()) return;
    await delay(250);
  } while (Date.now() < until);
  throw new Error(
    `${label} did not become ready within 30 seconds. See ${logDirectory}`,
  );
}
async function deploymentPresent() {
  let content;
  try {
    content = await readFile(join(root, "shared/deployment.json"), "utf8");
  } catch (error) {
    // DEFENSE: a clean checkout or first launch has no generated deployment file yet.
    if (error.code === "ENOENT") return false;
    throw error;
  }
  const deployment = JSON.parse(content);
  if (
    deployment.rpcUrl !== rpcUrl ||
    deployment.chainId !== 31337 ||
    deployment.schemaVersion !== 1
  )
    throw new Error(
      "shared/deployment.json belongs to another network. Select it explicitly or move that generated file before starting the local demo.",
    );
  const targets = [
    ...deployment.exchanges.map((exchange) => ({
      address: exchange.address,
      contract: "MiniDEX",
    })),
    ...deployment.tokens.map((token) => ({
      address: token.address,
      contract: token.kind === "wrapped" ? "WrappedEther" : "TestToken",
    })),
    { address: deployment.arbitrage, contract: "AtomicArbitrage" },
  ];
  const identities = await Promise.all(
    targets.map(async (target) => {
      const artifact = JSON.parse(
        await readFile(
          join(
            contracts,
            "artifacts/contracts",
            `${target.contract}.sol`,
            `${target.contract}.json`,
          ),
          "utf8",
        ),
      );
      return (
        (await rpc("eth_getCode", [target.address, "latest"])) ===
        artifact.deployedBytecode
      );
    }),
  );
  return identities.every(Boolean);
}
async function main() {
  try {
    await Promise.all([access(hardhat), access(vite)]);
  } catch (error) {
    // DEFENSE: a fresh clone has not installed the two application dependency sets.
    if (error.code === "ENOENT")
      throw new Error(
        "Dependencies are missing. Run npm run setup from the repository root first.",
      );
    throw error;
  }
  await mkdir(logDirectory, { recursive: true });
  console.log("Compiling contracts and extracting verified frontend logic…");
  await start("compile", hardhat, ["build"], contracts);
  await start(
    "frontend-abi",
    join(root, "scripts/generate-frontend-abi.mjs"),
    [],
    root,
  );
  await start(
    "frontend-logic",
    join(root, "scripts/build-formal.mjs"),
    [],
    root,
  );
  if ((await rpc("eth_chainId")) === undefined) {
    console.log("Starting local Ethereum node…");
    void start(
      "chain",
      hardhat,
      ["node", "--network", "hardhat", "--port", String(rpcPort)],
      contracts,
      true,
    );
    await waitFor("Ethereum node", () => rpc("eth_chainId"));
  } else console.log("Reusing the running local Ethereum node.");
  if (Number(await rpc("eth_chainId")) !== 31337)
    throw new Error(
      `Port ${rpcPort} is running a different chain. The demo requires chain 31337.`,
    );
  if (!(await deploymentPresent())) {
    console.log("Deploying the two exchanges and preparing 20 test accounts…");
    await start(
      "deploy",
      hardhat,
      ["run", "--no-compile", "scripts/deploy.ts", "--network", "localhost"],
      contracts,
    );
  } else
    console.log("Reusing the deployed exchanges and existing chain state.");
  const simulation = await fetchAvailable(simulationUrl);
  if (!simulation) {
    void start(
      "simulation",
      join(contracts, "scripts/simulation-server.ts"),
      [],
      contracts,
      true,
    );
    await waitFor(
      "Simulation service",
      async () => (await fetchAvailable(simulationUrl))?.ok,
    );
  } else if (!simulation.ok || !("state" in (await simulation.json())))
    throw new Error(
      `Port ${simulationPort} is occupied by a different service.`,
    );
  const page = await fetchAvailable(webUrl);
  if (!page) {
    void start(
      "web",
      vite,
      ["--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
      frontend,
      true,
    );
    await waitFor("Frontend", async () => (await fetchAvailable(webUrl))?.ok);
  } else if (!page.ok || !(await page.text()).includes("TwoPool DEX"))
    throw new Error(`Port ${webPort} is occupied by a different application.`);
  console.log(
    `\nTwoPool DEX is ready: ${webUrl}\nOpen Simulation to run the 20-account market.\nLogs: ${logDirectory}\nCtrl+C stops only services started by this command.`,
  );
  // Keep a reused development stack attached so Ctrl+C has the same lifecycle in both launch modes.
  if (children.size === 0)
    await new Promise(() => {
      process.stdin.resume();
    });
}
main().catch((error) => {
  console.error(error.message);
  stop(1);
});
