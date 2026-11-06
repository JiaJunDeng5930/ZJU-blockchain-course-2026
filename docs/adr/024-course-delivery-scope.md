# 024: Keep the coursework scope and the required formal development

The delivery target is an AMM Dapp with ERC20 funding, user-created pools,
ERC721 liquidity positions, a sustained multi-user simulation, and atomic
arbitrage across exchanges. Correct amounts, approvals, wallet identity,
transaction confirmation, slippage, deadlines, and failure handling are part of
making these operations usable. Pool liquidity provenance is explicitly required
by the assignment. Solidity and Rocq, including extraction of frontend business
decisions through OCaml and js_of_ocaml, remain an explicit development requirement.

Long-term cross-tab transaction archives, generic historical result recovery, a
standalone allowance-management workspace, and automatic best-pool selection for
ordinary swaps introduce independent product capabilities. They also expand the
models, interfaces, documentation, and acceptance work. Remove those capabilities
and their dedicated machinery while retaining the shared receipt decoding and
transaction behavior needed by the coursework operations. Ordinary swaps use an
explicitly selected pool; the required automatic arbitrage detection is retained.

A page refresh while a transaction is pending must not silently lose the known
transaction or cause another signature. Use the browser's per-tab session storage
for known pending transactions, and restore observation only. Completed activity
belongs to the current page's memory. Storage failure must not prevent a valid
transaction, and a failed observation must not be presented as a reverted call.
This preserves the necessary recovery behavior without maintaining a long-term
archive, archive migrations, or cross-tab history merging.

Successful workflow and wallet/blockchain screenshots are assignment deliverables,
not disposable test output. Keep a concise selection that demonstrates the
retained operations and their actual outcomes. Generated test screenshots and
temporary acceptance records remain outside version control.
