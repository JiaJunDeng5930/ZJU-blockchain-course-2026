const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");

const contracts = path.resolve(__dirname, "..");
const project = path.resolve(contracts, "..");
const compiler = path.resolve(process.env.SOLC_BINARY ?? path.join(project, ".local/toolchain/solc"));
const harness = "formal/MiniDEXStateProperties.sol";
const contract = "MiniDEXStateProperties";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const settings = {
  evmVersion: "paris",
  optimizer: { enabled: true, runs: 200 },
  modelChecker: {
    engine: "chc", solvers: ["z3"], targets: ["assert"],
    showProvedSafe: true, showUnproved: true, showUnsupported: true,
    timeout: 10000, contracts: { [harness]: [contract] },
  },
  outputSelection: { [harness]: { "": ["ast"], "*": ["abi"] } },
};
const source = fs.readFileSync(path.join(contracts, harness), "utf8");
const input = { language: "Solidity", sources: { [harness]: { content: source } }, settings };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "minidex-state-smt-"));
const destination = path.join(project, ".local/formal/minidex-state-smt.json");
const started = Date.now();
let report;
try {
  // DEFENSE: the complete inherited MiniDEX encoding exceeded a 32 MiB stdout
  // buffer. Stream compiler output rather than truncating verification evidence.
  const outputPath = path.join(scratch, "output.json");
  const fd = fs.openSync(outputPath, "w");
  let run;
  try {
    run = spawnSync(compiler, ["--standard-json", "--base-path", contracts,
      "--include-path", path.join(contracts, "node_modules")], {
      input: JSON.stringify(input), encoding: "utf8", stdio: ["pipe", fd, "pipe"],
      timeout: 90000, maxBuffer: 1024 * 1024,
    });
  } finally {
    fs.closeSync(fd);
  }
  const raw = fs.readFileSync(outputPath);
  const identity = {
    version: execFileSync(compiler, ["--version"], { encoding: "utf8", timeout: 5000 }).trim(),
    sha256: sha(fs.readFileSync(compiler)),
  };
  if (run.status !== 0) {
    // DEFENSE: a full inherited-contract query can exceed the explicit process
    // budget. A killed compiler supplies no proof, even if it emitted partial JSON.
    report = { status: "compiler-failed", compiler: identity, settings,
      process: { exitCode: run.status, signal: run.signal, error: run.error?.code },
      stdoutSha256: sha(raw), stderr: run.stderr };
  } else {
    const output = JSON.parse(raw);
    const diagnostics = output.errors ?? [];
    const targets = [];
    function visit(value, functionName) {
      if (Array.isArray(value)) return value.forEach((item) => visit(item, functionName));
      if (!value || typeof value !== "object") return;
      if (value.nodeType === "FunctionDefinition") functionName = value.name;
      if (value.nodeType === "FunctionCall" && value.expression?.name === "assert") {
        const [start, length] = value.src.split(":").map(Number);
        const matching = diagnostics.filter((entry) => entry.sourceLocation?.file === harness &&
          entry.sourceLocation.start === start && entry.sourceLocation.end === start + length);
        const safe = matching.some((entry) => /Assertion violation check is safe/.test(entry.message));
        const unproved = matching.some((entry) => /might happen|could not be proved|not proved/.test(entry.message));
        targets.push({ function: functionName, start, end: start + length,
          expression: source.slice(start, start + length),
          status: safe && !unproved ? "safe" : unproved ? "unproved" : "uncovered" });
      }
      Object.values(value).forEach((item) => visit(item, functionName));
    }
    visit(output.sources?.[harness]?.ast);
    const sources = Object.fromEntries(Object.keys(output.sources ?? {}).map((file) => [file,
      sha(fs.readFileSync(path.join(contracts, file.startsWith("@") ? "node_modules" : "", file)))]));
    const proved = targets.filter((target) => target.status === "safe").length;
    const errors = diagnostics.filter((entry) => entry.severity === "error");
    const complete = targets.length === 4 && proved === 4;
    const abi = output.contracts?.[harness]?.[contract]?.abi ?? [];
    report = { status: errors.length ? "compile-failed" : complete ? "proved" : "unproved",
      scope: "CHC reachable-storage assertions over unmodified MiniDEX and all inherited public transitions; no invariant is assumed by the harness.",
      compiler: identity, settings, inputSha256: sha(JSON.stringify(input)), outputSha256: sha(raw), sources,
      expectedAssertions: 4, provedAssertions: proved, targets,
      inheritedTransitions: abi.filter((item) => item.type === "function" &&
        !["pure", "view"].includes(item.stateMutability)).map((item) =>
          `${item.name}(${item.inputs.map((parameter) => parameter.type).join(",")})`).sort(),
      unsupportedDiagnostics: diagnostics.filter((entry) =>
        /not yet support|not supported|unsupported|not yet implement/i.test(entry.message)).length,
      diagnostics,
      boundary: "Only an exact-source, exact-location safe diagnostic counts as a closed target. Unsupported-language diagnostics remain visible; solc's documented sound overapproximation can prove individual safe targets, but cannot close missing or unproved ones. This is not bytecode refinement or a proof of every ERC20/ERC721 effect.",
    };
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
report.elapsedMs = Date.now() - started;
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ status: report.status, expectedAssertions: report.expectedAssertions,
  provedAssertions: report.provedAssertions, unsupportedDiagnostics: report.unsupportedDiagnostics,
  report: destination }));
if (report.status !== "proved") process.exitCode = 1;
