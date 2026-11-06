# Token decimal precision

Imported ERC20 assets use the decimal precision observed from their deployed
`decimals()` method. The accepted range is the ERC20 `uint8` range, 0–255.
A failed metadata read does not imply 18 decimals. Native ETH, the deployed
Wrapped Ether and the default TestToken contracts retain their defined 18 places.
New TestToken creation keeps its existing constructor and 18-place behavior.

## Units and workflow

Contract amounts, reserves, fees and liquidity shares remain raw integers. For
example, one unit of a 6-place token is 1,000,000 raw units; one unit of an
18-place token is 1,000,000,000,000,000,000 raw units. Neither the AMM formula nor
the on-chain NFT accounting changes when these tokens share a pool.

The shared `Units.v` model takes precision explicitly for parsing, exact
formatting, compact rendering and human price ratios. Token input rejects extra
fractional digits and values outside uint256. Parsing work is bounded by
100 plus the number of decimal places, allowing the full 255-place least-unit
representation while rejecting arbitrarily padded external input. Max and
reverse direction use exact text; compact rendering does not replace a nonzero
amount by zero. A positive amount smaller than the visible display threshold is
shown with `<`, while its exact amount remains available in full amount fields.

Swap drafts carry both token precisions. Deposit input and proportional
counterpart amounts use their respective token's precision. Redemption returns
raw amounts; the interface formats each with its own token metadata. Position
value and value change retain their existing token1 denomination. NFT shares
are raw share counts, not ERC20 quantities with an invented decimal precision.

Pool prices and execution rates compare human units, including precision
scaling. A pool with equal human amounts of 6- and 18-place assets therefore has
a unit price, rather than a price of 10^12. The public `formatPrice` entry point
uses this same extracted model; TypeScript does not supply another price formula.
Arbitrage candidate capital sizes and minimum
profit use the principal token's precision, and actual results use that same
principal. Authorization amounts use the same verified token metadata.

The simulator deliberately operates the first two deployment TestTokens and
their seeded A/B pools. Those production contracts have 18 decimals, so the
simulator's existing native-unit amounts remain valid. Importing another token
does not add it to the simulator's workload.

## Metadata and restoration

`Token.decimals` is explicit. `ExchangeClient.verifyDeployment()` first verifies
the expected deployed runtimes and then observes the deployment tokens' metadata
at that block. This also initializes existing deployment JSON files that predate
the precision field, without resetting the chain. Fresh deployment output
includes the default contracts' explicit precision.

The catalog continues to separate saved metadata from verified active tokens.
Restored addresses, including old entries without precision, appear as discovery
targets and are observed again through the ordinary metadata path before they
become active. Saved precision cannot grant trading or faucet capability.
External tokens with readable non-18 metadata remain external assets.

Address encoding uses the existing viem codec. Imported tokens, catalog output,
Swap selection and snapshot balance lookup compose across checksummed and
lowercase forms without requiring callers to repair outputs from another public
method. This codec is an external boundary, not an additional Rocq assumption
about arithmetic.

## Proof and validation scope

The changed shared modules contain 104 audited lemmas and theorems, all reported
`Closed under the global context`. This is a recheck of existing and generalized
results, not a claim that 104 new properties were proved. In particular:

- `positive_units_sound` connects accepted precision-dependent text to a positive
  uint256 amount and `decimal_represents`.
- `accepted_precision_is_uint8` and `supported_asset_has_valid_decimals` establish
  the accepted metadata range and retained asset precision.
- `equal_human_units_have_unit_price` establishes precision cancellation for equal
  human quantities.
- Existing Swap readiness, requested quote, LP input planning and arbitrage
  profitability properties continue to apply with explicit precision.

The runtime is built by the existing extraction/OCaml/js_of_ocaml pipeline.
The model does not prove RPC metadata honesty, JSON/address codecs, React,
integer-to-decimal library internals, the compilers or full EVM behavior.
Concrete formatting/parse round trips and complete mixed-precision workflows
are checked through the independent public SDK acceptance. A general string
formatter round-trip theorem is not claimed.

```sh
npm run formal:build
npm --prefix frontend run build
contracts/node_modules/.bin/tsx frontend/acceptance/precision-public.mts
```

The independent runner deploys ordinary OpenZeppelin test assets with 0, 6, 8,
and 255 decimals alongside the actual production exchange artifacts on an
isolated chain. It covers metadata failures, least units and overprecision,
legacy catalog restoration, mixed human prices, precise Max, real swaps and
LP redemption, exact authorization amounts, and atomic arbitrage
with a 6-place principal. A 255-place asset is exercised with raw least units;
it is not claimed to hold a whole human token beyond uint256 capacity.
