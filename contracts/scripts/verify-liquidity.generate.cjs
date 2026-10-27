const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const binary = process.env.SOLC_BINARY;
if (!binary)
  throw new Error(
    "SOLC_BINARY must select the pinned rocq-of-solidity compiler.",
  );
const version = execFileSync(binary, ["--version"], { encoding: "utf8" });
if (!version.includes("a53c579a"))
  throw new Error("The Rocq conversion requires the pinned a53c579a compiler.");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "dex-liquidity-rocq-"));
execFileSync(
  binary,
  [
    "--base-path",
    path.join(root, "contracts"),
    "--include-path",
    path.join(root, "contracts/node_modules"),
    "--evm-version",
    "paris",
    "--ir-rocq",
    "--output-dir",
    output,
    path.join(root, "contracts/formal/LiquidityProperties.sol"),
  ],
  { encoding: "utf8" },
);

const inputs = [
  "contracts/contracts/LiquidityAccounting.sol",
  "contracts/formal/LiquidityProperties.sol",
];
const hashes = inputs.map(
  (name) =>
    `${name}: ${crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(root, name)))
      .digest("hex")}`,
);
const generated =
  `(* Production liquidity accounting helpers through its public SMT harness.
   Converter: rocq-of-solidity a53c579ab822838dd938ff5eb8fbcb09b918ec03.
   IR uses the Paris target and preserves unoptimized function boundaries.
   The deployed compiler optimizer remains within the explicitly trusted solc boundary.
   ${hashes.join("\n   ")}
*)\n` + fs.readFileSync(path.join(output, "LiquidityProperties.v"), "utf8");
const target = path.join(
  root,
  "formal/theories/Contracts/LiquidityGenerated.v",
);
if (process.argv.includes("--check")) {
  if (fs.readFileSync(target, "utf8") !== generated) {
    throw new Error(
      "LiquidityGenerated.v differs from the current Solidity conversion. Regenerate and recheck its proofs.",
    );
  }
  console.log(
    "LiquidityGenerated.v matches the current production liquidity accounting helpers.",
  );
} else {
  fs.writeFileSync(target, generated);
  console.log(`Generated ${target}`);
}
