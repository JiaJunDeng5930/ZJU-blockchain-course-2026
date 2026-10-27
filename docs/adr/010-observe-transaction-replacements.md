# 010: Track nonce replacements without changing operation authority

Status: accepted and implemented.

A wallet can replace a pending transaction using the same sender and nonce.
Waiting only for the original hash loses the result after a speed-up or
cancellation. Conversely, accepting any successful replacement receipt would
incorrectly complete the original operation and could continue a swap after its
approval was cancelled.

Retain public transaction metadata alongside the existing journal entry. Bind
observations to the captured sender, nonce and transaction hashes. A replacement
with the same call can continue through the existing receipt rules; a different
call must stop the original operation. Keep the original and observed replacement
hashes visible. Neither outcome creates a new signing permission.

Use viem's receipt and replacement facilities for live observation. Persist the
public metadata needed for recovery, because a node can discard the original
transaction before the next page starts. The local Hardhat node does not support
`eth_getTransactionBySenderAndNonce`. Watching future blocks alone also misses a
replacement mined before recovery starts. For that case, use bounded queries
driven by the extracted model to locate the consumed nonce, then verify the
actual transaction and receipt. Do not scan an unbounded history or infer the
business result merely because the account nonce increased.

This is a receipt-observation detail of an existing journal entry, not an
account transaction index. Only the entry's previously observed descriptor can
start the lookup. Keep the current transaction and history-refresh entry points;
do not add pages, arbitrary sender/nonce queries or wallet replacement actions.

The existing storage ownership and recovery rules still apply. An observer of
another page's archive cannot overwrite it or resume its executable operation.
Read actual older archive formats explicitly; absent nonce information means
absent information, rather than nonce zero. If sufficient metadata was never
observed or saved, retain an unknown outcome and allow another observation.
Do not resend the transaction to manufacture a result.

Classify replacements and drive query progress in Rocq. RPC and wallet adapters
only interpret effects. The external contract requires coherent canonical-chain
nonce, transaction and receipt observations; the proofs do not implement or
certify Ethereum execution. Equal call fields identify the same request, not a
proof that changing transaction fees leaves every EVM observation unchanged.

Reference: [viem receipt and replacement observation](https://viem.sh/docs/actions/public/waitForTransactionReceipt).
