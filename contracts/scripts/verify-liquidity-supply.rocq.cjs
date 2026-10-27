const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync, spawn } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const toolchain = path.join(root, ".local/toolchain");
const coq = process.env.DEX_COQ_ROOT ?? path.join(toolchain, "coq");
const semantics =
  process.env.DEX_SOLIDITY_ROCQ_LIB ?? path.join(toolchain, "rocq-of-solidity");
const hammer = process.env.DEX_HAMMER_ROOT ?? path.join(toolchain, "coqhammer");
const coqutil = process.env.DEX_COQUTIL_ROOT ?? path.join(toolchain, "coqutil");
fs.mkdirSync(path.join(root, ".local/formal"), { recursive: true });
const build = fs.mkdtempSync(
  path.join(root, ".local/formal/liquidity-supply-proof-"),
);
const env = {
  ...process.env,
  OCAMLPATH: `${path.join(coq, "lib")}:${process.env.OCAMLPATH ?? ""}`,
};
const transcript = [];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  });
  transcript.push(
    `$ ${command} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  fs.writeFileSync(path.join(build, "verification.log"), transcript.join("\n"));
  if (result.error || result.status !== 0) {
    throw new Error(
      `${result.error?.message ?? "Rocq verification failed"}. See ${path.join(build, "verification.log")}`,
    );
  }
  return result.stdout;
}

async function main() {
  const version = run(path.join(coq, "bin/coqc"), ["--version"]).trim();
  if (!version.includes("8.20.1"))
    throw new Error(`Expected Coq 8.20.1, received ${version}`);
  run(process.execPath, [
    path.join(__dirname, "verify-liquidity.generate.cjs"),
    "--check",
  ]);
  const sources = [
    "Spec/Types.v",
    "Spec/Units.v",
    "Spec/Assets.v",
    "Spec/AMM.v",
    "Spec/Liquidity.v",
    "Contracts/LiquidityGenerated.v",
    "Contracts/LiquiditySupplySupport.v",
    "Contracts/LiquidityBurnRefinement.v",
    "Contracts/LiquiditySupplyRefinement.v",
  ];
  for (const source of sources) {
    const target = path.join(build, source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, "formal/theories", source), target);
  }
  const flags = [
    "-impredicative-set",
    "-Q",
    build,
    "DEXFormal",
    "-R",
    semantics,
    "RocqOfSolidity",
    "-R",
    path.join(hammer, "theories/Tactics"),
    "Hammer.Tactics",
    "-R",
    path.join(hammer, "src/lib"),
    "Hammer.Tactics",
    "-R",
    path.join(hammer, "src/tactics"),
    "Hammer.Tactics",
    "-I",
    path.join(hammer, "src/lib"),
    "-I",
    path.join(hammer, "src/tactics"),
    "-Q",
    path.join(coqutil, "src/coqutil"),
    "coqutil",
  ];
  const proofSources = [
    "Contracts/LiquidityBurnRefinement.v",
    "Contracts/LiquiditySupplyRefinement.v",
  ];
  for (const source of sources.filter(
    (source) => !proofSources.includes(source),
  )) {
    run(path.join(coq, "bin/coqc"), [
      "-q",
      "-time",
      ...flags,
      path.join(build, source),
    ]);
  }
  async function verifyProof(source) {
    return new Promise((resolve, reject) => {
      const command = path.join(coq, "bin/coqc");
      const args = ["-q", "-time", ...flags, path.join(build, source)];
      const child = spawn(command, args, { cwd: root, env });
      const log = path.join(build, path.basename(source, ".v") + ".log");
      fs.writeFileSync(log, `$ ${command} ${args.join(" ")}\n`);
      let output = "",
        launchError = null,
        expired = false;
      const deadline = setTimeout(() => {
        expired = true;
        child.kill("SIGTERM");
      }, 660_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (text) => {
        output += text;
        fs.appendFileSync(log, text);
      });
      child.stderr.on("data", (text) => {
        output += text;
        fs.appendFileSync(log, text);
      });
      child.on("error", (error) => {
        launchError = error;
      });
      child.on("close", (status) => {
        clearTimeout(deadline);
        if (launchError || expired || status !== 0)
          reject(
            new Error(
              `${source}: ${launchError?.message ?? (expired ? "660s deadline expired" : `coqc exited ${status}`)}; see ${log}`,
            ),
          );
        else resolve(output);
      });
    });
  }
  const checked = await Promise.allSettled(proofSources.map(verifyProof));
  const rejected = checked.filter((result) => result.status === "rejected");
  if (rejected.length)
    throw new Error(rejected.map((result) => result.reason.message).join("\n"));
  const assumptions = checked.map((result) => result.value).join("\n");
  const kernelFlags = [];
  for (let index = 0; index < flags.length; index++) {
    if (flags[index] === "-I") {
      index++;
      continue;
    }
    kernelFlags.push(flags[index]);
  }
  run(path.join(coq, "bin/coqchk"), [
    "-silent",
    ...kernelFlags,
    "DEXFormal.Contracts.LiquidityBurnRefinement",
    "DEXFormal.Contracts.LiquiditySupplyRefinement",
  ]);

  const expectedPrimitives = [
    "int",
    "add",
    "sub",
    "land",
    "lor",
    "lxor",
    "lsl",
    "lsr",
    "ltb",
    "eqb",
  ]
    .map((name) => `PrimInt63.${name}`)
    .sort();
  const observedPrimitives = [
    ...new Set(
      [...assumptions.matchAll(/^([A-Za-z][\w.]*)\s*:/gm)]
        .map((match) => match[1])
        .filter((name) => name !== "Axioms" && name !== "Theory"),
    ),
  ].sort();
  if (
    JSON.stringify(observedPrimitives) !== JSON.stringify(expectedPrimitives) ||
    (assumptions.match(/^Axioms:/gm) ?? []).length !== 2 ||
    (assumptions.match(/^Set is impredicative$/gm) ?? []).length !== 2
  ) {
    throw new Error(
      `Expected only registered Coq kernel primitives and the declared impredicative Set mode. See ${path.join(build, "verification.log")}`,
    );
  }
  const coqlib = run(path.join(coq, "bin/coqc"), ["-where"]).trim();
  const primitiveSource = path.join(
    coqlib,
    "theories/Numbers/Cyclic/Int63/PrimInt63.v",
  );
  const declarations = fs.readFileSync(primitiveSource, "utf8");
  for (const name of expectedPrimitives) {
    if (!declarations.includes(`Primitive ${name.split(".")[1]} := #int63_`)) {
      throw new Error(
        `${name} is not a registered kernel Primitive in ${primitiveSource}`,
      );
    }
  }
  const hash = (file) =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const report = {
    status: "proved",
    kernelCheck: "coqchk passed",
    solidityCompiler: {
      version: run(process.env.SOLC_BINARY, ["--version"]).trim(),
      sha256: hash(process.env.SOLC_BINARY),
    },
    compiler: version,
    logic: "Coq 8.20.1 with -impredicative-set; kernel checked",
    dependencies: {
      rocqOfSolidity: "a53c579ab822838dd938ff5eb8fbcb09b918ec03",
      coq: "fd609f07dab2d2720695882a711cd0a022068ea8",
      hammer: "af9fab74391a48a7f8fddb28ef280d5110bbb2fb",
      coqutil: "b8bb9bcc6ff19b6bad060323d822bc8e2058bee0",
    },
    sources: Object.fromEntries(
      sources.map((source) => [source, hash(path.join(build, source))]),
    ),
    semantics: Object.fromEntries(
      [
        "RecordUpdate.v",
        "RocqOfSolidity.v",
        "simulations/RocqOfSolidity.v",
      ].map((source) => [source, hash(path.join(semantics, source))]),
    ),
    theorems: ["burn_total_refines_supply", "mint_total_refines_supply"],
    assumptions: {
      registeredKernelPrimitives: observedPrimitives,
      unprovedLemmas: [],
      logic: "Set is impredicative",
      primitiveSource: { path: primitiveSource, sha256: hash(primitiveSource) },
    },
    boundary:
      "Successful pure production liquidity-supply helpers under the official generated IR execution relation. External calls, whole-transaction rollback and optimized bytecode remain outside this refinement theorem.",
    log: path.join(build, "verification.log"),
    proofLogs: proofSources.map((source) =>
      path.join(build, path.basename(source, ".v") + ".log"),
    ),
  };
  fs.writeFileSync(
    path.join(root, ".local/formal/liquidity-supply-rocq.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    `Supply refinement: 2 kernel-checked theorems; only declared kernel primitives and impredicative Set. Logs: ${build}`,
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
