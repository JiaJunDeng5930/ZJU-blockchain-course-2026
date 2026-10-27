# 013: Preserve simulation receipts independently of successful cleanup

The final simulation report is deliberately produced only after simulated NFT
redemptions and atomic-rollback verification. Using it as the only downloadable
receipt source loses useful evidence when a real RPC or transaction error stops
the worker. Market progress retains only the latest 100 transactions and is
published between rounds, so it cannot establish what happened immediately
before such a failure.

The worker therefore publishes each received receipt before starting another
chain write. The service retains this current job's receipt journal independently
of progress and the final report. NFT mint and redemption identities are decoded
from those receipts; their presentation is derived from this journal rather than
a second position inventory. A missing redemption entry means that the worker
has not reported that redemption, not that the NFT still exists or is still
owned by the mint recipient. Existing positions remain outside the run journal.

The complete report continues to mean successful cleanup and verification;
stopped runs retain their existing partial-run meaning. A journal remains
downloadable after worker failure and is scoped to its job ID. It records
received confirmations, not unknown submissions or an independent chain scan.
Service-process loss is outside this in-memory guarantee.

The running development service already contains a completed 60-second result
that must survive its upgrade. An explicit, terminal-only snapshot handoff
preserves that actual job, report and verified receipts. The import file is
consumed after listening succeeds so it cannot silently restore an old completed
run on a later restart. This operational handoff is not automatic crash recovery.

Preparation reads check the actual mandatory calls before the first approval:
nonzero ETH for the 20 senders, 1000 units of the first deployment token for the
initial price displacement, and at least one scanned token unit for the
arbitrageur. They neither refill balances nor reserve a speculative budget for
the random workload. Later failures still preserve confirmed receipt evidence.

The Rocq simulation controller remains responsible for request identity and
start/stop availability. Its existing opaque JSON observation carries these
additional I/O facts; this change adds no financial calculation or new formal
proof claim. Node IPC and the RPC receipt interface remain trusted boundaries.

References: [Node child-process message and close events](https://nodejs.org/api/child_process.html#event-close),
[ethers transaction receipts](https://docs.ethers.org/v6/api/providers/#TransactionReceipt).
