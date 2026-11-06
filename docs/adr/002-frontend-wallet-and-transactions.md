# ADR 002: Wallet identity, chain reads and transaction outcomes

Status: accepted

The initial frontend combined every form, RPC request and wallet state in App. That let the displayed account and signer diverge, represented confirmed transactions and failed refreshes as the same failure, and required unrelated features to understand each other's state.

A single wallet session now owns its account and signer together. The session follows EIP-1193 account/network/disconnect events. An unsupported chain or disconnected wallet has no usable signer. Local RPC account selection remains an explicit teaching feature. Signing operations recheck wallet identity before approvals and execution because wallet state may change while an approval prompt is open.

A typed exchange client owns ABI decoding, ERC20 approvals, pool transactions and receipt interpretation. Components pass domain values and render returned values, without constructing contracts or decoding logs. Quote and redemption rules live with their domain operations. Amount validation happens before wallet interaction.

TanStack Query owns asynchronous chain snapshots and quotes; they are keyed by deployment, account and pool, not copied into independent component state. Confirmed writes invalidate the relevant chain data. Reads and mutation failures remain distinct: a failed refresh cannot rewrite a confirmed receipt as a failed transaction. Current-page activity records approvals and execution separately and retains already confirmed steps when a later step is rejected. Only known pending transactions are checkpointed for same-tab observation after refresh, as scoped by [ADR 024](024-course-delivery-scope.md).

Feature pages own their form state. Shared components are limited to actual common controls and wallet/transaction presentation. Arbitrage results are structured reserve, price and profit records, so rendering does not depend on parsing display strings. Public browser flows remain the acceptance boundary.

These boundaries follow React's minimal-state guidance and EIP-1193 identity events. They do not introduce a backend, custom state framework or a second source of chain truth.
