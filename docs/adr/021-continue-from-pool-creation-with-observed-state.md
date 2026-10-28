# Continue from pool creation with observed state

Status: Accepted

## Context

Creating a pair and supplying its liquidity are separate operations, as in
[Uniswap V2's factory](https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Factory.sol).
A saved creation receipt identifies the pool but says nothing about its later
reserves. Another account can initialize that pool before its creator continues.

The existing creation panel already offered a deposit action. Reopening the page
lost that panel, while the wallet retained the confirmed transaction hash.

## Decision

Recover the immutable identity from the configured DEX's `PoolCreated` event and
share the creation presenter between immediate confirmation and transaction
history. Keep creation recovery independent of metadata and current-state reads.

Reuse explicit pool selection and the existing App deposit callback. The Rocq
continuation selects the exact exchange/id from the current snapshot and applies
connection, pending-operation and asset-support conditions. Only a ready result
contains the observed pool used to open the deposit form.

## Consequences

An absent target requests another read without changing the confirmed creation.
An initialized target uses the existing proportional deposit policy. Neither
history recovery nor opening a form submits approvals or deposits. No duplicate
pool state or result archive is introduced. Event decoding and RPC honesty remain
external assumptions; the proofs cover selection and continuation policy.
