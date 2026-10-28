const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const contracts = path.resolve(__dirname, "..");
const project = path.resolve(contracts, "..");
const compiler = process.env.SOLC_BINARY ?? path.join(project, ".local/toolchain/solc");
const args = process.argv.slice(2);
// DEFENSE: a misspelled scope must not silently run the easier local proof.
if (args.length > 1 || (args.length === 1 && args[0] !== "--reachable")) {
  throw new Error("Usage: node contracts/scripts/verify-assets.cjs [--reachable]");
}
const reachable = args[0] === "--reachable";
const contract = reachable ? "AssetsReachabilityProperties" : "AssetsProperties";
const harness = `formal/${contract}.sol`;
const expected = reachable
  ? { proveReachableBacking: 1 }
  : { proveSupplyDelta: 1, proveCallerBalance: 2, proveOtherBalance: 1 };
const engine = reachable ? "chc" : "bmc";
const input = {
  language: "Solidity",
  sources: { [harness]: { content: fs.readFileSync(path.join(contracts, harness), "utf8") } },
  settings: {
    evmVersion: "paris", optimizer: { enabled: true, runs: 200 }, viaIR: false,
    modelChecker: {
      engine, solvers: ["z3"], targets: ["assert"], showProvedSafe: true,
      showUnproved: true, showUnsupported: true, timeout: 10000,
      contracts: { [harness]: [contract] },
    },
    outputSelection: { "*": { "": ["ast"] } },
  },
};
const output = JSON.parse(execFileSync(compiler, ["--standard-json", "--base-path", contracts,
  "--include-path", path.join(contracts, "node_modules")], {
  input: JSON.stringify(input), encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60000,
}));
const diagnostics = output.errors ?? [];
const targetKey = (start, end) => `${start}:${end}`;
const safe = new Set(diagnostics
  .filter((d) => /Assertion violation check is safe!/.test(d.message) && d.sourceLocation?.file === harness)
  .map((d) => targetKey(d.sourceLocation.start, d.sourceLocation.end)));
function assertions(node, result = []) {
  if (!node || typeof node !== "object") return result;
  if (node.nodeType === "FunctionCall" && node.expression?.name === "assert") {
    const [start, length] = node.src.split(":").map(Number);
    result.push({ start, end: start + length });
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => assertions(item, result));
    else if (value && typeof value === "object") assertions(value, result);
  }
  return result;
}
const definition = output.sources?.[harness]?.ast?.nodes.find((node) =>
  node.nodeType === "ContractDefinition" && node.name === contract);
const targets = Object.entries(expected).flatMap(([name, count]) => {
  const member = definition?.nodes.find((node) => node.nodeType === "FunctionDefinition" && node.name === name);
  const found = assertions(member);
  return [{ function: name, expected: count, assertions: found.map((location) => ({
    ...location, safe: safe.has(targetKey(location.start, location.end)),
  })) }];
});
const expectedAssertions = Object.values(expected).reduce((sum, count) => sum + count, 0);
const actualAssertions = assertions(definition).length;
const provedAssertions = targets.flatMap((target) => target.assertions).filter((target) => target.safe).length;
const coverageComplete = actualAssertions === expectedAssertions &&
  targets.every((target) => target.assertions.length === target.expected);
const compileErrors = diagnostics.filter((d) => d.severity === "error");
const unsupported = diagnostics.filter((d) => /not yet support|not supported|unsupported|not yet implement/i.test(d.message));
const counterexamples = diagnostics.filter((d) => /Counterexample:|Assertion violation happens/i.test(d.message));
const solverFailures = diagnostics.filter((d) => /solver.*error|solver.*not available|no.*solver|analysis was not possible/i.test(d.message));
// Unsupported constructs are soundly overapproximated by SMTChecker. Retain
// their diagnostics; only exact safe results covering every assertion pass.
const status = compileErrors.length ? "compile-failed" : !coverageComplete ? "target-mismatch" :
  solverFailures.length ? "solver-unavailable" : counterexamples.length ? "counterexample" :
  provedAssertions !== expectedAssertions ? "unproved" : "proved";
const digest = (content) => crypto.createHash("sha256").update(content).digest("hex");
const sources = {};
for (const source of Object.keys(output.sources ?? {})) {
  const filename = path.join(contracts, source.startsWith("@") ? "node_modules" : "", source);
  sources[source] = digest(fs.readFileSync(filename));
}
const report = {
  status, scope: reachable ? "reachable-holder-backing" : "local-faucet-postconditions", engine,
  compiler: execFileSync(compiler, ["--version"], { encoding: "utf8" }).trim(),
  compilerSha256: digest(fs.readFileSync(compiler)), sourceRoot: "contracts", sources, settings: input.settings,
  verifierSha256: digest(fs.readFileSync(__filename)), inputSha256: digest(JSON.stringify(input)),
  expectedAssertions, actualAssertions, provedAssertions, targets, diagnostics,
  unsupportedFeatures: unsupported.length,
  unsupportedPolicy: "Sound overapproximation; unsupported diagnostics are retained, not proof results. Every expected source assertion must have its own safe diagnostic.",
  unsupportedPolicyReference: "https://docs.soliditylang.org/en/v0.8.28/smtchecker.html#unsupported-language-features",
  boundary: reachable
    ? "No holder-bound premise. CHC asks whether every observed holder is backed by total supply in all reachable inherited ERC20 states. A missing safe target does not certify the invariant."
    : "BMC verifies one loop-free call to the actual inherited TestToken.faucet and OpenZeppelin ERC20 storage. Supply delta assumes a nonzero caller; caller balance delta and backing additionally assume its entry balance <= total supply; other-holder preservation assumes a different address. This does not prove the entry holder bound globally, deployed bytecode, or refinement to the Rocq ledger.",
};
const destination = path.join(project, `.local/formal/assets${reachable ? "-reachability" : ""}-smt.json`);
fs.mkdirSync(path.dirname(destination), { recursive: true });
const inputPath = destination.replace(/\.json$/, "-input.json");
const outputPath = destination.replace(/\.json$/, "-output.json");
fs.writeFileSync(inputPath, JSON.stringify(input, null, 2) + "\n");
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
report.rawInput = path.relative(project, inputPath);
report.rawOutput = path.relative(project, outputPath);
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ status, scope: report.scope, engine, expectedAssertions, actualAssertions,
  provedAssertions, unsupported: unsupported.length, report: destination }));
if (status !== "proved") process.exitCode = 1;
