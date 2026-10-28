const { verifyStorageTargets } = require("./lib/storage-smt.cjs");
const args = process.argv.slice(2);
// DEFENSE: a misspelled scope must not silently run the easier local proof.
if (args.length > 1 || (args.length === 1 && args[0] !== "--reachable")) {
  throw new Error("Usage: node contracts/scripts/verify-assets.cjs [--reachable]");
}
const reachable = args[0] === "--reachable";
const contract = reachable ? "AssetsReachabilityProperties" : "AssetsProperties";
verifyStorageTargets({
  verifier: __filename, harness: `formal/${contract}.sol`, contract,
  expected: reachable ? { proveReachableBacking: 1 }
    : { proveSupplyDelta: 1, proveCallerBalance: 2, proveOtherBalance: 1 },
  engine: reachable ? "chc" : "bmc",
  scope: reachable ? "reachable-holder-backing" : "local-faucet-postconditions",
  reportName: reachable ? "assets-reachability" : "assets",
  boundary: reachable
    ? "No holder-bound premise. CHC asks whether every observed holder is backed by total supply in all reachable inherited ERC20 states. A missing safe target does not certify the invariant."
    : "BMC verifies one loop-free call to the actual inherited TestToken.faucet and OpenZeppelin ERC20 storage. Supply delta assumes a nonzero caller; caller balance delta and backing additionally assume its entry balance <= total supply; other-holder preservation assumes a different address. This does not prove the entry holder bound globally, deployed bytecode, or refinement to the Rocq ledger.",
});
