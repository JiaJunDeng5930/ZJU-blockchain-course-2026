# Transaction history and refresh recovery

The transaction journal now survives a page refresh when the browser has
acknowledged its storage writes. Recovery restores public transaction records;
it never restores an executable operation or wallet authorization. The reasons
for the per-page writer design are recorded in [ADR 006](../docs/adr/006-persistent-transaction-history.md).

## Executable specification

[TransactionHistory.v](theories/Frontend/TransactionHistory.v) composes the
existing `Transactions.state` and wallet authorization rules. Its decisions are
extracted through `WalletExtract.v` into the same OCaml / js_of_ocaml bundle as
the other frontend models. React displays the resulting history status and
available actions. The TypeScript controller interprets storage and RPC effects.

Each page receives a fresh UUID and exclusively writes its own archive key.
Visible row identifiers combine that UUID and the original local transaction
identifier. A new page reads earlier archives into read-only transaction states;
it does not reuse their counters or active operations. Receipt observations of
another page never write that page's archive. Concurrent pages therefore retain
their separate records without holding a lock across wallet interaction.

The scope includes the chain's genesis hash, deployment identity and a keccak256
fingerprint of the configured RPC URL. Different RPC URLs intentionally have
separate histories, including aliases for the same chain. The scope stores the
fingerprint instead of the configured URL. Only matching scopes, chain identities, bounded unique IDs and
well-formed public transaction metadata are accepted.

On recovery:

- A saved preflight or signature request without a saved hash becomes
  submission-unknown. Later storage failure may have allowed the original page
  to continue in memory. Another page or wallet may still complete it; recovery
  never labels it failed and never sends it again.
- Every saved hash, including a previously confirmed or reverted transaction, is
  checked against the current RPC. Missing receipts remain submitted with an
  explicit observation error after the bounded wait. A reset development chain
  therefore does not inherit an unchecked terminal result from an old archive.
- The captured account, source, sender, authority and local identifier remain
  attached to the record when the current wallet or account changes.

## Proven properties

The file contains 24 closed theorems. The acceptance run checked every theorem
with `Print Assumptions`; all reported `Closed under the global context`.
The properties include:

| Requirement | Proof entry points |
| --- | --- |
| Archived records carry no operation and cannot request or authorize a write | `restore_has_no_operation`, `restored_archive_cannot_request_a_write`, `restored_archive_cannot_authorize` |
| Recovery preserves the captured identity and sender | `restored_identity_unchanged`, `restored_authority_unchanged`, `restored_sender_unchanged` |
| A saved signature request never resumes signing | `restored_preflight_is_unknown`, `restored_signature_is_unknown`, `restore_never_waits_for_signature` |
| Foreign scopes and invalid record identities are not accepted | `archive_chain_and_scope_checked`, `restore_id_bounded` |
| Late loading and storage failure preserve the current operation | `loading_does_not_replace_current_operation`, `load_failure_keeps_inflight_operation`, `failed_storage_preserves_current_state` |
| Read-only receipt observation cannot change current transactions or request persistence | `foreign_receipt_is_read_only`, `foreign_failed_observation_is_read_only` |
| Observation failure cannot downgrade a confirmed record | `confirmed_entry_cannot_be_downgraded_by_observation` |
| Storage failure does not revoke a valid core authorization decision | `failed_storage_preserves_authorization_result`, `memory_mode_preserves_core_result` |
| Different page namespaces distinguish visible transaction identifiers | `separate_instances_have_distinct_visible_ids` |

## Storage failures and operational limits

The status explicitly distinguishes loading, saving, stored and memory-only
operation. A browser that denies storage, a quota failure, or an unavailable
scope lookup does not disable trading or redemption. Original wallet rules
continue to determine authorization. Unacknowledged writes are never presented
as stored. A retry can save the current page's accumulated records once storage
is available again.

Malformed archives remain byte-for-byte untouched. Valid archives can still be
loaded and the current page can use its own fresh key, with a visible warning.
An archive contains only public transaction DTOs, never private keys, wallet
clients, callbacks or a continuation for unfinished business steps.

There is no live cross-page UI synchronization or automatic archive deletion.
Refresh reads completed writes from other pages. If another page writes while
that scan is in progress, its latest records appear on the next refresh.
Quota exhaustion falls back visibly to memory mode. Historical receipt updates
are observations in the recovering page; the original writer remains the sole
owner of its stored archive. Recovery will check those hashes again next time.
The receipt wait is bounded to 180 seconds and can be requested again through
the journal. Clearing browser data removes its saved history.

## Verification boundary and reproduction

The proofs cover the extracted model and its stated input contracts. They do
not prove browser storage, the JSON codec, viem, RPC correctness, UUID freshness,
React rendering or the OCaml / JavaScript compilers. The browser storage contract
requires atomic per-key `setItem` with synchronous success or a reported failure,
and retained acknowledged values until explicit clearing. Each runtime must use
a fresh UUID and write only its own key. RPC observations supply the actual hash,
sender, status and gas fields of the scoped chain. These assumptions do not turn
an archived identity into signing permission.

Build and check the pure models and the actual extracted bundle:

```sh
npm run formal:build
npm --prefix frontend run build
```

The [public SDK acceptance](../frontend/acceptance/README.md) deploys to an
isolated real chain and uses native Node WebStorage across processes. It covers
refresh while a transaction is still pending followed by automatic confirmation,
independent page records, original sender and faucet beneficiary, unavailable
storage with a working transaction, a page exiting before an accepted submission
returns its hash, preserved malformed archives, and endpoint isolation. It checks
that recovery sends no wallet writes and compares receipts with the chain.
No browser-based fault discovery is used.

```sh
node --import ./contracts/node_modules/tsx/dist/loader.mjs frontend/acceptance/history-public.mts
```

The shared public wallet entry point remains
`new WalletController(client, { storage })`; `start()` initializes wallet and
archive loading, and `perform()` follows the existing authorization path.
`start()` does not wait for potentially long historical receipt confirmation.
