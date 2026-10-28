const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const contracts = path.resolve(__dirname, "../..");
const project = path.resolve(contracts, "..");
const digest = (content) => crypto.createHash("sha256").update(content).digest("hex");
const key = (start, end) => `${start}:${end}`;

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

function verifyStorageTargets(profile) {
  const { harness, contract, expected, engine, scope, boundary, reportName, verifier } = profile;
  const compiler = process.env.SOLC_BINARY ?? path.join(project, ".local/toolchain/solc");
  const destination = path.join(project, `.local/formal/${reportName}-smt.json`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const verifierSources = Object.fromEntries([verifier, __filename].map((filename) =>
    [path.relative(project, filename), digest(fs.readFileSync(filename))]));
  const report = { status: "compiler-failed", scope, engine, sourceRoot: "contracts", boundary,
    verifierSha256: verifierSources[path.relative(project, verifier)], verifierSources };
  // DEFENSE: SOLC_BINARY may name a missing/failing compiler, or compilation may
  // time out. Publish a fresh failed record before running it, never stale safe.
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
  try {
    const input = {
      language: "Solidity",
      sources: { [harness]: { content: fs.readFileSync(path.join(contracts, harness), "utf8") } },
      settings: {
        evmVersion: "paris", optimizer: { enabled: true, runs: 200 }, viaIR: false,
        modelChecker: { engine, solvers: ["z3"], targets: ["assert"], showProvedSafe: true,
          showUnproved: true, showUnsupported: true, timeout: 10000,
          contracts: { [harness]: [contract] } },
        outputSelection: { "*": { "": ["ast"] } },
      },
    };
    const payload = JSON.stringify(input);
    const inputPath = destination.replace(/\.json$/, "-input.json");
    fs.writeFileSync(inputPath, payload);
    Object.assign(report, { settings: input.settings, inputSha256: digest(payload),
      rawInput: path.relative(project, inputPath),
      compiler: execFileSync(compiler, ["--version"], { encoding: "utf8", timeout: 10000 }).trim(),
      compilerSha256: digest(fs.readFileSync(compiler)) });
    const outputText = execFileSync(compiler, ["--standard-json", "--base-path", contracts,
      "--include-path", path.join(contracts, "node_modules")], {
      input: payload, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60000,
    });
    const outputPath = destination.replace(/\.json$/, "-output.json");
    fs.writeFileSync(outputPath, outputText);
    Object.assign(report, { rawOutput: path.relative(project, outputPath), outputSha256: digest(outputText) });
    const output = JSON.parse(outputText);
    const diagnostics = output.errors ?? [];
    const safe = new Set(diagnostics
      .filter((d) => /Assertion violation check is safe!/.test(d.message) && d.sourceLocation?.file === harness)
      .map((d) => key(d.sourceLocation.start, d.sourceLocation.end)));
    const definition = output.sources?.[harness]?.ast?.nodes.find((node) =>
      node.nodeType === "ContractDefinition" && node.name === contract);
    const targets = Object.entries(expected).map(([name, count]) => {
      const member = definition?.nodes.find((node) => node.nodeType === "FunctionDefinition" && node.name === name);
      return { function: name, expected: count, assertions: assertions(member).map((location) =>
        ({ ...location, safe: safe.has(key(location.start, location.end)) })) };
    });
    const expectedAssertions = Object.values(expected).reduce((sum, count) => sum + count, 0);
    const actualAssertions = assertions(definition).length;
    const provedAssertions = targets.flatMap((target) => target.assertions).filter((target) => target.safe).length;
    const coverageComplete = actualAssertions === expectedAssertions &&
      targets.every((target) => target.assertions.length === target.expected);
    const unsupported = diagnostics.filter((d) => /not yet support|not supported|unsupported|not yet implement/i.test(d.message));
    const compileErrors = diagnostics.filter((d) => d.severity === "error");
    const counterexamples = diagnostics.filter((d) => /Counterexample:|Assertion violation happens/i.test(d.message));
    const solverFailures = diagnostics.filter((d) => /solver.*error|solver.*not available|no.*solver|analysis was not possible/i.test(d.message));
    // SMTChecker soundly overapproximates unsupported constructs. Exact safe
    // diagnostics, not the absence of warnings or a total count, certify targets.
    const status = compileErrors.length ? "compile-failed" : !coverageComplete ? "target-mismatch" :
      solverFailures.length ? "solver-unavailable" : counterexamples.length ? "counterexample" :
      provedAssertions !== expectedAssertions ? "unproved" : "proved";
    const sources = {};
    for (const source of Object.keys(output.sources ?? {})) {
      const filename = path.join(contracts, source.startsWith("@") ? "node_modules" : "", source);
      sources[source] = digest(fs.readFileSync(filename));
    }
    Object.assign(report, { status, sources, expectedAssertions, actualAssertions, provedAssertions,
      targets, diagnostics, unsupportedFeatures: unsupported.length,
      unsupportedPolicy: "Sound overapproximation; warnings are retained. Every expected source assertion needs its own safe diagnostic.",
      unsupportedPolicyReference: "https://docs.soliditylang.org/en/v0.8.28/smtchecker.html#unsupported-language-features" });
  } catch (error) {
    report.error = { message: error.message, code: error.code, signal: error.signal };
  }
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, scope, engine,
    expectedAssertions: report.expectedAssertions, actualAssertions: report.actualAssertions,
    provedAssertions: report.provedAssertions, unsupported: report.unsupportedFeatures, report: destination }));
  if (report.status !== "proved") process.exitCode = 1;
  return report;
}

module.exports = { verifyStorageTargets };
