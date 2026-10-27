# 007: Make residual ERC20 allowances visible and explicitly revocable

Status: accepted and implemented.

An approval and the operation that spends it are separate transactions. Rejecting
or reverting the latter leaves an earlier confirmed allowance in place. The
application already explains this in its transaction history, but users also
need to inspect and remove the remaining permission.

Use the existing supported token catalog and the current deployment's exchange
and arbitrage addresses. This gives the page a precise scope without pretending
to discover every spender on a wallet. Do not introduce an external indexing
service, an arbitrary-spender editor, or a second asset registry for this task.

Offer an explicit zero-approval action, following the
[ERC-20 allowance and approval interface](https://eips.ethereum.org/EIPS/eip-20).
Do not automatically revoke after a cancelled swap: that would create another
transaction and wallet request without the user's chosen action. A zero allowance
does not undo previous transfers or cancel transactions already broadcast.

Reuse the wallet operation and journal for submission and confirmation. Bind
observations and plans to the requesting identity, token and spender; account
changes must not reinterpret an old plan as authority for the new account.
Unreadable allowances remain unknown, rather than becoming zero. Check token
call results and distinguish transaction confirmation from the subsequent
allowance observation. Only an actual zero observation establishes the displayed
revocation result. A failed observation does not erase a confirmed receipt.

Let consumers own observation subscriptions. React can discard a render or
repeat subscription setup and cleanup in
[StrictMode](https://react.dev/reference/react/StrictMode). Allocating a controller
must therefore leave no external subscription behind. Subscription cleanup and
later setup must work on the same instance, while an SDK consumer without a
subscription must still be able to read the current wallet identity.

Keep those decisions in the extracted Rocq frontend model. RPC observations,
wallet transport, address encoding, JSON adapters and rendering remain explicit
external boundaries. This feature adds no claim that the full ERC20 or EVM
implementation has been proved in Rocq.
