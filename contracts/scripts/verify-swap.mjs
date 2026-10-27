import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const contracts = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(contracts, "..");
const compiler = process.env.DEX_SOLC;
if (!compiler)
  throw new Error("Set DEX_SOLC to the pinned Solidity compiler binary.");
const sourcePath = "formal/SwapProperties.sol";
const productionPath = "contracts/AMMMath.sol";
const harnessSource = readFileSync(resolve(contracts, sourcePath), "utf8");
const productionSource = readFileSync(
  resolve(contracts, productionPath),
  "utf8",
);
const input = {
  language: "Solidity",
  sources: {
    [sourcePath]: { content: harnessSource },
    [productionPath]: { content: productionSource },
  },
  settings: {
    evmVersion: "paris",
    modelChecker: {
      engine: process.env.DEX_SMT_ENGINE ?? "bmc",
      contracts: { [sourcePath]: ["SwapProperties"] },
      targets: ["assert", "overflow", "underflow", "divByZero"],
      showProvedSafe: true,
      showUnproved: true,
      timeout: 10_000,
    },
    outputSelection: { "*": { "*": ["abi"] } },
  },
};

const command = spawnSync(
  compiler,
  [
    "--base-path",
    contracts,
    "--include-path",
    resolve(contracts, "node_modules"),
    "--standard-json",
  ],
  {
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  },
);
if (command.error) throw command.error;
if (command.status !== 0)
  throw new Error(command.stderr || `solc exited ${command.status}`);
const output = JSON.parse(command.stdout);
const diagnostics = (output.errors ?? []).map(
  ({ severity, errorCode, message, sourceLocation }) => ({
    severity,
    code: errorCode,
    message,
    sourceLocation,
  }),
);
const compileErrors = diagnostics.filter((item) => item.severity === "error");
const counterexamples = diagnostics.filter((item) =>
  /happens here|Counterexample:|Assertion violation happens/i.test(
    item.message,
  ),
);
const unsupported = diagnostics.filter((item) =>
  /not.*supported|unsupported|inline assembly/i.test(item.message),
);
const proved = diagnostics.filter((item) =>
  /is safe|proved safe/.test(item.message),
);
// DEFENSE: solc can report a solver failure after proving other verification conditions.
// Every unclassified SMT diagnostic keeps the aggregate result from becoming "proved".
const unknown = diagnostics.filter(
  (item) =>
    /might happen|could not|not possible|not available/i.test(item.message) ||
    (/\b(?:SMT|SMTChecker|BMC|CHC)\b/.test(item.message) &&
      !counterexamples.includes(item) &&
      !unsupported.includes(item) &&
      !proved.includes(item)),
);
const status = compileErrors.length
  ? "compile-error"
  : counterexamples.length
    ? "counterexample"
    : unknown.length
      ? "unknown"
      : unsupported.length
        ? "unsupported"
        : proved.length
          ? "proved"
          : "no-proof-evidence";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
if (version.status !== 0)
  throw new Error("Cannot identify the selected compiler.");
const report = {
  status,
  scope: {
    production: "AMMMath.calculateAmountOut",
    harness: "SwapProperties.quoteOutputIsBelowReserve",
    properties: [
      "output below outgoing reserve",
      "zero input gives zero output",
      "constant product does not decrease",
      "arithmetic overflow",
      "arithmetic underflow",
      "division by zero",
    ],
    loops: false,
  },
  compiler: {
    path: resolve(compiler),
    version: version.stdout.trim(),
    sha256: sha256(readFileSync(compiler)),
  },
  source: {
    productionMath: sha256(productionSource),
    harness: sha256(harnessSource),
  },
  settings: input.settings.modelChecker,
  proved,
  unknown,
  unsupported,
  counterexamples,
  diagnostics,
};
mkdirSync(resolve(root, "formal/build"), { recursive: true });
writeFileSync(
  resolve(root, "formal/build/swap-smt.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
writeFileSync(
  resolve(root, "formal/build/swap-smt-input.json"),
  `${JSON.stringify(input, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    status,
    proved: proved.length,
    unknown: unknown.length,
    unsupported: unsupported.length,
    counterexamples: counterexamples.length,
    report: "formal/build/swap-smt.json",
  }),
);
if (status !== "proved") process.exitCode = 1;
