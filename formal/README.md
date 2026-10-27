# Formal development

Rocq is the executable source of frontend business decisions. Solidity remains the on-chain implementation. These two claims have different proof obligations: extracting a frontend model establishes neither Solidity refinement nor whole-EVM correctness.

## Build and reproduce

Prepare the pinned, isolated tools using [TOOLCHAIN.md](TOOLCHAIN.md). Coq 8.20.1 is the pre-rename Rocq release required by the upstream Solidity semantics. The project uses that same version for shared specifications, frontend extraction and contract refinement. It does not port the semantics to a newer kernel.

From the repository root:

```bash
node scripts/bootstrap-formal.mjs
npm run setup
npm --prefix contracts run compile
node scripts/generate-frontend-abi.mjs
node scripts/build-formal.mjs
npm --prefix frontend run build
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
node contracts/scripts/verify-liquidity.generate.cjs --check
node contracts/scripts/verify-liquidity.rocq.cjs
node contracts/scripts/verify-liquidity-supply.rocq.cjs
```

A translation command checks generation, not the semantic refinement theorem. Read the corresponding proof runner's result before attributing refinement. `verify-wrapping.cjs` records the current unsupported whole-source SMT attempt; it is not a successful WETH verification gate.

`build-formal.mjs` copies sources into a fresh build snapshot, orders dependencies, runs `coqc` and `coqchk`, extracts the selected kernels, compiles the OCaml bridges, and links one JavaScript program. Explicit Zarith JavaScript runtime files and `--disable genprim` prevent missing bigint primitives from becoming dummy stubs. Output is installed atomically as `frontend/src/generated/dex_logic.js`. Generated ABI and logic files are ignored by Git and regenerated from source. Source hashes, the compiler, and the output hash are recorded in `.local/formal/frontend-build.json`; the build log is adjacent. A generated program change requires a full page reload because an old React closure may retain an OCaml controller from the previous program.

## Specifications and executable frontend

| Source | Responsibility |
| --- | --- |
| `theories/Spec/Types.v` | Raw-unit bounds, shared calls, approval policy, deadlines and abstract atomic outcomes |
| `theories/Spec/AMM.v`, `Units.v` | Fee-adjusted integer quote, product/bounds arguments, exact amount/slippage parsing and swap parameters |
| `theories/Spec/Liquidity.v`, `Frontend/LiquidityPolicy.v` | Token transfer model, shares, reserve limits, deposit/redemption/transfer decisions and position values |
| `theories/Spec/Ledger.v` | ERC721 owner replay, burn removal and current-owner projection |
| `theories/Spec/Arbitrage.v` | Finite route search, candidate profit, minimum profit and settlement |
| `theories/Frontend/Wallet.v`, `Transactions.v`, `TransactionsProofs.v` | Wallet/session identity, stale replies, signature authority, submission uncertainty and immutable confirmation history |
| `theories/Spec/Assets.v`, `Frontend/AssetsForms.v` | Verified asset catalog, pool compatibility, creation/import/faucet decisions and form effects |
| `theories/Spec/Wrapping.v`, `Frontend/WrappingModel.v` | ETH/WETH principal and maximum gas budget decisions |
| `theories/Spec/Simulation.v`, `Frontend/SimulationModel.v` | Valid options, request identity, command exclusion, recovery and job-specific stop |

`runtime/*Bridge.ml` adapts JSON and JavaScript calls. `frontend/src/logic` wraps these generated exports; chain adapters interpret their effects with viem. React displays the returned state. Monetary values, shares, request identifiers and transaction parameters cross the JavaScript boundary as decimal strings and exact bigint values. Display-only chart approximations do not supply transaction parameters.

The NFT replay contract is an ordered event stream from one ERC721 contract at one fixed block. Asset activation requires observed metadata and supported decimals; persisted metadata alone grants no faucet capability. Wallet results belong to the request/session that issued them. A confirmed transaction and a later failed read are distinct events. A submitted transaction whose receipt cannot be read remains submitted; an unknown submission result is not classified as a known non-submission.

## Actual Solidity evidence

SMTChecker harnesses import production helper code rather than a second arithmetic implementation:

| Production implementation | Evidence | Scope |
| --- | --- | --- |
| `AMMMath.sol` | `verify-swap.mjs`; report `formal/build/swap-smt.json` | Successful bounded quote arithmetic and assertions; BMC is used for the loop-free helper, with unknown/unsupported results reported separately |
| `LiquidityAccounting.sol` | `verify-liquidity.cjs`; `.local/formal/liquidity-smt.json` | 11 proved assertions about successful reserve/share updates |
| `ArbitrageSettlement.sol` | `verify-arbitrage.cjs`; `.local/formal/arbitrage-smt.json` | Four proved settlement assertions; `settlement_smt_assertions` connects their conjunction to the shared settlement predicate |
| Generated `checkedProfit` | `ArbitrageRefinement.v`; `.local/formal/arbitrage-rocq.json` | `checked_profit_runs` and `checked_profit_refines_settlement` use the official `Run.t` execution relation |
| `WrappedEther.sol` and inherited OpenZeppelin code | `verify-wrapping.cjs`; `.local/formal/wrapping-smt.json` | The attempted full-source check is unproved because the upstream checker reports unsupported features |

Liquidity reserve and supply refinement sources are separate proof obligations. A completed proof source is not listed as a completed checker run until its runner produces a successful report. AMM source translation is likewise separate from a checked `Run.t` refinement.

Both reserve sides are limited to `2^112−1` raw units, following the range used by Uniswap V2. LP shares remain uint256. The cap bounds the quote's checked machine arithmetic; it does not justify assuming a 112-bit share supply. OpenZeppelin `sqrt` and full-precision `mulDiv` are reused. Their mathematical implementation refinement and composition into a global MiniDEX invariant are outside the present helper proofs.

The native compiler is the pinned upstream rocq-of-solidity fork. Two recorded C++ build repairs enable compilation; no Solidity/Yul/Rocq semantics is replaced. The deployed contracts use this compiler's legacy code generation, Paris EVM and optimizer runs 200. The fork's full-contract via-IR path currently fails, so it is not silently substituted for the successful legacy build. See the [compiler build patch](../contracts/scripts/verify-swap.compiler.patch) and TOOLCHAIN.md.

## Trust and composition

Ordinary frontend models use predicative Set. The upstream Solidity semantics requires `-impredicative-set`. The checked arbitrage refinement reports ten registered kernel Primitive operations, not an invented target axiom. Upstream unfinished helper theorems and the `M.run` marker are not used to discharge its `Run.t` goal. Each proof runner records its actual assumptions; the logic mode and primitives remain part of the assurance statement.

The trusted boundary includes solc and its optimization/code generation, Rocq extraction, OCaml/js_of_ocaml and Zarith runtime, JSON/ABI adapters, React rendering, RPC and wallet behavior. External ERC20 contracts must implement the stated standard transfer behavior without rebasing or transfer tax. External calls may fail, and the execution environment must provide Ethereum transaction atomicity. The helper refinements do not prove those interfaces.

`atomic_call_failed_preserves_state` proves the behavior of the shared rollback definition. It does not establish EVM rollback for the Solidity transaction. The public contract-entry acceptance scenarios exercise actual rollback separately. Nor do the SMT checks prove the entire ERC721 storage implementation, recipient callbacks, gas accounting, or all possible interleavings of the whole deployed application.

Only a proved connection supports a cross-layer claim. A successful abstract theorem, generated file, translation or build is reported at its own level. Browser scenarios and historical screenshots are not used to establish these properties. The simulation HTTP/worker boundary is further described in [SIMULATION.md](SIMULATION.md).
