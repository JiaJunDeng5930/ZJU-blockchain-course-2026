# Pending transactions

The course application keeps the current page's transaction activity and enough public transaction information to observe a known pending transaction after refreshing the same tab. It does not maintain a long-term transaction archive.

Only pending transactions are checkpointed in `sessionStorage`, which survives a same-tab reload and is separate from other tabs. Completed transactions remain in the current page's memory and are removed from the checkpoint. Wallet preferences are independent of this checkpoint.

Restoration grants observation authority only. It never requests a signature, resends a transaction, resumes the next approval or business write, or infers that a missing hash means a failed submission. Repricing and cancellation use [active replacement observation](TRANSACTION-REPLACEMENTS.md).

Known limitation: viem's native replacement observation needs the original transaction to be observable. If that hash was replaced before observation began, the replacement may remain unidentified. After the bounded 180-second wait, the page keeps the known submitted hash and reports observation unavailability; it does not label it reverted, sign again or search old blocks.

If browser storage is unavailable, the current transaction can still run and the page explains that refresh recovery is unavailable. A receipt read failure preserves the existing transaction meaning; it is not a reverted receipt. Account and chain changes continue to invalidate old signing authority.

`theories/Frontend/PendingTransactions.v` defines the checkpoint decisions, alongside the wallet and transaction models. The wallet interpreter supplies storage and RPC effects. The public snapshot exposes `pendingRecovery` as `loading`, `ready` or `memory`, with the observation/storage error when present. Run the public-entry acceptance from the repository root:

```bash
npm run test:pending
```

It uses a real isolated chain and verifies pending observation after reload, confirmation, absence of automatic resubmission, and the retained failure behavior. The scope is deliberately limited to pending observation; see [ADR 024](../docs/adr/024-course-delivery-scope.md).
