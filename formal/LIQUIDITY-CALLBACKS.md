# Liquidity NFT callback acceptance

Run from the project root:

```sh
npm run test:liquidity-callback
```

After the existing build has completed, the same public runner can be invoked
without rebuilding the frontend:

```sh
contracts/node_modules/.bin/tsx frontend/acceptance/liquidity-callback-public.mts
```

The runner deploys the actual MiniDEX and TestToken artifacts to its own
temporary Hardhat chain. A separate receiver fixture uses only their public
interfaces. Artifact ABI and bytecode are checked against the recorded
build-info; the compiler input's import closure is hashed against the current
production sources without interpreting their function bodies. The test also
checks the deployed runtime code. Compiler identity comes from that build-info,
not the installed npm `solc` package version.

## Behaviors

1. A contract receives a liquidity NFT and transfers its redemption rights to
   the final owner, who receives the pool assets when redeeming. Forwarding
   during the receiver callback may succeed or revert atomically; a receiver
   that accepts and transfers after the mint must remain usable.
2. A rejected safe mint rolls back the attempted deposit's token movements,
   reserves, total shares, NFT state and counter. Two finite allowances remain
   at their previously confirmed values; accepting and retrying then consumes
   the actual deposit allowance. Earlier approval transactions remain confirmed.
3. A receiver that rejects a safe transfer leaves the original NFT owner,
   approval, position and pool state intact. After accepting, the approved
   operator can retry the transfer, the old owner cannot redeem it, and the
   contract holder can redeem the assets. Approval is cleared on transfer.
4. A mint callback tries to redeem and transfer a passive holder's live NFT.
   That holder's ownership and position remain intact. Either the safe outer
   mint succeeds with its event, NFT shares and pool accounting in agreement,
   without spending the victim's assets, or it reverts completely
   and can be retried with an accepting receiver. No particular guard or revert
   message is required.

Redemption quantities are compared with the actual removal event and changes
in token balances and reserves; the runner does not reproduce the AMM share
formula. Reverted calls are manually mined so their real failed receipts are
available. The EOA's gas charge is separate from the contract holder's tokens.

## Evidence and boundary

Each run writes `.local/liquidity-callback-public-*/result.json`, including the
actual receipts, before/after state, production and artifact fingerprints,
runner/fixture hashes and isolated-node cleanup. The process exits nonzero if
an assertion fails. The isolated chain is closed on both success and failure.

These are public-contract acceptance scenarios, not a proof of all callback
programs or all reachable MiniDEX storage states. Existing Rocq ownership replay
and share-book proofs are not repeated here. In particular, this acceptance
does not close the separate global MiniDEX SMT targets, establish browser
behavior or prove every multi-operation callback transaction.
