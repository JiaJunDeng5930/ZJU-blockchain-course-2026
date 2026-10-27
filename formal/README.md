# Formal development

Rocq is the executable source of frontend business decisions. Solidity remains the on-chain implementation. These two claims have different proof obligations: extracting a frontend model establishes neither Solidity refinement nor whole-EVM correctness.

## Build and reproduce

Prepare the pinned, isolated tools using [TOOLCHAIN.md](TOOLCHAIN.md). Coq 8.20.1 is the pre-rename Rocq release required by the upstream Solidity semantics. The project uses that same version for shared specifications, frontend extraction and contract refinement. It does not port the semantics to a newer kernel.

From the repository root:

```bash
npm run setup
npm run formal:bootstrap
npm run build
npm run formal:verify
npm test
```

The bootstrap also writes `.local/toolchain/env.sh` for manually invoked verification scripts. Source that file before the commands below. Bootstrap reuse is an explicit mode documented in TOOLCHAIN.md; a reused compiler is checked against its pinned sources and build patch.

```bash
. .local/toolchain/env.sh
DEX_SMT_ENGINE=bmc node contracts/scripts/verify-swap.mjs
node contracts/scripts/verify-liquidity.cjs
node contracts/scripts/verify-arbitrage.cjs
node contracts/scripts/verify-arbitrage.generate.cjs --check
node contracts/scripts/verify-arbitrage.rocq.cjs
```

The swap translation and liquidity refinement commands are separate from frontend extraction:

```bash
node contracts/scripts/verify-swap.rocq.mjs
node contracts/scripts/verify-swap.proof.mjs
node contracts/scripts/verify-liquidity.generate.cjs --check
node contracts/scripts/verify-liquidity.rocq.cjs
node contracts/scripts/verify-liquidity-supply.rocq.cjs
```

A translation command checks generation, not the semantic refinement theorem. Read the corresponding proof runner's result before attributing refinement. `verify-wrapping.cjs` and `verify-assets.cjs` record the current unclosed whole-source WETH/faucet SMT attempts. Unsupported features, unknown results or solver timeout do not certify either contract. They must not be presented as successful proof gates.

`build-formal.mjs` copies sources into a fresh build snapshot, orders dependencies, runs `coqc` and `coqchk`, extracts the selected kernels, compiles the OCaml bridges, and links one JavaScript program. Explicit Zarith JavaScript runtime files and `--disable genprim` prevent missing bigint primitives from becoming dummy stubs. Output is installed atomically as `frontend/src/generated/dex_logic.js`. Generated ABI and logic files are ignored by Git and regenerated from source. Source hashes, the compiler, and the output hash are recorded in `.local/formal/frontend-build.json`; the build log is adjacent. A generated program change requires a full page reload because an old React closure may retain an OCaml controller from the previous program.

## Specifications and executable frontend

| Source | Responsibility |
| --- | --- |
| `theories/Spec/Types.v` | Raw-unit bounds, shared calls, approval policy, deadlines and abstract atomic outcomes |
| `theories/Spec/AMM.v`, `Units.v` | Fee-adjusted integer quote, product/bounds arguments, token-specific exact amount/slippage parsing and swap parameters; see [token precision](TOKEN-PRECISION.md) |
| `theories/Spec/Routing.v` | Direct-pool comparison, manual venue selection and captured swap effects; see [swap routing](SWAP-ROUTING.md) |
| `theories/Spec/Liquidity.v`, `Frontend/LiquidityPolicy.v` | Token transfer model, shares, reserve limits, deposit/redemption/transfer decisions and position values |
| `theories/Spec/Ledger.v` | ERC721 owner replay, burn removal and current-owner projection |
| `theories/Spec/Arbitrage.v` | Finite route search, candidate profit, minimum profit and settlement |
| `theories/Frontend/Wallet.v`, `Transactions.v`, `TransactionsProofs.v` | Wallet/session identity, stale replies, signature authority, submission uncertainty and immutable confirmation history |
| `theories/Frontend/ReplacementSearch.v` | Private receipt observation for a journal entry's bound descriptor; see [transaction confirmation details](TRANSACTION-REPLACEMENTS.md) |
| `theories/Frontend/TransactionHistory.v` | Per-page archive ownership, read-only recovery and storage failure policy; see [transaction history](TRANSACTION-HISTORY.md) |
| `theories/Frontend/Activity.v` | Account and status selection, bounded pages and read-only transaction projection; see [activity navigation](ACTIVITY.md) |
| `theories/Frontend/Allowances.v` | Identity-bound allowance observations, explicit zero-approval decisions and verification after confirmation; see [allowance management](ALLOWANCES.md) |
| `theories/Spec/Assets.v`, `Frontend/AssetsForms.v` | Verified asset catalog, pool compatibility, creation/import/faucet decisions and form effects |
| `theories/Spec/Wrapping.v`, `Frontend/WrappingModel.v` | ETH/WETH principal and maximum gas budget decisions |
| `theories/Spec/Simulation.v`, `Frontend/SimulationModel.v` | Valid options, request identity, command exclusion, recovery and job-specific stop |

`runtime/*Bridge.ml` adapts JSON and JavaScript calls. `frontend/src/logic` wraps these generated exports; chain adapters interpret their effects with viem. React displays the returned state. Monetary values, shares, request identifiers and transaction parameters cross the JavaScript boundary as decimal strings and exact bigint values. Display-only chart approximations do not supply transaction parameters.

The NFT replay contract is an ordered event stream from one ERC721 contract at one fixed block. Asset activation requires observed metadata and supported decimals; persisted metadata alone grants no faucet capability. Wallet results belong to the request/session that issued them. A confirmed transaction and a later failed read are distinct events. A submitted transaction whose receipt cannot be read remains submitted; an unknown submission result is not classified as a known non-submission.

The call-time interface is `ExchangeClient.transactionTimestamp()`: it reads the RPC pending block timestamp, not the last mined block or the browser clock. The model treats this value as an external chain-time observation and constructs the 1200-second frontend deadline. The simulation worker reads the same kind of observation and uses its existing 300-second window. Pending is provisional; the contract checks expiry against the actual execution block timestamp. The arithmetic theorem does not assume that a wallet signs or a transaction mines before that deadline.

Adding liquidity and executing arbitrage retain their captured request throughout ERC20 approvals. After those approvals confirm, each adapter reads pending chain time again and invokes the same extracted planner with only `now` changed. `prepared_deposit_at_valid_time` proves that the deposit plan and approval requirements are unchanged; `prepare_supported_assets_at_valid_time` proves that the route, capital, minimum profit and approval requirement are unchanged. Both bind the new deadline to the supplied time, using the existing `valid_call_time_bounds` result. These are arithmetic and request-preservation proofs. The adapter ordering that obtains time after approval is exercised separately through [public-entry real-chain acceptance](../frontend/acceptance/README.md).

This adapter correction was exercised through the public simulation endpoint (20 rounds, 20 active accounts, completed report and rollback check) and the public writer SDK (successful swap, add and redeem). The observed transaction deadlines were respectively 300 and 1200 seconds after their actual mined timestamps. These results exercise the time adapter; RPC and mining remain external assumptions.

The arbitrage execution summary consumes `amountIn`, `amountOut` and `profit`
from `ArbitrageExecuted` in the confirmed execute receipt. Its ETH execution
cost is that receipt's `gasUsed * effectiveGasPrice`, following the
[Ethereum receipt fields](https://ethereum.org/developers/docs/apis/json-rpc/#eth_gettransactionreceipt)
and [transaction fee definition](https://glossary.ethereum.org/style-guide/gas-fee).
Prior ERC20 approval transactions are excluded. `summarize_execution` performs
this arithmetic in extracted Rocq; TypeScript only decodes event/receipt fields
and transports exact integers. The UI keeps ERC20 capital, returned amount and
profit separate from ETH cost, and labels each pool's reserve order and price
direction with its token units.

`Contracts/ArbitrageExtract.v` is a frontend extraction adapter; this summary
adds no Solidity or EVM refinement. `execution_summary_settlement` reuses
`settlement_sound` to establish returned capital equals input capital plus
positive profit meeting the minimum, **conditional on the observed amounts
satisfying the shared settlement predicate**. The other summary theorems prove
the ETH fee is nonnegative for nonnegative receipt fields, and changing gas
cannot change ERC20 quantities or profit. Authentic event/receipt fields, their
association with the submitted execute transaction, the RPC and ABI decoder
remain external assumptions. Public-entry real-chain acceptance checks that
association against token transfers, balances and native ETH expenditure; it
does not turn the frontend theorem into a proof of whole-EVM execution.

The deposit ownership projection in `Frontend/LiquidityPolicy.v` composes the
shared `mint_total` and `redeem_amounts` functions. It reports the projected total
shares, newly locked shares and the new NFT's immediately redeemable quantities
at the quoted pool state. `first_deposit_ownership_includes_locked` establishes
the initial lock; `prepared_deposit_ownership_keeps_pool_funded` and
`analyzed_deposit_ownership_keeps_pool_funded` connect successful preparation
and frontend analysis to the funded-reserve property. The extracted bridge
supplies these values to React without repeating the arithmetic in TypeScript.
This is a hypothetical mint-and-redeem projection at one state, not a promise
about future reserves or a new refinement of OpenZeppelin arithmetic. The
[initial-liquidity public acceptance](../frontend/acceptance/initial-liquidity-public.mts)
checks its binding to actual mint and redemption effects, including a
zero-decimal `1001/1001` deposit whose NFT can redeem only `1/1` immediately.

The simulation lifecycle model does not prove receipt-journal delivery or
retention. Worker IPC, receipt decoding, the service's in-memory journal and its
explicit terminal-run handoff are external adapters. Their HTTP/RPC acceptance
checks received confirmations, funding rejection before writes and real reverted
transactions; it does not establish crash recovery or coverage of submissions
whose confirmation was never reported. See [ADR 013](../docs/adr/013-preserve-simulation-receipt-evidence.md).

## Actual Solidity evidence

SMTChecker harnesses import production helper code rather than a second arithmetic implementation:

| Production implementation | Evidence | Scope |
| --- | --- | --- |
| `AMMMath.sol` | `verify-swap.mjs`; report `formal/build/swap-smt.json` | Successful bounded quote arithmetic and assertions; BMC is used for the loop-free helper, with unknown/unsupported results reported separately |
| `LiquidityAccounting.sol` | `verify-liquidity.cjs`; `.local/formal/liquidity-smt.json` | 11 proved assertions about successful reserve/share updates |
| `ArbitrageSettlement.sol` | `verify-arbitrage.cjs`; `.local/formal/arbitrage-smt.json` | Four proved settlement assertions; `settlement_smt_assertions` connects their conjunction to the shared settlement predicate |
| Generated `calculateAmountOut` | `SwapRefinement.v`; `formal/build/swap-proof.json` | `calculate_amount_out_runs`, `frontend_swap_quote_matches_contract` and `routed_swap_quote_matches_contract` connect single-pool and captured routed requests to the inherited helper’s optimized generated-Yul `Run.t` result and unchanged State |
| Generated reserve accounting | `LiquidityRefinement.v`; `.local/formal/liquidity-rocq.json` | `reduce_reserve_runs` and `increase_reserve_runs` establish successful production reserve helper execution |
| Generated supply accounting | `LiquiditySupplyRefinement.v`; `.local/formal/liquidity-supply-rocq.json` | `mint_total_refines_supply` and `burn_total_refines_supply` connect actual helper execution to shared `Liquidity.mint_total` / `burn_total` |
| Generated `checkedProfit` | `ArbitrageRefinement.v`; `.local/formal/arbitrage-rocq.json` | `checked_profit_runs` and `checked_profit_refines_settlement` use the official `Run.t` execution relation |
| `TestToken.faucet` and inherited OpenZeppelin mint | `verify-assets.cjs`; `.local/formal/assets-smt.json` | Full faucet balance/supply verification has not closed; the frontend faucet capability proof does not establish the ERC20 implementation |
| `WrappedEther.sol` and inherited OpenZeppelin code | `verify-wrapping.cjs`; `.local/formal/wrapping-smt.json` | The attempted full-source check is unproved because the upstream checker reports unsupported features |

The AMM refinement report records `status=proved` and `coqchk passed`. Its environment must use the existing SMT harness code name, with valid uint112 reserves and positive input. It proves the inherited production helper and the frontend `RequestSwapEffect` input/output relation. It does not prove ABI decoding, MiniDEX reserve-storage integration, ERC20 effects or EVM bytecode. Translation correspondence is checked independently before this proof.

The reserve refinement accepts uint256 values with `0 <= reserve <= limit`, `0 <= added <= limit - reserve`, and `limit <= uint256_max`; reduction requires `0 <= removed < reserve`. It covers successful pure reserve arithmetic, not NFT/storage composition, external token effects or optimized EVM bytecode. The separate share-supply refinement connects the mint/burn helpers to `Liquidity.mint_total` and `Liquidity.burn_total` in the successful uint256 domain, with fixed locked minimum 1000. It does not assume LP shares fit uint112. Both LP reports record `status=proved` and `kernelCheck=coqchk passed`, with source-hash checks against the final sources. Both LP refinements use the unoptimized native translation of the production library; their helper result does not certify the optimized deployed bytecode.

Both reserve sides are limited to `2^112−1` raw units, following the range used by Uniswap V2. LP shares remain uint256. The cap bounds the quote's checked machine arithmetic; it does not justify assuming a 112-bit share supply. OpenZeppelin `sqrt` and full-precision `mulDiv` are reused. Their mathematical implementation refinement and composition into a global MiniDEX invariant are outside the present helper proofs.

The native compiler is the pinned upstream rocq-of-solidity fork. Two recorded C++ build repairs enable compilation; no Solidity/Yul/Rocq semantics is replaced. The deployed contracts use this compiler's legacy code generation, Paris EVM and optimizer runs 200. The fork's full-contract via-IR path currently fails, so it is not silently substituted for the successful legacy build. See the [compiler build patch](../contracts/scripts/verify-swap.compiler.patch) and TOOLCHAIN.md.

## Trust and composition

Ordinary frontend models use predicative Set. The upstream Solidity semantics requires `-impredicative-set`. The checked swap, reserve, supply and arbitrage refinements report ten registered kernel Primitive operations, not an invented target axiom. Upstream unfinished helper theorems and the `M.run` marker are not used to discharge its `Run.t` goal. Each proof runner records its actual assumptions; the logic mode and primitives remain part of the assurance statement.

The trusted boundary includes solc and its optimization/code generation, Rocq extraction, OCaml/js_of_ocaml and Zarith runtime, JSON/ABI adapters, React rendering, RPC and wallet behavior. External ERC20 contracts must implement the stated standard transfer behavior without rebasing or transfer tax. External calls may fail, and the execution environment must provide Ethereum transaction atomicity. The helper refinements do not prove those interfaces.

`atomic_call_failed_preserves_state` proves the behavior of the shared rollback definition. It does not establish EVM rollback for the Solidity transaction. The public contract-entry acceptance scenarios exercise actual rollback separately. Nor do the SMT checks prove the entire ERC721 storage implementation, recipient callbacks, gas accounting, or all possible interleavings of the whole deployed application.

Only a proved connection supports a cross-layer claim. A successful abstract theorem, generated file, translation or build is reported at its own level. Browser scenarios and historical screenshots are not used to establish these properties. The simulation HTTP/worker boundary is further described in [SIMULATION.md](SIMULATION.md).
