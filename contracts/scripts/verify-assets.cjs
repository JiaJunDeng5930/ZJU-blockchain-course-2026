const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { handleSMTQueries } = require("solc/smtchecker");
const { smtSolver, availableSolvers } = require("solc/smtsolver");
const contracts = path.resolve(__dirname, "..");
const project = path.resolve(contracts, "..");
const compiler = process.env.SOLC_BINARY ?? path.join(project, ".local/toolchain/solc");
const solver = availableSolvers.find((candidate) => candidate.name === "z3");
if (!solver) throw new Error("Z3 is required; no verification was performed.");
const harness = "formal/AssetsProperties.sol";
const input = { language: "Solidity", sources: { [harness]: { content: fs.readFileSync(path.join(contracts, harness), "utf8") } },
  settings: { evmVersion: "paris", optimizer: { enabled: true, runs: 200 }, viaIR: false,
    modelChecker: { engine: "chc", solvers: ["smtlib2"], targets: ["assert"], showProvedSafe: true,
      showUnproved: true, showUnsupported: true, timeout: 10000, contracts: { [harness]: ["AssetsProperties"] } },
    outputSelection: { "*": { "*": ["abi"] } } } };
function compile(input) {
  return JSON.parse(execFileSync(compiler, ["--standard-json", "--base-path", contracts,
    "--include-path", path.join(contracts, "node_modules")], { input: JSON.stringify(input), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
}
let output = compile(input);
const unsupportedFeature = (entry) => /not yet support|not supported|unsupported|not yet implement/i.test(entry.message);
let solverFailure;
// DEFENSE: the pinned compiler reports unsupported ERC20 custom-error types; solver results cannot certify an incomplete encoding.
if (!(output.errors ?? []).some(unsupportedFeature)) {
  try {
    const solved = handleSMTQueries(input, output, smtSolver, solver);
    if (solved) output = compile(solved);
  } catch (error) {
    // DEFENSE: solc/smtsolver has raised ETIMEDOUT for a Z3 query; preserve that failed verification as a report.
    if (!String(error).includes("ETIMEDOUT")) throw error;
    solverFailure = String(error);
  }
}
const diagnostics = output.errors ?? [];
const proved = diagnostics.filter((entry) => entry.sourceLocation?.file === harness && /check is safe!/.test(entry.message));
const errors = diagnostics.filter((entry) => entry.severity === "error");
const unsupported = diagnostics.filter((entry) => /not yet support|not supported|unsupported|not yet implement/i.test(entry.message));
const unproved = diagnostics.filter((entry) => /could not be proved|not proved|might happen|solver.*error|solver.*not available|no.*solver/i.test(entry.message));
const counterexamples = diagnostics.filter((entry) => /Counterexample:|Assertion violation happens/i.test(entry.message));
const status = solverFailure ? "solver-timeout" : errors.length ? "compile-failed" : counterexamples.length ? "counterexample" :
  unsupported.length ? "unsupported" : unproved.length || proved.length !== 3 ? "unproved" : "proved";
const sources = {};
for (const source of Object.keys(output.sources ?? {})) sources[source] = crypto.createHash("sha256").update(fs.readFileSync(path.join(contracts, source.startsWith("@") ? "node_modules" : "", source))).digest("hex");
const report = { status, compiler: execFileSync(compiler, ["--version"], { encoding: "utf8" }).trim(),
  compilerSha256: crypto.createHash("sha256").update(fs.readFileSync(compiler)).digest("hex"), sources,
  expectedAssertions: 3, provedAssertions: proved.length, solverFailure, diagnostics,
  boundary: "Calls the actual TestToken.faucet and inherited OpenZeppelin ERC20 mint. Preconditions require a nonzero sender, holder balance <= total supply and room for the fixed credit. Does not prove the global ERC20 invariant or its refinement to the Rocq balance specification. Unsupported/unproved assertions are never reported as proved." };
const destination = path.join(project, ".local/formal/assets-smt.json");
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ status, provedAssertions: proved.length, unsupported: unsupported.length,
  unproved: unproved.length, compileErrors: errors.length, report: destination }));
if (status !== "proved") process.exitCode = 1;
