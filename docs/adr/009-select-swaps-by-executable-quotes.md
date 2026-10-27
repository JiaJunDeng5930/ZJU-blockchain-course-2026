# 009: Select a swap venue using its amount-out quote

Status: accepted and implemented.

The deployment contains independent exchange pools for the same pair. Requiring
the user to choose an exchange before entering an amount leaves ordinary price
comparison to the user. The reserve ratio alone is insufficient: a thin pool
with a better spot price can return fewer tokens for a larger trade.

For a fixed input and token pair, compare the shared AMM amount-out calculation
over eligible direct pools in the current deployment. Maximize output after the
existing pool fee and price impact. Call this Best quote; do not imply that it
optimizes gas, searches other deployments, splits trades or discovers multihop
paths. Use one coherent pool snapshot and keep candidate ordering deterministic
when quotes tie.

Keep manual venue selection for users who choose a particular pool. A failed
or unavailable manual selection must not silently become permission to execute
somewhere else. Pair selection should identify the token pair without repeating
it once per exchange.

Reuse the existing swap draft, amount conversion, slippage rule and wallet
operation. Extend the extracted specification with venue selection instead of
sorting quotes or reproducing AMM arithmetic in TypeScript. A selected effect
captures the exchange, pool, input and quote together. Subsequent observations
may change the next recommendation, but cannot reinterpret a captured request
after the user has approved its spender. This keeps approval and execution bound
to the same selected venue and retains the displayed minimum-output guarantee.

Connect the selected quote to the existing actual-Solidity refinement. This
extends the frontend reasoning; it does not prove RPC observations, wallet
transport or full EVM execution. Price and slippage behavior follow the existing
[Uniswap V2 quoting model](https://developers.uniswap.org/docs/protocols/v2/concepts/pricing).
