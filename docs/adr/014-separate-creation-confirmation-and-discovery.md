# ADR 014: Separate confirmed creation from metadata discovery

A successful deployment receipt identifies a created contract even when a later
metadata call fails. The previous creation adapter awaited metadata before
returning, so a failed read could make a confirmed deployment appear to fail.
Pool creation returned no identity, leaving its caller to find the new pool in a
list that can contain the same pair and pool number on different exchanges.

Creation now returns the observed receipt and the identity established by that
receipt: `contractAddress` for the token, or the target exchange's `PoolCreated`
event for the pool. Token metadata discovery uses the existing query cache and
catalog validation independently; its errors remain readable and retryable
without repeating deployment. Discovery already started by the operation can
finish and register a verified token after its result panel unmounts.

A pool result deliberately carries no invented reserves or creation timestamp.
Its deposit action uses only the matching pool subsequently observed in the
normal chain snapshot. Confirmation and a later unavailable state read are
different facts.

Recovery uses the existing scoped transaction history and a read of the actual
creation receipt. It does not add a second persisted inventory of candidate
assets. The kernel admits archives only from the matching genesis, deployment
and RPC namespace and re-observes restored confirmations; the receipt view
consumes those entries without introducing another scope policy.

