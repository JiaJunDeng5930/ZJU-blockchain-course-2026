const { verifyStorageTargets } = require("./lib/storage-smt.cjs");
// DEFENSE: this command certifies only its named local properties; extra flags
// must not be mistaken for a request to prove the complete withdrawal path.
if (process.argv.length !== 2) {
  throw new Error("Usage: node contracts/scripts/verify-wrapping.cjs");
}
verifyStorageTargets({
  verifier: __filename, harness: "formal/WrappingProperties.sol", contract: "WrappingProperties",
  expected: { proveDeposit: 4, proveWithdrawalBurn: 4 }, engine: "bmc",
  scope: "local-wrapped-ether-storage-postconditions", reportName: "wrapping",
  boundary: "BMC verifies actual inherited deposit and the same OpenZeppelin _burn used by withdraw. Deposit assumes a nonzero caller, its entry token balance <= supply, and prior ETH backing. Burn assumes a nonzero caller and amount <= caller balance <= supply. The burn proof does not execute withdraw's ETH call or its failure path. These local checks do not establish global backing, deployed bytecode, or a refinement to Rocq.",
});
