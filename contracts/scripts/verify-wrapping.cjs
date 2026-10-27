const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { handleSMTQueries } = require("solc/smtchecker");
const { smtSolver, availableSolvers } = require("solc/smtsolver");

const root = path.resolve(__dirname, "..");
const project = path.resolve(root, "..");
const harness = "formal/WrappingProperties.sol";
const solver = availableSolvers.find((entry) => entry.name === "z3");
if (!solver) throw new Error("Z3 is required; no verification was performed.");

// Reuse Solidity's standard JSON encoding and the existing Z3 adapter.
const binary = process.env.SOLC_BINARY ?? path.join(project, ".local/toolchain/solc");
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
const sources = new Map();
function readSource(name) {
  const location = name.startsWith("@")
    ? path.join(root, "node_modules", name)
    : path.join(root, name);
  const contents = fs.readFileSync(location, "utf8");
  sources.set(name, contents);
  return { contents };
}
const input = {
  language: "Solidity",
  sources: { [harness]: { content: readSource(harness).contents } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: false,
    evmVersion: "paris",
    modelChecker: {
      engine: "chc",
      solvers: ["smtlib2"],
      targets: ["assert"],
      showProvedSafe: true,
      showUnproved: true,
      showUnsupported: true,
      timeout: 10000,
      contracts: { [harness]: ["WrappingProperties"] },
    },
    outputSelection: { "*": { "*": ["abi"] } },
  },
};
function compile(value) {
  return JSON.parse(execFileSync(binary, ["--standard-json", "--base-path", root,
    "--include-path", path.join(root, "node_modules")], {
      input: JSON.stringify(value), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  }));
}

let output = compile(input);
const unsupportedEncoding = (output.errors ?? []).some(item =>
  /unsupported|not supported|does not yet implement/i.test(item.message));
// DEFENSE: the selected compiler cannot encode ERC20 custom errors. Solver
// answers about that encoding cannot certify the production contract.
if (!unsupportedEncoding) {
  const solved = handleSMTQueries(input, output, smtSolver, solver);
  if (solved) output = compile(solved);
}
const diagnostics = output.errors ?? [];
const safe = diagnostics.filter(
  (item) =>
    item.message.includes("check is safe!") &&
    item.sourceLocation?.file === harness,
);
const classified = diagnostics.map((item) => {
  const message = item.message;
  const verificationStatus = unsupportedEncoding && /Assertion violation/i.test(message)
    ? "unknown"
    : /check is safe!/i.test(message)
    ? "proved"
    : /unsupported|not supported|does not yet implement/i.test(message)
      ? "unsupported"
      : /happens here|Counterexample:/i.test(message)
        ? "counterexample"
        : item.severity === "error" ||
            /SMT|SMTChecker|BMC|CHC|solver|could not be proved|not proved/i.test(
              message,
            )
          ? "unknown"
          : "not-verification-record";
  return { ...item, verificationStatus };
});
const failed = classified.filter((item) =>
  ["unsupported", "counterexample", "unknown"].includes(
    item.verificationStatus,
  ),
);
const expected = 8;
const provedAssertions = safe.filter((item) =>
  item.message.includes("Assertion violation"),
);
const status = classified.some(item => item.verificationStatus === "unsupported")
  ? "unsupported"
  : failed.length === 0 && provedAssertions.length === expected ? "proved" : "unproved";

for (const name of Object.keys(output.sources ?? {})) readSource(name);
const report = {
  status,
  solverInvoked: !unsupportedEncoding,
  compiler: version,
  compilerSha256: crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex"),
  solver: execFileSync("z3", ["--version"], { encoding: "utf8" }).trim(),
  settings: input.settings,
  sourceHashes: Object.fromEntries(
    [...sources].map(([name, text]) => [
      name,
      crypto.createHash("sha256").update(text).digest("hex"),
    ]),
  ),
  claims: [
    "production deposit mints exactly msg.value to the sender and total supply",
    "production deposit preserves holder/supply and native backing bounds under stated preconditions",
    "production withdrawal burn removes exactly amount from sender and total supply",
    "production withdrawal burn preserves holder/supply bounds under stated preconditions",
  ],
  expectedAssertions: expected,
  provedAssertions: provedAssertions.length,
  diagnostics: classified,
  specification: "DEXFormal.Spec.Wrapping.wrapping_effect",
  boundary:
    "CHC checks these local assertions over the actual WrappedEther.deposit and inherited OpenZeppelin _burn. The harness assumes a nonzero sender whose balance does not exceed total supply, and deposit starts backed. It does not prove the global ERC20/backing invariant, native ETH recipient callbacks, transaction rollback, or a Rocq/SMT specification equivalence. The Rocq principal model and frontend proofs are separate claims.",
};
const destination =
  process.env.WRAPPING_SMT_REPORT ??
  path.join(project, ".local/formal/wrapping-smt.json");
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
for (const diagnostic of diagnostics)
  console.log(diagnostic.formattedMessage ?? diagnostic.message);
console.log(
  `Wrapping accounting: ${status}; ${provedAssertions.length}/${expected} assertions. Report: ${destination}`,
);
if (status !== "proved") process.exitCode = 1;
