# Formal development

Rocq is the executable source of frontend business decisions. Solidity remains the on-chain implementation. Frontend extraction, Solidity verification and implementation refinement are separate checks.

## Build and reproduce

Prepare the pinned tools using [TOOLCHAIN.md](TOOLCHAIN.md). The pipeline uses Coq 8.20.1, the pre-rename Rocq release required by the upstream Solidity semantics, for shared specifications, extraction and contract refinement.

From the repository root:

```bash
npm run setup
npm run formal:bootstrap
npm run build
npm run formal:verify
npm test
```

`formal:build` snapshots the sources, orders dependencies, checks them with `coqc` and `coqchk`, extracts the selected definitions, compiles the OCaml bridges and produces the frontend JavaScript. Generated JavaScript, proof build products, logs and reports are ignored. The checked-in `*Generated.v` files are pinned Solidity-to-Rocq translation inputs to handwritten refinement proofs; verification regenerates and compares them.

`formal:verify` runs frontend extraction, the three arithmetic SMT harnesses and the swap, reserve, share-supply and arbitrage refinement runners. Individual commands can be run after sourcing the bootstrap environment:

```bash
. .local/toolchain/env.sh
DEX_SMT_ENGINE=bmc node contracts/scripts/verify-swap.mjs
node contracts/scripts/verify-liquidity.cjs
node contracts/scripts/verify-arbitrage.cjs
node contracts/scripts/verify-swap.rocq.mjs
node contracts/scripts/verify-swap.proof.mjs
node contracts/scripts/verify-liquidity.generate.cjs --check
node contracts/scripts/verify-liquidity.rocq.cjs
node contracts/scripts/verify-liquidity-supply.rocq.cjs
node contracts/scripts/verify-arbitrage.generate.cjs --check
node contracts/scripts/verify-arbitrage.rocq.cjs
```

A matching translation is not itself a refinement proof. Each proof runner records its premises, checked sources, tool versions, assumptions and outcome. Read the generated report before attributing a proof result.

## Executable frontend

Shared specifications describe exact integer amounts, AMM quotes, liquidity shares and atomic arbitrage. Frontend models use those definitions for form decisions, call parameters, wallet identity, asynchronous requests and transaction outcomes. OCaml bridges expose the extracted decisions to JavaScript. React renders the resulting state; viem handles ABI, wallet and RPC effects.

| Retained behavior | Source area or explanation |
| --- | --- |
| Amount parsing, formatting and ERC20 precision | `theories/Spec/Units.v`; [token precision](TOKEN-PRECISION.md) |
| Explicit-pool swap quote and parameters | `theories/Spec/AMM.v`; `theories/Frontend/ExtractTrade.v` |
| Liquidity supply, reserve updates, NFT ownership and balances | `theories/Spec/Liquidity.v`, `Ledger.v`; frontend liquidity models |
| Atomic arbitrage and realized settlement | `theories/Spec/Arbitrage.v`; frontend capital and receipt models |
| Wallet identity, active transactions and pending observation after refresh | Frontend wallet/transaction models; [pending transactions](PENDING-TRANSACTIONS.md) |
| Active transaction repricing and cancellation | [replacement observation](TRANSACTION-REPLACEMENTS.md) |
| Funding, token creation, wrapping and real confirmed results | Frontend funding, asset, wrapping and receipt models |
| Twenty-account simulation control | [simulation](SIMULATION.md) |

The activity view shows transactions known to the current page. Only known pending transactions are checkpointed in the same tab's `sessionStorage`. Restoring them resumes observation, not signing or later workflow steps. Completed transactions are not archived across refreshes; there is no cross-tab history merge, old-archive compatibility, generic historical business-result reader, standalone allowance-management page or cross-pool Best quote mode. The scope decision is recorded in [ADR 024](../docs/adr/024-course-delivery-scope.md).

## Solidity proof boundary

The SMT harnesses import production code. The Rocq refinement proofs use the upstream generated Solidity semantics and its `Run.t` execution relation.

| Production path | Recorded scope |
| --- | --- |
| `AMMMath.calculateAmountOut` | Bounded successful quote arithmetic; `frontend_swap_quote_matches_contract` connects the frontend request to the generated helper result |
| `LiquidityAccounting` reserve helpers | Successful increase/reduction under the stated reserve and uint256 bounds |
| `LiquidityAccounting` supply helpers | Mint/burn helper execution connected to shared share-supply definitions |
| `ArbitrageSettlement.checkedProfit` | Successful settlement and minimum-profit assertions |
| `TestToken.faucet` and inherited mint | Four conditional local storage postconditions; [exact premises](TEST-TOKEN-STATE.md) |
| `WrappedEther.deposit` and inherited burn | Eight conditional storage postconditions; [premises and boundary](WRAPPED-ETHER-STATE.md) |
| Full inherited MiniDEX storage | Global CHC targets remain unproved; [scope and command](MINIDEX-STATE.md) |

The separate global ERC20 backing target also remains unproved. Local helper and storage results do not prove MiniDEX's complete storage composition, ABI encoding, external token behavior or optimized EVM bytecode. The WETH burn proof excludes the outgoing ETH transfer, callback, rollback and `receive` dispatch. Public contract acceptances separately exercise [WETH callbacks](WRAPPED-ETHER-STATE.md) and [liquidity NFT callbacks](LIQUIDITY-CALLBACKS.md).

## Integration evidence

Public-entry acceptances exercise the extracted JavaScript and real isolated chains. They check integration facts such as actual receipts, balances, event decoding, wallet/RPC failures and atomic rollback. They complement the proofs rather than replacing their premises or extending their scope. The available commands and observed behaviors are listed in [the acceptance guide](../frontend/acceptance/README.md).

The trusted boundary includes solc and the translator, Rocq extraction, OCaml/js_of_ocaml compilation, codecs, viem, the browser wallet and RPC observations. Only the properties with an explicit proof connection are claimed as refinement results.
