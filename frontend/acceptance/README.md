# Frontend public acceptance

## Explicit pool locations

Run `npm run test:pool-location`, or invoke
`contracts/node_modules/.bin/tsx frontend/acceptance/pool-location-public.mts`
after building the current sources. Three isolated real-chain scenarios pass
URL query values through the public pool-selection entry point, then check an
explicit-pool swap against actual events and reserves, re-resolve the same URL
against an updated snapshot, and reject a real pool outside the active
deployment without wallet writes. An explicit removal of the parameter permits
default selection. Results are saved to
`.local/pool-location-public-*/result.json`.

This checks the domain-to-SDK binding. It does not prove browser push/pop or
React Swap's separate Best quote routing policy. The pure selection properties
are proved in Rocq rather than repeated as implementation-shaped unit tests.

## Confirmed creation and metadata discovery

Run `npm run test:creation-results`, or invoke
`contracts/node_modules/.bin/tsx frontend/acceptance/creation-results-public.mts`
after building the current sources. This independent runner uses the public
wallet/exchange interfaces, real receipts and an isolated RPC proxy.

Three scenarios check successful deployment despite a subsequent metadata-read
failure, identity of equal pool IDs on different exchanges followed by first
provision, and a real duplicate-pool race that mines the original call with
status zero. Metadata recovery reads the same deployed address without another
creation transaction. The ordinary cold-start deployment input is retained as
the external check for the extracted long-calldata validator; no Node stack or
optimization flags are added. Results and runtime source fingerprints are saved
to `.local/creation-results-public-*/result.json`.

## Preparing liquidity from available balances

Run `npm run test:liquidity-balances`. With an already built kernel and contract
artifacts, run
`contracts/node_modules/.bin/tsx frontend/acceptance/liquidity-balances-public.mts`
directly.

The public `depositBalancePreview` entrypoint takes observed raw balances as
spending limits. The runner carries those original limits through the public
wallet writer into actual deposits and NFT redemptions on an isolated chain.
It checks mixed token precision, non-divisible integer reserve ratios, actual
transfers, unused wallet funds and NFT ownership without copying the production
liquidity formula. Approvals are checked against captured desired limits,
actual transfers against used amounts, and residual allowances against their
difference. Empty pools require explicit starting amounts; unavailable
balances do not fabricate a usable quote. These are public business API and
chain-effect checks, not browser tests or a proof of EVM behavior.

## First-deposit ownership

Run `npm run test:initial-liquidity` from the repository root. With an already
built, unchanged kernel and contracts, run
`contracts/node_modules/.bin/tsx frontend/acceptance/initial-liquidity-public.mts`
directly.

The runner uses the public deposit preview, wallet and exchange interfaces on an
isolated real chain. It compares projected ownership with actual mint events,
NFT owners, subsequent redemption receipts and token balance changes. Five
scenarios cover rejection before any approval when the initial lock cannot be
funded; a zero-decimal `1001/1001` deposit whose one-share NFT redeems `1/1`;
later provision without another initial lock; equal NFT identifiers on different
exchanges; and ordinary 6/18-decimal assets. It does not reproduce the square-root
algorithm as an oracle or use browser assertions.

Results and runtime source fingerprints are saved to
`.local/initial-liquidity-public-*/result.json`. The projection is conditional on
the quoted pool state; these scenarios deliberately perform no intervening swap
between preview, mint and redemption. Mathematical projection properties are
checked separately in Rocq.

## Simulation failure evidence

Run `npm run test:simulation-failure`, or invoke
`contracts/node_modules/.bin/tsx frontend/acceptance/simulation-failure-public.mts`
after building the current production sources. This runner uses HTTP and real
JSON-RPC directly; it does not execute the frontend kernel or inspect worker
implementation internals.

Three scenarios check receipt retention beyond the 100-entry progress window
after a real RPC outage, preparation funding failure before any chain write,
and an unchanged transaction mined after its deadline. Receipt hashes and
liquidity identities are checked against the chain, including status-zero gas
and the distinction between a recorded burn and current NFT ownership. Old job
IDs cannot retrieve a replacement job's journal. Results and service source
fingerprints are saved to `.local/simulation-failure-public-*/result.json`.
The kernel SHA in that record identifies the environment, not coverage of the
extracted frontend.

## Transaction deadlines after approvals

Run from the repository root after building the current contracts and extracted frontend:

```sh
npm run build
contracts/node_modules/.bin/tsx frontend/acceptance/deadlines-public.mts
```

The runner uses `WalletController.perform` and the existing liquidity, swap and atomic-arbitrage writers against an isolated real chain. Its RPC fixture broadcasts each required approval with automining disabled, advances the next ordinary mined block by 1,500 seconds, mines the approval and resumes normal mining. This represents an approval confirmation taking longer than the business transaction's 20-minute lifetime without waiting 20 wall-clock minutes.

The three scenarios check two successive liquidity approvals, one swap approval and one arbitrage approval. They verify the submitted business call's deadline against its actual pending chain time, successful receipts and resulting NFT, token balances, pool reserves or arbitrage profit. Captured calldata must preserve the confirmed amounts, slippage minima and arbitrage route/minimum profit. The swap scenario also provides an existing-behavior control. The runner does not read the business implementation to derive these criteria and does not use a browser. It complements the Rocq deadline and parameter-preservation proofs by checking the external clock and wallet-call binding.

Results, the loaded extracted-program SHA256 and fingerprints of the wallet/effect source files are written to `.local/deadlines-public-*/result.json`; these local artifacts are not committed. This distinguishes effect changes even when proof erasure leaves the generated program unchanged. The fixture uses ordinary `evm_mine` blocks and does not change the main development chain or its services.

## Transaction history

Run from the repository root with Node.js 26 and installed project dependencies:

```sh
npm run build
node --import ./contracts/node_modules/tsx/dist/loader.mjs frontend/acceptance/history-public.mts
```

The build supplies the production contract artifacts, generated ABI, and extracted JavaScript. The acceptance command deploys those artifacts to its own Hardhat node on an available port. It leaves the development node and `shared/deployment.json` untouched. It uses the public `ExchangeClient` and `WalletController` SDK, real JSON-RPC, and Node's native WebStorage shared by independent processes. It does not open a browser or import internal history helpers.

The scenarios exercise a broadcast transaction surviving process destruction while still pending, automatic receipt observation after mining, two controllers retaining separate records, faucet sender versus beneficiary, unavailable storage, a submission accepted after its page exits without receiving the hash, malformed stored data, and isolation between RPC endpoints sharing the same ledger. Recovery must not issue wallet writes or overwrite the original page's archive. The recorded receipt is compared with the chain response.

Each run prints the location of `.local/history-public-*/result.json`. That directory retains phase results, logs, node startup metadata, and the actual WebStorage file. Results include the SHA256 of the extracted JavaScript; every phase must use the same unchanged bundle. The runner stops its node, workers, and proxy when finished. These local execution artifacts are not committed.

For the runner's TypeScript check:

```sh
frontend/node_modules/.bin/tsc --project frontend/acceptance/tsconfig.json
```

Some restricted execution sandboxes reject Hardhat's filesystem watcher with `EMFILE` even for a single empty directory. Run the acceptance command in a normal local terminal, or grant the execution tool access outside that sandbox. Do not change the system file limit or the development node's mining state.

## Activity navigation

After the production build, run:

```sh
contracts/node_modules/.bin/tsx frontend/acceptance/activity-public.mts
```

This runner drives the public `WalletKernel` with wallet observations, operation requests, submissions, receipts and storage acknowledgements, then uses the public `activityView` / `activityStep` entry points. Both execute the production Rocq-extracted JavaScript. It imports no private model or bridge helpers and opens no browser. The observations are supplied at the documented frontend transport boundary, including its requirement for canonical Ethereum addresses; this runner does not claim to validate a wallet, RPC server, React rendering or browser behavior.

The scenarios cover 45 mixed transaction records across three pages, every status group, faucet senders and beneficiaries, reobserving a canonical account, wallet switching and disconnection, empty-result reset, non-mutating navigation, and receipt updates that preserve a valid page or clamp a vanished page. A separate 41-pending-transaction scenario checks shrinking results. An archive emitted by the real public kernel is recovered into a new kernel and remains navigable without restoring an active operation. Expected scenario results are defined from these public behaviors; the runner does not read the filtering or pagination implementation.

Each run records its scenario results and extracted-bundle SHA256 in `.local/activity-public-*/result.json`. These local execution artifacts are not committed. Run the TypeScript command above to check both acceptance runners.

## Token allowance management

Build the production artifacts and extracted bundle, then run:

```sh
npm run build
contracts/node_modules/.bin/tsx frontend/acceptance/allowances-public.mts
```

This runner starts its own Hardhat node and invokes the public `ExchangeClient`,
`WalletController` and `AllowanceController` SDKs through a real RPC proxy. It
checks observed allowances and revoke transactions against actual chain state,
including WETH and a pre-existing maximum uint256 allowance. Other owners,
spenders, token balances and populated pool reserves must remain unchanged.
Cancelling, selecting a zero allowance or selecting an unsupported spender must
not send a transaction. Account changes and delayed observations must not reuse
another owner's records or prepared operation.

A small test-only ERC20 fixture returns `false` from `approve`, as permitted by
ERC-20. It is compiled separately with the installed native compiler, outside
production contract sources. Controlled RPC faults distinguish an unavailable
allowance from zero and a confirmed transaction from an unverified post-read.
These are faults at external interfaces; the extracted business logic is not
mocked. The runner does not read private model state or open a browser.

Each run retains its compiler output, isolated chain log, RPC wallet-write log
and `result.json` in `.local/allowances-public-*`, including the extracted bundle
SHA256. Setup transactions use the upstream node directly, so wallet-write
counts represent only SDK operations through the proxy. The main development
node and `shared/deployment.json` are unchanged.

## ERC20 token precision

After building the production frontend and contract artifacts:

```sh
contracts/node_modules/.bin/tsx frontend/acceptance/precision-public.mts
```

The runner deploys the production exchanges to its own local node. Its test-only
OpenZeppelin tokens expose precisions 0, 6, 8 and 255; a separate token refuses
the optional `decimals()` metadata read. Imports, unit conversion, swap previews,
liquidity previews, allowance management and atomic arbitrage use the public
production SDK and its extracted JavaScript. No new model, bridge, SDK
implementation or React source was used to choose the expected results.

The scenarios check legacy metadata recovery without an assumed precision,
smallest representable units and uint256 limits, preservation of a six-decimal
balance above JavaScript's safe integer range, mixed 6/18 reserves with a human
price of one, exact swap balance deltas against an on-chain quote, NFT redemption,
finite and unlimited six-decimal allowance revocation, actual 0/8-token trading,
and six-decimal arbitrage principal and profit. Precision 255 is checked through
actual metadata and raw balances plus exact input/formatting; the runner does
not claim a wallet can hold one whole token at that precision.

Each `.local/precision-public-*/result.json` records the scenarios, raw values,
receipts and production bundle hash. The node, compiler output and logs remain
in that local directory. Cleanup stops only the runner's node; the development
RPC, deployment file and browser are untouched. These checks exercise public
behavior and adapter assumptions; they do not prove React rendering, RPC honesty,
the compiler, or EVM semantics.

## Realized swap price and quote comparison

Run `npm run test:swap-settlement`, or run
`contracts/node_modules/.bin/tsx frontend/acceptance/swap-settlement-public.mts`
after building the production kernel and contract artifacts.

The public routed-swap flow captures a quote before actual execution. Another
actor can move the market between those steps, producing unchanged, improved or
worse output while the original minimum remains binding. Actual events and token
balances establish the settlement amounts and signed output-token difference.
The realized rate is checked with token-specific precision, separately from the
pool's reserve price. Historical sender ETH balances establish the execution fee
and exclude approvals in earlier blocks; the public journal must agree.

The runner does not copy the production AMM or fee formula. These observations
accept the public result and rendering-data adapters, not DOM behavior, RPC
honesty or EVM semantics. A quote difference is not a cross-currency profit.

## Swap route selection

After building the production frontend and contract artifacts:

```sh
contracts/node_modules/.bin/tsx frontend/acceptance/routing-public.mts
```

The runner uses a real isolated ledger, the production extracted route controller,
and the public wallet/writer SDK. A thin mixed-precision pool has a better initial
exchange ratio than a deeper pool. Public contract quotes establish that the
best output changes with the input size; the expected outputs do not come from
a second AMM formula in the test. Actual execution is checked against token
balance deltas, pool reserves, and the submitted contract/arguments.

The scenarios also cover anonymous and unfunded-wallet quoting, pair choices
before entering an amount, pair deduplication, manual selection including an
unavailable pool, reverse and exact Max, unrelated or unregistered pools,
unverified metadata, deterministic equal quotes, and resetting a manual choice
on a new pair. A recording RPC endpoint delays the response to a real approval
while an independent account changes another market. The captured effect,
pending display, and submitted swap must retain the original route and minimum.
Another scenario changes wallets after approval and requires the old operation
to stop before any swap is sent.

Successful results are checked against the actual receipt's Swap event and
sender token balance changes for both six- and eighteen-decimal inputs. A real
trade changes the captured pool during approval, improving the eventual output;
the returned actual amount must differ from the old quote while retaining the
original quote and minimum. This checks the execution evidence passed to the UI
without treating a quote as a settlement oracle.

The runner does not read the new route model, bridge, SDK implementation or React
to choose its assertions. It does not use a browser, replace business logic, or
touch the development node. Each `.local/routing-public-*/result.json` retains
the production program hash, raw quotes, submitted calls, and scenario results.
These are external-behavior checks; they do not prove RPC honesty, React
rendering, compilers, or EVM semantics.

## Transaction replacement confirmation and recovery

After the production build, run with Node.js 26:

```sh
contracts/node_modules/.bin/tsx frontend/acceptance/replacements-public.mts
```

The runner drives the existing `WalletController.perform` and history recovery
entry points on an isolated real chain. It pauses mining and sends a higher-fee
transaction with the original sender and nonce, as a wallet speed-up or cancel
would. Same-call repricing must retain the new receipt and permit the original
approved flow; a different call must not be credited as the original swap or
allow its next write. Wallet changes and a read failure after confirmation must
preserve the existing authorization and confirmation rules.
The existing ERC20 creation flow also checks the valid null recipient of a
creation transaction and its actual returned contract address after repricing.

Recovery uses native WebStorage and separate processes. The producing page exits
only after its public pending descriptor is saved. A replacement is then mined,
followed by more blocks, and the RPC endpoint no longer returns the old hash.
The new observer must find the past replacement without signing, sending,
resuming the old operation, or rewriting the original page's archive. A faucet
case deliberately uses a funding sender different from its beneficiary. Another
case saves an already Replaced outcome and checks that a successful replacement
receipt cannot turn it into success for the old operation. A real version-one
archive fixture has no nonce metadata and must retain an unknown outcome.

The existing chain is advanced before these recovery cases so a full scan from
genesis is distinguishable from bounded lookup. Request counts are only a
resource bound for the recovery path, not a nonce indexing benchmark. The
evidence under `.local/replacements-public-*/` includes raw receipts, hashes,
public journal records, RPC reads, wallet writes and the production bundle hash.
No browser, private model state or replacement business-logic mock is used.

## Simulation control

After the normal production build, run:

```sh
node --import ./contracts/node_modules/tsx/dist/loader.mjs frontend/acceptance/simulation-public.mts
```

The runner uses the public `SimulationController` and `performSimulation` interfaces against the real HTTP service, worker and an isolated Hardhat chain. It copies the unchanged service scripts into a private fixture so their deployment and report files cannot affect the main application. Its Node transport supplies the same-origin URL and POST Origin that the browser and Vite proxy provide; it does not fake service responses or blockchain observations.

A normal twenty-round run exercises twenty funded addresses. A fresh controller observes the same run and progress without issuing a command. Completed reports are checked against actual receipts, reserves, token profits, gas costs and the original NFT balances after position cleanup, then remain observable through 300 successive read-only HTTP requests. This spans the previously observed 256-request decoder failure without creating another run. A subsequent run rejects the old run's stop and report identities with HTTP 409. The current run is then stopped while a real transaction awaits mining: it must remain stopping until that transaction settles and its positions are redeemed, and the final report must belong to that run. The fixture resumes continuous block production, rather than assuming that enabling automining alone advances already submitted transactions and receipt subscriptions.

This checks the service and worker obligations at the Rocq model's external boundary, rather than repeating the model's pure transition proofs. It does not test React, browsers, wallet extensions or arbitrary external RPC providers. Results, source and generated-kernel fingerprints, HTTP observations, service logs and chain logs are saved in `.local/simulation-public-*/`. Both spawned process groups are stopped and the isolated node's exit is observed before a successful result is published.

## Exact capital for manual arbitrage

```sh
npm run test:arbitrage-capital
```

This runner uses the public `quoteArbitrage` and wallet writer entrypoints on an
isolated real chain. It checks nonpreset capital amounts for 18- and 6-decimal
tokens, replacement quotes for changed amounts, no-profit markets, rejected
amount inputs, and an unfunded caller that must not send approval or execution
transactions. Actual token transfers and pool events establish that the quoted
capital reaches both legs of one atomic execution and that the reported profit
matches the caller's balance change. No production quote formula is copied into
the oracle. These checks bind the extracted logic to the public adapters and
chain effects; they do not validate DOM behavior or prove EVM semantics.

## Realized atomic arbitrage amounts and execution fee

After building the production frontend and contract artifacts, run:

```sh
contracts/node_modules/.bin/tsx frontend/acceptance/arbitrage-evidence-public.mts
```

Set `DEX_EXPECTED_KERNEL_SHA256` to a frozen production bundle SHA-256 when
accepting a particular build. The runner records the loaded kernel and relevant
source fingerprints and checks that those files stay unchanged during execution.

The two scenarios use 18-decimal and 6-decimal capital respectively, real pools
on two exchanges, and the public `WalletController.perform` / writer entrypoint.
ERC20 approval is a real, separately confirmed transaction before the observation
window. The wallet sends exactly one transaction during that window. Its native
ETH balance decrease independently checks `gasCostWei`, excluding the approval
fee. No duplicate settlement or gas multiplication model supplies the oracle.

The result's `amountIn` and `amountOut` must match both `ArbitrageExecuted` and
the actual capital-token transfers into and out of the arbitrage contract. Its
`profit` must match the capital-token balance increase. Both swap legs must be
logged in the same successful execution receipt. Before/after reserves must
match the reserve events and direct historical contract reads for each pool.
Token quantities retain their token precision; the ETH fee is recorded in wei,
with no currency conversion or combined net-profit claim.

Receipts, approval evidence, balances, pool states and fingerprints are saved
under `.local/arbitrage-evidence-public-*/result.json`; the isolated node's log
and fixture compiler output stay in that directory. The runner stops its own
node and wallet controller and does not use the browser or development services.
This accepts the public transaction-result boundary, not React rendering,
wallet-provider honesty, compiler correctness or EVM semantics.

## Asset preparation and pool creation

After building the frontend kernel and contract artifacts:

```sh
contracts/node_modules/.bin/tsx frontend/acceptance/asset-setup-public.mts
```

One isolated ledger exercises the public wallet/writer interfaces from an
unfunded account through ETH and ERC20 funding, a new eighteen-decimal test
token with zero initial supply, token import, and an empty pool on the selected
DEX. Deployment receipts, on-chain metadata, account balances and actual pool
records provide the evidence. The administrative ETH faucet may mine an empty
block; it must not invent a wallet transaction or change another account.

Real wrapping and unwrapping are checked using transaction value and calldata,
successful receipts, ERC20 mint/burn Transfer logs and native/token balances.
Wrapping the entire ETH balance and unwrapping with no ETH for gas must reject
before sending: the public wallet error and pending state, nonce and balances
are observed independently. No second gas-budget model supplies the oracle.
Evidence and source fingerprints remain under `.local/asset-setup-public-*/`;
the runner does not use the browser or development services.

## Execution fees for liquidity actions

Run `npm run test:liquidity-fees`. With the production kernel and contract
artifacts already built, run
`contracts/node_modules/.bin/tsx frontend/acceptance/liquidity-fees-public.mts`.

The public wallet and writer flow mints an NFT after actual ERC20 approvals,
transfers it to another funded account, then lets the new owner redeem it.
For each value-free execution, the runner compares `gasCostWei` with the
sender's historical ETH balance decrease across that execution block. Approval
transactions occur in earlier blocks and are excluded from the mint's execution
fee. The public journal must agree with the result. Transfer recipients do not
pay the sender's fee, while the new owner pays for its own later redemption.
The 18- and 6-decimal token transfers and NFT ownership are checked independently
of the ETH cost. The oracle does not reproduce the production fee multiplication.

This establishes the receipt-to-result and journal bindings for these observed
operations. It does not verify RPC honesty, React rendering, EVM semantics,
estimated fees or cross-currency net returns.

## Realized liquidity actions

```sh
contracts/node_modules/.bin/tsx frontend/acceptance/liquidity-evidence-public.mts
```

The public wallet executes deposits, an NFT transfer and redemptions on two real
isolated DEX contracts. A mixed six/eighteen-decimal pair and equal NFT numbers
on the two exchanges exercise asset units and position identity. A real trade
changes the selected pool while an actual approval response is delayed; the
returned deposit amounts must match its successful liquidity event and wallet
balance changes, including when they differ from the original budget. Shares,
NFT ownership, transfer endpoints and redeemed amounts are checked against the
same receipts and public contract reads. The former owner cannot redeem the
transferred NFT; the new owner receives its assets. No duplicate AMM formula is
used as an oracle. Results and source fingerprints stay under
`.local/liquidity-evidence-public-*/`.

## Local chain reads and recovery

```sh
contracts/node_modules/.bin/tsx frontend/acceptance/chain-read-public.mts
```

QueryObserver and MutationObserver use the production `createChainQueryClient`
with an isolated real HTTP RPC endpoint and public wallet SDK. HTTP 503 failures
exercise initial failure, manual recovery, retention of a previous successful
snapshot and recovery to a newer block. Read phases must not send transactions.
The public onlineManager supplies the browser's offline hint while localhost
remains reachable: a real query and ERC20 faucet transaction must still finish
without waiting for an online notification. Nonces, receipts and balances check
the external effects. Results and source fingerprints stay under
`.local/chain-read-public-*/`. This verifies the production query/SDK boundary;
it does not prove React rendering or browser and wallet behavior.
