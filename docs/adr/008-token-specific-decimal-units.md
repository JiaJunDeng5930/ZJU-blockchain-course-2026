# 008: Treat decimal precision as verified token metadata

Status: accepted and implemented.

The application previously accepted only 18-decimal tokens. That made the
display unit implicit in otherwise correct integer amounts. Importing a token
with a different precision requires changing that assumption throughout the
user workflow, rather than just removing the import restriction.

Keep the AMM's raw integer reserves, fees and liquidity accounting unchanged.
Attach the observed decimal precision to the existing token identity and use it
when converting human input, formatting quantities and expressing prices.
Different precisions must not change the raw-unit contract math. Native ETH and
the deployed WETH retain their explicit 18-decimal unit; NFT liquidity shares
do not acquire ERC20 metadata merely because they are integers.

Accept the `uint8` range of a readable standard `decimals()` response. The
[ERC-20 standard](https://eips.ethereum.org/EIPS/eip-20) makes this metadata
optional, so an unavailable response is an unsupported or unverified asset,
not evidence of 18 decimals. Stored display metadata is not sufficient evidence
to grant token capabilities. Observe missing precision again rather than
silently upgrading old browser records with an invented value.

Parameterize the existing Rocq unit conversion instead of introducing separate
parsers for stablecoins, WETH or individual precision values. Keep parsing exact
and bounded while allowing legitimate values at every supported precision.
Reject excessive fractional precision and uint256 overflow instead of rounding
user-entered transaction amounts. Display rounding must not turn a small
nonzero balance into a claimed zero or feed a transaction parameter.

Read deployment token metadata through the existing verified client bootstrap.
This lets the running development ledger continue to be used while replacing
the old metadata shape. New deployment output also records precision explicitly.
No production contract migration is needed.

The proofs cover the extracted conversion and frontend decisions under the
observed metadata contract. ERC20 metadata honesty, RPC, codecs, rendering and
the existing compiler trust boundaries remain external assumptions.
