# 006: Restore transaction observations without restoring authority

Status: accepted and implemented.

A transaction outlives the page that submitted it. Losing its hash on refresh makes an ordinary pending transaction indistinguishable from a submission whose outcome is unknown. Restoring the old wallet operation would introduce a different problem: a page could continue an approval or signature sequence without a fresh user action.

Keep the existing Rocq transaction entry and lifecycle as the source of meaning. Persist their observations, while excluding active operations and signing permissions from recovery. A recovered known hash is evidence to query, rather than a reason to repeat a wallet request. Any unfinished entry without a saved hash does not establish that broadcasting failed. Even a preflight snapshot may be stale: a later storage failure can leave that snapshot intact while the page continues transacting in memory. Recover these entries as unknown outcomes, not as evidence of non-submission.

Each document has a fresh browser-generated instance identifier and writes only its own archive. A recovered archive belongs to an observer, which never writes back to the original document's archive. This avoids lost updates between tabs, preserves a live document's authority over its own workflow, and avoids holding a global lock while a wallet waits for the user. Visible record identity includes both the instance and its local transaction identifier. The [HTML Web Storage standard](https://html.spec.whatwg.org/multipage/webstorage.html#the-localstorage-attribute) explicitly advises authors not to assume locking across agent clusters; a shared read-modify-write archive would require additional coordination.

Scope archives by a fingerprint of the configured RPC endpoint, the chain and its genesis hash, and the deployed exchange set. Different local endpoints may share a genesis and deterministic deployment addresses while diverging later; conservatively keep their archives separate without storing endpoint URLs. A chain ID alone does not identify a local chain after a reset, and an account switch must not relabel earlier transactions as belonging to the newly selected account.

Storage is a convenience, not a prerequisite for exchanging or redeeming assets. Denied storage access, exhausted quota, or an unreadable archive must be visible. Preserve unreadable data, keep the existing wallet authorization rules, and allow clearly identified in-memory operation. Claim persistence only for writes acknowledged by the storage interface.

The browser supplies instance freshness and atomic replacement of one storage key; RPC supplies chain identity and receipt observations. These are explicit external contracts. The Rocq layer determines recovery, identity checks and effects. The adapter cannot infer failure from a missing receipt or infer signing authority from saved data.

An acknowledged write means that the browser storage API accepted the value. This is not a backup against cleared browser data or an operating-system failure.

The implementation is checked by the recovery theorems in `TransactionHistory.v` and the public SDK scenarios documented in [the acceptance guide](../../frontend/acceptance/README.md). These scenarios exercise real receipt delivery and storage across process boundaries; they do not replace the model proofs or certify browser internals.
