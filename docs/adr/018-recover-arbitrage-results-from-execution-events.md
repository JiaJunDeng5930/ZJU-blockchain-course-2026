# Recover arbitrage results from execution events

## Context

A confirmed arbitrage remains in wallet history after a page reload, but the
execution result was held only by the arbitrage page. Reading pool storage at a
receipt's block cannot recover transaction-local reserves: other swaps may run
before or after the arbitrage within that same block. The production contract
already emits actual capital, intermediate amount, return, profit and two
`PoolReservesChanged` events.

## Decision

Recover those facts from the saved hash, using the configured arbitrage emitter
and configured exchange identities. Share the event decoder and result component
with immediate execution confirmation. Scope and event selection run in extracted
Rocq code; ABI decoding and RPC access remain adapters. Share the existing
missing-descriptor policy so an already confirmed hash remains manually readable
when transaction metadata failed to load.

Read immutable pool identity and ERC20 metadata at the receipt block. Represent
before/after reserve snapshots with only the identity, token pair and event
reserves, without attaching a block-end LP supply. Show the event's trader as the
asset recipient, the receipt sender as the ETH fee payer, and token profit in its
own units. Keep existing fee calculations and decimal formatting in the extracted
kernels. Do not persist a second result archive or reconstruct the original UI
quote from later state.

## Consequences

The public reader supports the application's single `execute` operation and
rejects receipts containing multiple executions or incomplete associated events.
It returns no result for unrelated successful receipts and refuses reverted
receipts. RPC or metadata errors remain retriable read failures without changing
wallet confirmation history. Full historical RPC state is needed for metadata;
actual reserves always come from this execution's events. The formal guarantee
covers selection and association given decoded observations, not EVM execution,
RPC honesty or an end-to-end proof of the complete application.

## References

- [Viem transaction receipts](https://viem.sh/docs/actions/public/getTransactionReceipt)
- [Viem ABI event parsing](https://viem.sh/docs/contract/parseEventLogs)
