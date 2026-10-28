# MiniDEX storage assertions

`contracts/formal/MiniDEXStateProperties.sol` inherits the production MiniDEX,
including its public ERC721 and exchange transitions. Its two view functions
inspect the production `pools`, `positions`, and ERC721 ownership storage; they
do not maintain a second state machine or assume the asserted invariants.

The four CHC targets are:

| Target | State requirement |
| --- | --- |
| Pool token order | Every created pool stores `token0 < token1`. |
| Pool reserve bounds | Both stored reserves are at most `MAX_RESERVE`. |
| Pool share floor | Total shares are zero or at least the permanently locked minimum. |
| Active position backing | A nonzero position points to a created pool, has positive shares and an NFT owner, and leaves at least the locked minimum outside its own shares. |

The last target is an individual-position bound, not a claim that summing every
NFT's shares reproduces the total pool supply. The verification constructor fixes
the ERC721 display name to `Storage verification`.

## Run and interpret

```sh
node contracts/scripts/verify-minidex-state.cjs
```

The command defaults to `.local/toolchain/solc`; `SOLC_BINARY` can select another
native compiler with a Z3 backend. It records the actual compiler version and
binary SHA, compiler settings, imported source SHAs, inherited state-changing
entry points, each compiler-AST assertion location, and all diagnostics in
`.local/formal/minidex-state-smt.json`. Missing assertions or missing safe
diagnostics cannot satisfy the gate. Exit zero requires all four exact-location
targets to be reported safe; an unclosed target exits nonzero.

The checked native toolchain reports
`0.8.36-develop.2026.10.27+commit.a53c579a.mod.Darwin.appleclang`; production's
JavaScript compiler remains `0.8.20+commit.a1b79de6`. Neither is upgraded by this
command. The CHC process has a 90-second limit, with a 10-second checker timeout
per query.

## Current boundary

The actual four-target run reports **zero safe targets and four unproved
targets**, while retaining 103 unsupported-language diagnostics. These are not
proofs of the storage invariants, and a checker model is not a reproduced EVM
transaction demonstrating a bug. This gate remains unclosed.

Solidity documents [sound overapproximation of unsupported constructs](https://docs.soliditylang.org/en/v0.8.28/smtchecker.html#unsupported-language-features):
an explicitly reported safe target can remain valid despite such warnings, but
the abstraction can also produce false positives. The runner preserves these
warnings and requires actual safe-target coverage rather than discarding a
query or treating an unsupported encoding as success.

The existing reserve/supply helper proofs are still narrower than these storage
requirements. Closing this gap requires a proof that accounts for actual
storage and inter-contract effects; this harness does not claim bytecode
refinement, a complete ERC20/ERC721 proof, or an end-to-end Rocq connection.
