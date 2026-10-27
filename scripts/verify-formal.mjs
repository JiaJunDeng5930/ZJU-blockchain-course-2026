import "./formal-environment.mjs";
import { spawn } from "node:child_process";
import { mkdir, open, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, ".local/formal");
await mkdir(output, { recursive: true });
process.env.SOLC_BINARY ??= process.env.DEX_SOLC;
const checks = [
  ["frontend", "scripts/build-formal.mjs"],
  ["swap-smt", "contracts/scripts/verify-swap.mjs"],
  ["liquidity-smt", "contracts/scripts/verify-liquidity.cjs"],
  ["arbitrage-smt", "contracts/scripts/verify-arbitrage.cjs"],
  ["swap-refinement", "contracts/scripts/verify-swap.proof.mjs"],
  ["liquidity-refinement", "contracts/scripts/verify-liquidity.rocq.cjs"],
  [
    "liquidity-supply-refinement",
    "contracts/scripts/verify-liquidity-supply.rocq.cjs",
  ],
  ["arbitrage-refinement", "contracts/scripts/verify-arbitrage.rocq.cjs"],
];
// Each proof checker has an isolated workspace. Bound concurrency to avoid memory contention.
let cursor = 0;
const results = [];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (cursor < checks.length) {
      const [name, script] = checks[cursor++];
      const log = join(output, `${name}.log`);
      const handle = await open(log, "w");
      const started = Date.now();
      const child = spawn(process.execPath, [script], {
        cwd: root,
        env: process.env,
        stdio: ["ignore", handle.fd, handle.fd],
      });
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      await handle.close();
      results.push({ name, code, milliseconds: Date.now() - started, log });
      console.log(`${name}: ${code === 0 ? "passed" : "failed"} (${log})`);
    }
  }),
);
await writeFile(
  join(output, "verification.json"),
  JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2) +
    "\n",
);
if (results.some((result) => result.code !== 0)) process.exitCode = 1;
