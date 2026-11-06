# Reproduce and interpret the formal checks

Rocq is the executable source of frontend business decisions; Solidity implements the on-chain behavior. Extraction, translation matching and implementation refinement establish different results.

## Build the executable models and run verification

Prepare the pinned tools using [TOOLCHAIN.md](TOOLCHAIN.md), then run from the repository root:

```bash
npm run setup
npm run formal:bootstrap
npm run build
npm run formal:verify
npm test
```

`formal:build` snapshots and dependency-orders the Rocq sources, checks them with `coqc` and `coqchk`, extracts selected definitions, then compiles the OCaml bridges to frontend JavaScript. It uses Coq 8.20.1, the pre-rename Rocq release required by the upstream Solidity semantics. Generated outputs and reports are ignored; checked-in `*Generated.v` files are pinned translation inputs that verification regenerates and compares.

`formal:verify` runs extraction, three arithmetic SMT harnesses and the swap, reserve, share-supply and arbitrage refinement gates. Each runner records sources, tools, premises, assumptions and outcome. A matching translation alone is not a refinement proof.

<details>
<summary>Run a single Solidity or refinement target</summary>

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

</details>

## Change business rules in their executable source

[Shared specifications](theories/Spec) define integer amounts, AMM quotes, liquidity shares, ownership and atomic arbitrage. [Frontend models](theories/Frontend) use them for form decisions, call parameters, wallet identity and asynchronous outcomes. OCaml bridges expose these decisions; React renders the state and viem supplies wallet, ABI and RPC effects.

The detailed contracts cover [token precision](TOKEN-PRECISION.md), [pending observation](PENDING-TRANSACTIONS.md), [active replacements](TRANSACTION-REPLACEMENTS.md) and [simulation control](SIMULATION.md). These are the entry points for changing the corresponding behavior without duplicating its rules in TypeScript.

## Interpret Solidity proof results

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
