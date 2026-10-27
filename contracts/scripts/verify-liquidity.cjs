const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const solc = require("solc");
const { handleSMTQueries } = require("solc/smtchecker");
const { smtSolver, availableSolvers } = require("solc/smtsolver");

const root = path.resolve(__dirname, "..");
const project = path.resolve(root, "..");
const harness = "formal/LiquidityProperties.sol";
const solver = availableSolvers.find((entry) => entry.name === "z3");
if (!solver) throw new Error("Z3 is required; no verification was performed.");

// Both compiler paths use Solidity's standard JSON and its existing SMT encoding.
const binary = process.env.SOLC_BINARY;
const version = binary
  ? execFileSync(binary, ["--version"], { encoding: "utf8" }).trim()
  : solc.version();
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
    viaIR: true,
    evmVersion: "paris",
    modelChecker: {
      engine: "chc",
      solvers: ["smtlib2"],
      targets: ["assert", "underflow", "overflow"],
      showProvedSafe: true,
      showUnproved: true,
      timeout: 10000,
      contracts: { [harness]: ["LiquidityProperties"] },
    },
    outputSelection: { "*": { "*": ["abi"] } },
  },
};
function compile(value) {
  return binary
    ? JSON.parse(
        execFileSync(
          binary,
          [
            "--standard-json",
            "--base-path",
            root,
            "--include-path",
            path.join(root, "node_modules"),
          ],
          {
            input: JSON.stringify(value),
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
          },
        ),
      )
    : JSON.parse(solc.compile(JSON.stringify(value), { import: readSource }));
}

let output = compile(input);
const solved = handleSMTQueries(input, output, smtSolver, solver);
if (solved) output = compile(solved);
const diagnostics = output.errors ?? [];
const safe = diagnostics.filter(
  (item) =>
    item.message.includes("check is safe!") &&
    item.sourceLocation?.file === harness,
);
const failed = diagnostics.filter(
  (item) =>
    item.severity === "error" ||
    /might happen|happens here|could not be proved|not proved|unsupported|not supported/i.test(
      item.message,
    ),
);
const expected = 11;
const provedAssertions = safe.filter((item) =>
  item.message.includes("Assertion violation"),
);
const status =
  failed.length === 0 && provedAssertions.length === expected
    ? "proved"
    : "unproved";

if (binary) {
  for (const name of Object.keys(output.sources ?? {})) readSource(name);
}
const report = {
  status,
  compiler: version,
  solver: execFileSync("z3", ["--version"], { encoding: "utf8" }).trim(),
  settings: input.settings,
  sourceHashes: Object.fromEntries(
    [...sources].map(([name, text]) => [
      name,
      crypto.createHash("sha256").update(text).digest("hex"),
    ]),
  ),
  claims: [
    "mint retains permanently locked supply and adds the exact minted shares",
    "burn retains locked supply and removes the exact burned shares",
    "reserve increases stay within the production uint112 capacity",
    "reserve decreases retain positive permanent liquidity",
  ],
  provedAssertions: provedAssertions.length,
  diagnostics,
  boundary:
    "Checks the production LiquidityAccounting functions used by MiniDEX at every reserve/share write. Mint arithmetic is checked on the successful uint256-output domain. ERC20 effects, ERC721 storage, OpenZeppelin sqrt/mulDiv refinement and whole-contract invariant composition are separate obligations.",
};
const destination =
  process.env.LIQUIDITY_SMT_REPORT ??
  path.join(project, ".local/formal/liquidity-smt.json");
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
for (const diagnostic of diagnostics)
  console.log(diagnostic.formattedMessage ?? diagnostic.message);
console.log(
  `Liquidity accounting: ${status}; ${provedAssertions.length}/${expected} assertions. Report: ${destination}`,
);
if (status !== "proved") process.exitCode = 1;
