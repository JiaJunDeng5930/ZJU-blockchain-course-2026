# Wrapped Ether storage postconditions

Run from the repository root:

```sh
node contracts/scripts/verify-wrapping.cjs
```

The command runs native Solidity SMTChecker with Z3/BMC against
[`WrappingProperties`](../contracts/formal/WrappingProperties.sol). The harness
inherits the actual production `WrappedEther` and OpenZeppelin code; it does not
replace their balances or mint/burn implementations. The current result is eight
safe assertion locations and exit code 0, recorded in
`.local/formal/wrapping-smt.json`.

## Proven scope and premises

`proveDeposit` calls the real inherited `deposit`. Its caller is nonzero, the
caller's entry token balance is at most the entry supply, and the pre-existing
supply is backed by ETH before the incoming call value. The harness expresses
that last premise using the observed payable-entry balance minus `msg.value`.
It proves:

- Caller balance and supply each increase by the incoming value.
- The caller balance remains at most supply.
- The observed contract ETH balance backs the resulting supply.

`proveWithdrawalBurn` calls the same inherited `_burn` that production
`withdraw` uses. It assumes a nonzero caller and
`amount <= caller balance <= total supply`. It proves:

- Caller balance and supply each decrease by the burned amount.
- The caller balance does not increase and remains at most supply.

These are local postconditions over the actual storage implementation. The
entry holder bound and ETH backing are premises, not globally proved
invariants. The burn harness does **not** execute `withdraw`'s external ETH
call, recipient callback or failure branch. The `receive` dispatch is also
outside these checks. No claim of a complete withdrawal, deployed-bytecode or
Rocq semantic refinement follows from these eight targets.

## Gate and provenance

The two public storage profiles share the same execution and target-coverage
gate. It obtains assertion locations from the compiler AST and requires an
explicit safe diagnostic for every expected location. Missing targets, compiler
errors, unavailable solvers, counterexamples and unproved targets return a
nonzero exit code. A failed compiler invocation writes a fresh failure record,
so an earlier safe report cannot be mistaken for that invocation's result.

All nine abstraction warnings from this check remain in the report. Solidity
documents unsupported constructs as sound overapproximations: an explicitly
safe target remains safe, while an abstraction can introduce false positives.
See [the official explanation](https://docs.soliditylang.org/en/v0.8.28/smtchecker.html#unsupported-language-features).
Warnings alone are neither proof results nor evidence of an implementation bug.

The report records the actual compiler version and binary SHA, complete source
SHA map, settings, exact input/output byte hashes, raw artifact paths and SHA
values for both the profile and shared executor (`verifierSources`). The current
native compiler identifies itself as
`0.8.36-develop.2026.10.27+commit.a53c579a.mod.Darwin.appleclang`.
The installed npm `solc` package version does not establish the compiler used by
a production artifact; that identity must be read from its build-info. This
gate certifies source-level properties under the recorded compiler semantics,
not the compilation pipeline or EVM bytecode.
