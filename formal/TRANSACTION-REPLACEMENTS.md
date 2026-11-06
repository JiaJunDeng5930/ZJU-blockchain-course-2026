# Active transaction replacement observation

A wallet may replace an active transaction by repricing it or by submitting another call with the same sender and nonce. The application uses viem's native replacement-aware receipt observation.

The original operation can succeed only when the replacement represents the same recorded call and its receipt succeeds. A cancellation or different call is shown as replacement of the original operation, not success of that operation. A failed receipt remains a failure. Confirmation of an earlier approval is not undone by a later cancellation.

`theories/Frontend/TransactionReplacement.v` and the extracted transaction model decide how a replacement observation changes the operation state. The interpreter supplies the wallet/RPC result. Missing receipts and observation errors do not fabricate a failed transaction or authorize a new signature. Refresh restoration observes known pending transactions without resuming the old workflow.

The application does not search historical blocks by nonce or maintain a replacement-history archive. See [pending transaction recovery](PENDING-TRANSACTIONS.md) and [ADR 024](../docs/adr/024-course-delivery-scope.md).

Run the retained public-entry acceptance from the repository root:

```bash
npm run test:replacements
```

The external viem, wallet and coherent-chain assumptions remain outside the Rocq proof boundary.
