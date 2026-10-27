import "./formal-environment.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, openSync, closeSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  rename,
  copyFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceFormal = join(root, "formal");
await mkdir(join(root, ".local/formal"), { recursive: true });
const work = await mkdtemp(join(root, ".local/formal/frontend-work-"));
const formal = join(work, "formal");
const coqRoot = process.env.DEX_COQ_ROOT ?? join(root, ".local/toolchain/coq");
const coqc = join(coqRoot, "bin/coqc");
const coqdep = join(coqRoot, "bin/coqdep");
const coqchk = join(coqRoot, "bin/coqchk");
const logPath = join(work, "frontend-build.log");
await mkdir(dirname(logPath), { recursive: true });
const log = openSync(logPath, "w");

function run(command, args, cwd = work, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", log, log],
  });
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ?? result.stderr ?? "See the complete build log.";
    throw new Error(
      `${command} ${args.join(" ")} failed: ${detail}\nLog: ${logPath}`,
    );
  }
  return result.stdout?.trim() ?? "";
}
async function filesUnder(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? filesUnder(join(directory, entry.name), suffix)
          : entry.name.endsWith(suffix)
            ? [join(directory, entry.name)]
            : [],
      ),
    )
  ).flat();
}

try {
  const sources = [
    ...(await filesUnder(join(sourceFormal, "theories"), ".v")),
    ...(await filesUnder(join(sourceFormal, "runtime"), ".ml")),
    ...(await filesUnder(join(sourceFormal, "runtime"), ".mli")),
  ];
  const sourceContents = new Map(
    await Promise.all(
      sources.map(async (path) => [relative(root, path), await readFile(path)]),
    ),
  );
  for (const [path, content] of sourceContents) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  const version = run(coqc, ["--version"], root, true);
  if (!version.includes("version 8.20.1"))
    throw new Error(`Expected Coq 8.20.1, got ${version}`);
  const profiles = [
    {
      extract: "theories/Frontend/SwapSettlementExtract.v",
      cwd: work,
      directory: "swapsettlement",
      bridges: ["SwapSettlementBridge"],
    },
    {
      extract: "theories/Frontend/ReceiptFeesExtract.v",
      cwd: work,
      directory: "receiptfees",
      bridges: ["ReceiptFeesBridge"],
    },
    {
      extract: "theories/Frontend/WalletExtract.v",
      cwd: work,
      directory: "wallet",
      bridges: ["AllowancesBridge", "WalletBridge"],
    },
    {
      extract: "theories/Frontend/ExtractTrade.v",
      cwd: work,
      directory: "trade",
      bridges: ["UnitsBridge", "TradeBridge"],
    },
    {
      extract: "theories/Contracts/ArbitrageExtract.v",
      cwd: work,
      directory: "arbitrage",
      bridges: ["ArbitrageBridge"],
    },
    {
      extract: "theories/Contracts/LedgerExtract.v",
      cwd: formal,
      directory: "ledger",
      bridges: ["LedgerBridge"],
    },
    {
      extract: "theories/Contracts/LiquidityExtract.v",
      cwd: formal,
      directory: "liquidity",
      bridges: ["LiquidityBridge"],
    },
    {
      extract: "theories/Frontend/AssetsExtract.v",
      cwd: work,
      directory: "assets",
      bridges: ["AssetsBridge"],
    },
    {
      extract: "theories/Frontend/WrappingExtract.v",
      cwd: work,
      directory: "wrapping",
      bridges: ["WrappingBridge"],
    },
    {
      extract: "theories/Frontend/SimulationExtract.v",
      cwd: work,
      directory: "simulation",
      bridges: ["SimulationBridge"],
    },
  ];
  const theories = (await filesUnder(join(formal, "theories"), ".v")).filter(
    (path) =>
      !path.includes("/Contracts/") &&
      !path.endsWith("Extract.v") &&
      !path.endsWith("ExtractTrade.v"),
  );
  const ordered = run(
    coqdep,
    [
      "-sort",
      "-Q",
      "formal/theories",
      "DEXFormal",
      ...theories.map((path) => relative(work, path)),
    ],
    work,
    true,
  ).split(/\s+/);
  for (const path of ordered)
    run(coqc, ["-Q", "formal/theories", "DEXFormal", path]);
  const modules = ordered.map(
    (path) =>
      `DEXFormal.${relative(join(formal, "theories"), join(work, path)).replace(/\.v$/, "").replaceAll("/", ".")}`,
  );
  run(coqchk, ["-silent", "-Q", "formal/theories", "DEXFormal", ...modules]);
  for (const profile of profiles) {
    await mkdir(join(formal, "build", profile.directory), { recursive: true });
    const q = profile.cwd === work ? "formal/theories" : "theories";
    run(
      coqc,
      [
        "-Q",
        q,
        "DEXFormal",
        relative(profile.cwd, join(formal, profile.extract)),
      ],
      profile.cwd,
    );
  }
  const directories = profiles.map((profile) =>
    join(formal, "build", profile.directory),
  );
  const models = (
    await Promise.all(
      directories.map((directory) => filesUnder(directory, ".ml")),
    )
  ).flat();
  const modelSources = models.flatMap((path) =>
    existsSync(`${path}i`) ? [`${path}i`, path] : [path],
  );
  const bridges = profiles.flatMap((profile) =>
    profile.bridges.map((name) => join(formal, "runtime", name)),
  );
  const bridgeSources = bridges.flatMap((path) =>
    existsSync(`${path}.mli`) ? [`${path}.mli`, `${path}.ml`] : [`${path}.ml`],
  );
  const includes = [...directories, join(formal, "runtime")].flatMap((path) => [
    "-I",
    relative(work, path),
  ]);
  const packages = "zarith,zarith_stubs_js,js_of_ocaml,yojson";
  const mlOrder = run(
    "ocamlfind",
    [
      "ocamldep",
      "-package",
      packages,
      ...includes,
      "-sort",
      ...[...modelSources, ...bridgeSources].map((path) =>
        relative(work, path),
      ),
    ],
    work,
    true,
  ).split(/\s+/);
  for (const path of mlOrder)
    run("ocamlfind", [
      "ocamlc",
      "-warn-error",
      "+8",
      "-package",
      packages,
      ...includes,
      "-c",
      path,
    ]);
  const bytecode = join(formal, "build/frontend.bc");
  const objects = mlOrder
    .filter((path) => path.endsWith(".ml"))
    .map((path) => path.replace(/\.ml$/, ".cmo"));
  run("ocamlfind", [
    "ocamlc",
    "-package",
    packages,
    "-linkpkg",
    ...includes,
    ...objects,
    "-o",
    bytecode,
  ]);
  const stubs = run("ocamlfind", ["query", "zarith_stubs_js"], root, true);
  const output = join(work, "dex_logic.js");
  await mkdir(dirname(output), { recursive: true });
  // DEFENSE: Node 26.5 rejects valid warmed-up simulation events with the
  // default inlined output. Preserve the decoder/callback boundaries.
  const javascriptArguments = [
    "--disable",
    "genprim",
    "--disable",
    "inline",
    "--target-env",
    "browser",
    join(stubs, "biginteger.js"),
    join(stubs, "runtime.js"),
    bytecode,
    "-o",
    output,
  ];
  const javascriptVersion = run("js_of_ocaml", ["--version"], root, true);
  run("js_of_ocaml", javascriptArguments);
  const inputs = [
    ...theories,
    ...profiles.map((profile) => join(formal, profile.extract)),
    ...bridgeSources,
  ];
  const hashes = Object.fromEntries(
    inputs.map((path) => {
      const name = relative(work, path);
      return [
        name,
        createHash("sha256").update(sourceContents.get(name)).digest("hex"),
      ];
    }),
  );
  // DEFENSE: concurrent proof work can change a model after this build captured its source.
  for (const [name, hash] of Object.entries(hashes)) {
    const current = createHash("sha256")
      .update(await readFile(join(root, name)))
      .digest("hex");
    if (current !== hash)
      throw new Error(
        `Source changed during extraction: ${name}. Rebuild the current program.`,
      );
  }
  const published = join(root, "frontend/src/generated/dex_logic.js");
  await mkdir(dirname(published), { recursive: true });
  await rename(output, published);
  await writeFile(
    join(root, ".local/formal/frontend-build.json"),
    JSON.stringify(
      {
        compiler: version,
        javascriptCompiler: {
          version: javascriptVersion,
          arguments: javascriptArguments,
        },
        log: relative(root, logPath),
        logicalMode: "predicative Set",
        sourceSnapshot: relative(root, work),
        inputs: hashes,
        output: "frontend/src/generated/dex_logic.js",
        outputSha256: createHash("sha256")
          .update(await readFile(published))
          .digest("hex"),
      },
      null,
      2,
    ),
  );
  console.log(
    `Checked ${theories.length} Rocq sources and generated the frontend logic.\nLog: ${logPath}`,
  );
} finally {
  closeSync(log);
  const latest = join(work, "latest-build.log");
  await copyFile(logPath, latest);
  await rename(latest, join(root, ".local/formal/frontend-build.log"));
}
