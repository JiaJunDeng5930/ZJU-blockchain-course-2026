# ADR 017: Recover liquidity results from their original receipts

The wallet archive already persists transaction identities in an RPC, genesis
and deployment scope. Saving a second copy of position results would introduce
another record to reconcile with both that archive and the chain. Losing the
short-lived confirmation view on reload should instead lead to a fresh receipt
read, without changing the confirmed transaction's state.

Recover the result on explicit request from Activity. Reuse the same ABI event
decoder and confirmation renderer as the live write path. Select events from
configured exchange contracts in the extracted Rocq model; ignore the ERC721
mint/burn Transfer accompanying a deposit or redemption. A reverted receipt
cannot yield a successful result. The single-position interface reports a
receipt containing multiple independent liquidity actions explicitly, rather
than choosing an arbitrary one.

Amounts and participants come from the selected receipt event. Recover a
transfer's immutable pool identity from its indexed mint event: the NFT may
already have been burned by a later transaction in the same block. Read pool
state and token metadata at the receipt's block. Missing historical state or
metadata is a visible read error, with a
manual retry; it never substitutes current ownership or guessed token precision.

A confirmed journal entry can lack its transaction descriptor when that separate
RPC read failed. Keep manual receipt recovery available in this existing unknown
state. The receipt selector still requires actual evidence from configured
exchanges; an available read action does not assert that an NFT operation exists.

The proofs establish selection and configured-exchange provenance over decoded
observations. ABI decoding, historical RPC responses and their binding to the
receipt remain external interface assumptions. This does not extend the existing
Solidity-to-Rocq arithmetic proofs to whole EVM execution or chain finality.

References: [viem receipt reads](https://viem.sh/docs/actions/public/getTransactionReceipt),
[ABI event parsing](https://viem.sh/docs/contract/parseEventLogs), and the
[ERC721 Transfer event](https://eips.ethereum.org/EIPS/eip-721).
