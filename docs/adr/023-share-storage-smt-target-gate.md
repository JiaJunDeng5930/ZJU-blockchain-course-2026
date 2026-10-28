# ADR 023: Share the storage SMT target gate

## Context

The faucet verifier already distinguishes abstraction warnings from target
results and binds each expected assertion to an explicit safe source location.
The wrapping verifier duplicated compiler execution but stopped before solving
when it saw unsupported constructs. A native BMC probe over the unchanged
wrapping harness proved all eight targets despite the retained warnings.

## Decision

Keep faucet and wrapping premises, target functions and report scopes in their
own command profiles. Share native compilation, source-location coverage,
diagnostic classification and provenance recording in one storage SMT executor.
Bind both the profile and executor SHA values into every report. Replace a
previous report with a failure record before invoking the external compiler.

## Consequences

Both commands use the same strict success criterion without duplicating the
proof policy. Their local and global claims remain separate. The other SMT and
Rocq runners retain their existing scopes; this change does not generalize the
executor into a new verification framework or establish a complete withdrawal
proof.
