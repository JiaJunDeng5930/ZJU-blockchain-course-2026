# ADR 016: Keep funding confirmation separate from balance refresh

A confirmed faucet transaction and an updated wallet balance are different
observations. A failed or delayed balance read must not turn a confirmed grant
into a failed claim or make automatic onboarding request the same grant again.
The preparation sequence also consists of separate transactions: rejecting a
later token claim cannot undo the ETH or tokens already received.

Return a confirmation for each successful funding operation and retain completed
steps while subsequent steps proceed or fail. Native funding identifies the
captured recipient and submitted value; ERC20 funding identifies the mint in the
target contract's receipt. Resolve token metadata before sending. Confirmation
does not depend on another balance or metadata read afterward.

Coordinate the existing funding plan with the confirmation block and wallet
identity. A snapshot predating a relevant confirmation requires a fresh balance
observation before automatic preparation can decide that funding is missing.
Once the snapshot catches up, its actual balances govern the next plan: a user
may already have spent the grant. Keep this decision in the extracted model and
reuse the existing identity policy. Explicit single-asset claims remain separate
user requests, rather than automatic retries.

The confirmation view is short-lived workflow state. The existing transaction
journal remains the durable record; this change does not establish a second
persisted inventory of assets or balances. Late replies belonging to another
wallet session must not credit the current session.

Show receipt sender, recipient and execution fee separately. The unlocked local
funder pays for an ETH grant, whereas the token claimant pays for its mint. The
recipient's ETH increase therefore cannot be treated as the funder's total debit.
