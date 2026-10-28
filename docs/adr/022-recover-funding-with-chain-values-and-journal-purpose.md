# Recover funding with chain values and journal purpose

## Status

Accepted.

## Context

The wallet already preserves the transaction journal across reloads, but its
live grant confirmations disappear. A later balance does not establish how much
a grant delivered: the owner may already have spent it. Native transfers also
do not identify themselves as test grants on chain.

## Decision

Compose funding recovery with the existing unified transaction-result entry.
The existing domain classifier retains priority. When it finds no domain result,
the funding reader applies the extracted Rocq selection rules.

For ERC20 grants, bind the observed zero-address `Transfer` to the direct receipt
target and caller, recognize the actual TestToken runtime at the receipt block,
and read that token's metadata at the same block. A foreign mint-shaped event is
insufficient. Live and historical confirmations share the event projection and
presentation.

For native grants, require the journal's preserved `dev-faucet` authority and a
beneficiary matching the actual receipt recipient. Read principal from the
original transaction's `value`, with empty call data and positive value; read
success and gas from its receipt. Do not infer grant purpose from the current
wallet, balances, or unlocked-account list. Ordinary wallet recipients are the
supported local-funding model; delegated recipients that forward value during
execution are outside this grant projection.

The reader reports ordinary non-grant hashes as absent results. Ambiguous mint
observations and external read failures are query errors. Neither rewrites a
confirmed journal entry.

## Verification boundary

Rocq establishes mint selection, native context and value conditions, and the
availability composition. Existing asset recognition and execution-fee logic
remain shared. The adapters rely on the JSON-RPC contract for receipt/log,
transaction and historical-code data. Journal purpose is local provenance,
not an on-chain proof that a transfer was initiated by this application.

References: [ERC-20 Transfer](https://eips.ethereum.org/EIPS/eip-20#transfer-1)
and [Ethereum transaction lookup](https://ethereum.org/developers/docs/apis/json-rpc/#eth_gettransactionbyhash).
