# Transaction activity navigation

Activity browsing is a read-only projection of the transaction journal already
owned by the wallet kernel. It does not reconstruct transactions from display
DTOs or create another journal. `Activity.v` consumes the exact
`(page-instance, Transactions.entry)` pairs returned by
`TransactionHistory.visible_entries`. Addresses use the existing wallet input
contract: `WalletController` canonicalizes them through viem before dispatching
wallet/receipt events. The model compares this canonical representation; it does
not prove viem's address codec or interpret arbitrary hexadecimal letter case.

## User behavior

The initial view shows all accounts and all statuses, with at most 20 records
per page. The account and status selectors are independent. Changing either
selector starts at the first page; Show all restores both selectors. The empty
state distinguishes an empty journal, no matching records, and an unavailable
current account. Previous and Next are disabled at the corresponding boundary.
No pagination controls are shown for an empty result.

Current account means involved in the transaction: the captured requesting
account or the actual sending authority. For a faucet transaction, the recipient
can find their receipt, and the local funding account can find the transaction
it sent. The existing sender → beneficiary display remains intact. The current
account comes from `Wallet.current_identity`; a disconnected, checking or wrong
network wallet supplies no current account. It never reuses the last connected
address.

| Status selector | Canonical transaction phases |
| --- | --- |
| In progress | Preflight, signature request, submitted hash |
| Confirmed | Successful receipt |
| Failed | Reverted receipt or rejected request |
| Submission unknown | Submission outcome unavailable |

Unknown submission is deliberately distinct from both failure and progress. A
receipt observation error does not move a submitted transaction into failure.
Changing the wallet address resets the requested page. Receipt changes retain
the page when it is valid and clamp it when the filtered list becomes shorter.
The canonical journal order is preserved; filtering does not impose a new
chronological order across independent page archives.

Different-call replacements remain visible under All with the original and
replacement hashes and any verified receipt quantities. They are not classified
as reverted receipts or rejected requests by the Failed selector. See
[transaction receipt reconciliation](TRANSACTION-REPLACEMENTS.md).

## Model, extraction and proof scope

`formal/theories/Frontend/Activity.v` defines selectors, events, normalization,
matching and the page projection. `WalletExtract.v` extracts it into the existing
wallet kernel. `WalletBridge.ml` only decodes query/events, reads canonical
entries/current identity and encodes the resulting page through the same
`entry_json` codec as the complete journal. It never assigns wallet or history
state, dispatches a transaction event, publishes a subscription or emits an
external effect. The TypeScript `activityView` and `activityStep` functions only
transport JSON to this closure. React renders the result and retains the
normalized query; no TypeScript filter, slice, page arithmetic or status
classification duplicates the model.

The checked results establish:

- Page entries are unchanged members of the original journal and satisfy both
  selected filters.
- Filtering includes every matching entry before pagination; selecting all
  accounts and statuses preserves the entire journal.
- Every page has at most 20 entries and its index is bounded by the last page.
  A page and the remaining suffix reassemble the original suffix.
- A current-account result involves that address; faucet beneficiaries match.
  A disconnected identity matches no current-account entries.
- Account changes reset the page index. An unchanged account retains a valid
  requested index. Normalization preserves the chosen filters.

These are proofs about the pure projection and its canonical input. They do not
prove the OCaml JSON codec, React rendering, browser accessibility, extraction
compiler or JavaScript runtime. They add no new claim about EVM execution or
contract verification. There is no new storage format or browser migration.

## Public acceptance

The independent public runner creates canonical journal entries through
`WalletKernel.start()` and `dispatch()`, then exercises the production extracted
bundle through `frontend/src/logic/activity.ts`. It is allowed to see the public
interfaces and goal, not this implementation. It verifies page traversal,
account/status selection, faucet sender and beneficiary, wallet switching and
disconnection, receipt-driven changes, and preservation of complete journal
records and wallet authority. No browser is used for fault discovery.

After building the production bundle:

```sh
contracts/node_modules/.bin/tsx frontend/acceptance/activity-public.mts
```

Pure model and production build:

```sh
npm run formal:build
npm --prefix frontend run build
```

The controls use native select/button elements and a named navigation region;
no custom pagination widget introduces a separate interaction state. The
accessibility terminology follows the [W3C WAI-ARIA specification](https://www.w3.org/TR/wai-aria/).
