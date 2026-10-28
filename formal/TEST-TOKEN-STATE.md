# Test-token state verification

The local gate proves four postconditions of the **actual inherited
`TestToken.faucet` and OpenZeppelin ERC20 storage**. It neither replaces `_mint`
nor introduces a second ledger. Production contracts and deployment bytecode are
unchanged.

| Postcondition | Entry condition |
| --- | --- |
| Total supply increases by exactly `10_000 ether` | Nonzero caller |
| Caller balance increases by exactly `10_000 ether` | Nonzero caller; entry caller balance is at most total supply |
| Caller balance remains at most total supply | Same holder-bound premise |
| A different address's balance stays unchanged | Address differs from caller |

The first assertion also checks that supply does not decrease; the caller-delta
assertion checks nondecrease before subtracting. The proof does not rely on a
harness subtraction reverting or on modular wraparound. Room for the mint is
checked by the production mint path, not assumed by the harness.

The amount matches `Spec.Assets.test_faucet_amount`. This is a shared numeric
policy, **not** a formal refinement from ERC20 storage to the Rocq ledger.

## Run the local gate

After installing the [existing formal toolchain](TOOLCHAIN.md), from the repository
root run:

```sh
node contracts/scripts/verify-assets.cjs
```

The runner uses native Z3 through `SOLC_BINARY`, defaulting to
`.local/toolchain/solc`; it does not infer the compiler version from the JavaScript
deployment compiler. Its BMC engine checks the loop-free faucet call over symbolic
entry state. It does not establish an invariant across arbitrary transaction
histories.

Exit zero requires all four expected source assertions to have individual safe
diagnostics at their exact AST source locations. Missing targets, unproved
results, counterexamples, compiler errors or an unavailable solver fail the gate.
The report includes full compiler identity and binary SHA, production/dependency
source SHA, verifier SHA, settings, target locations, and all diagnostics:

- `.local/formal/assets-smt.json`
- `.local/formal/assets-smt-input.json`
- `.local/formal/assets-smt-output.json`

### Unsupported features and proof results

The old gate skipped solving whenever the compiler reported custom-error support
warnings. That discarded useful proof attempts. Solidity documents that unsupported
constructs use [sound overapproximation](https://docs.soliditylang.org/en/v0.8.28/smtchecker.html#unsupported-language-features): a target reported safe remains safe,
although abstraction can produce false positives. The new gate retains all such
warnings and accepts only complete, explicit safe coverage. A warning itself is
never counted as evidence. The local run proves four assertions while retaining
eight custom-error warnings.

## The global holder bound remains open

Run the separate reachable-state query:

```sh
node contracts/scripts/verify-assets.cjs --reachable
```

`AssetsReachabilityProperties` asserts `balanceOf(holder) <= totalSupply()` with
**no holder-bound premise**, keeping all inherited ERC20 public transitions. The
current CHC result is `unproved` (zero of one target safe), so this command exits
nonzero. It records the result and raw compiler input/output separately under
`.local/formal/assets-reachability-smt*.json`.

The caller-balance local theorem assumes the entry bound; it does not discharge
this global obligation. Neither report proves deployed-bytecode equivalence, EVM
rollback, or an end-to-end correspondence with the frontend. Changes to any hashed
source, compiler, verifier or settings require rerunning the affected gate.
