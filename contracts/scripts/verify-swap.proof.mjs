import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assumptionAudit from "./rocq-assumptions.cjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const configuration = JSON.parse(
  await readFile(
    process.env.DEX_TOOLCHAIN_ENV ??
      join(root, ".local/toolchain/environment.json"),
    "utf8",
  ),
);
const env = { ...process.env, ...configuration };
const coq = env.DEX_COQ_ROOT;
const semantics = env.DEX_SOLIDITY_ROCQ_LIB;
const hammer = env.DEX_HAMMER_ROOT;
const coqutil = env.DEX_COQUTIL_ROOT;
await mkdir(join(root, ".local/formal"), { recursive: true });
const build = await mkdtemp(join(root, ".local/formal/swap-proof-"));
const log = join(build, "verification.log");
const transcript = [];
const reportPath = join(root, "formal/build/swap-proof.json");
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  transcript.push(
    `$ ${command} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  await writeFile(log, transcript.join("\n"));
  if (result.error || result.status !== 0)
    throw new Error(
      `${result.error?.message ?? "Verification command failed"}. See ${log}`,
    );
  return result.stdout;
}

const sources = [
  "Spec/Types.v",
  "Spec/Units.v",
  "Spec/Assets.v",
  "Spec/AMM.v",
  "Contracts/SwapGenerated.v",
  "Contracts/SwapRefinement.v",
];
const snapshots = new Map(
  await Promise.all(
    sources.map(async (source) => [
      source,
      await readFile(join(root, "formal/theories", source)),
    ]),
  ),
);
for (const [source, bytes] of snapshots) {
  await mkdir(dirname(join(build, source)), { recursive: true });
  await writeFile(join(build, source), bytes);
}
const libraries = [
  "-Q",
  build,
  "DEXFormal",
  "-R",
  semantics,
  "RocqOfSolidity",
  "-R",
  join(hammer, "theories/Tactics"),
  "Hammer.Tactics",
  "-R",
  join(hammer, "src/lib"),
  "Hammer.Tactics",
  "-R",
  join(hammer, "src/tactics"),
  "Hammer.Tactics",
  "-Q",
  join(coqutil, "src/coqutil"),
  "coqutil",
];
const flags = [
  "-impredicative-set",
  ...libraries,
  "-I",
  join(hammer, "src/lib"),
  "-I",
  join(hammer, "src/tactics"),
];
try {
  const compiler = (await run(join(coq, "bin/coqc"), ["--version"])).trim();
  if (!/version 8\.20\.1(?:\s|$)/.test(compiler))
    throw new Error(`Expected Coq 8.20.1, got ${compiler}`);
  await run(process.execPath, [
    join(root, "contracts/scripts/verify-swap.rocq.mjs"),
  ]);
  for (const source of sources)
    await run(join(coq, "bin/coqc"), [
      "-q",
      "-time",
      ...flags,
      join(build, source),
    ]);
  await run(join(coq, "bin/coqchk"), [
    "-silent",
    "-impredicative-set",
    ...libraries,
    "DEXFormal.Contracts.SwapRefinement",
  ]);
  const auditSource = join(build, "Audit.v");
  await writeFile(
    auditSource,
    "Require Import DEXFormal.Contracts.SwapRefinement.\n" +
      "Print Assumptions SwapRefinement.calculate_amount_out_runs.\n" +
      "Print Assumptions SwapRefinement.frontend_swap_quote_matches_contract.\n",
  );
  const auditOutput = await run(join(coq, "bin/coqc"), [
    "-q",
    "-time",
    ...flags,
    auditSource,
  ]);
  const coqlib = (await run(join(coq, "bin/coqc"), ["-where"])).trim();
  const assumptions = assumptionAudit.auditAssumptions(auditOutput, {
    expectedReports: 2,
    coqlib,
  });
  // DEFENSE: another feature can change a shared model during the slow kernel check.
  // Its old snapshot is a valid proof artifact, but cannot certify the new source.
  for (const [source, bytes] of snapshots) {
    if (!bytes.equals(await readFile(join(root, "formal/theories", source)))) {
      throw new Error(`Source changed during verification: ${source}`);
    }
  }
  const report = {
    status: "proved",
    compiler,
    kernelCheck: "coqchk passed",
    assumptions,
    theorems: [
      "calculate_amount_out_runs",
      "frontend_swap_quote_matches_contract",
    ],
    scope:
      "Positive swaps in the bounded uint112 reserve domain; actual inherited AMMMath helper under the official optimized generated-Yul Run.t relation. The extracted frontend request quotes equal its results and it preserves the initial State. ABI decoding, MiniDEX storage integration, ERC20 effects and EVM bytecode remain outside this refinement.",
    sources: Object.fromEntries(
      [...snapshots].map(([source, bytes]) => [source, hash(bytes)]),
    ),
    translation: JSON.parse(
      await readFile(join(root, "formal/build/swap-translation.json"), "utf8"),
    ),
    log,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: "proved",
      theorems: report.theorems,
      report: "formal/build/swap-proof.json",
    }),
  );
} catch (error) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    `${JSON.stringify({ status: "proof-error", error: error.message, log }, null, 2)}\n`,
  );
  throw error;
}
