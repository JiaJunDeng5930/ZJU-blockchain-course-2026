# Direct-pool swap routing

Swap starts with a trading pair and Best quote. For a fixed input amount, the
extracted model compares the fee-inclusive integer output of each supported
direct pool in this deployment. This is not a search over intermediate tokens,
split orders, other deployments, or gas converted into the output currency.
Manual exchange/pool selection remains available and is never silently replaced.

## Shared state and execution

`Spec/Routing.v` composes the existing `AMM.swap_draft`, quote, preview and
submission rules. It does not define another amount parser, AMM formula,
slippage calculation or wallet protocol. `ExtractTrade.v` adds the composition
to the existing Trade extraction profile and JavaScript bundle.

The pair directory is derived from registered pools with verified token metadata.
It is independent of the entered amount and of liquidity, so an empty input or
an unfunded pool does not erase a pair. Quote candidates are narrower: their
input must parse at the selected token's precision and their reserves/output
must satisfy the existing AMM domain. Wallet connection and sufficient balance
do not determine which economic quote is best. They still determine whether the
existing submission protocol can authorize a write.

Best quote compares exact output integers and retains the first pool in snapshot
order on a tie. The client enumerates configured exchanges and their pool IDs in
deterministic order. Changing the amount can change the winner: a favorable spot
price in a shallow pool need not provide the best output for a larger trade.
Manual mode keeps the chosen pool key. A removed or unsupported manual pool is
unavailable, rather than an instruction to fall back to another exchange.
Changing to a different pair resets that preference and its draft.

The submission effect contains its own pool snapshot, input, quoted output,
slippage, minimum and observed block. `ExchangeWriter.routedSwap` consumes this
captured effect through the existing writer; it does not select a route after
approval. Pending views retain the submitted pool and quote. A later snapshot
can inform a later order but cannot change the already captured effect. A worse
execution price is still constrained by the original minimum-received argument.
The existing wallet operation continues to bind approval and execution to its
captured wallet identity and to record them as separate transactions.

## Public interface

`frontend/src/logic/routing.ts` exports `createRoutedSwapController(token0)`.
Its context contains the existing Swap context plus `pools`, registered
`exchanges` and the observed `block`. The events are the existing Swap events
plus `{ kind: "route", value: "auto" | poolKey }`.

The view retains the original amount/balance/fee/slippage fields and adds
`pairs`, `pairKey`, `routes`, `route`, `mode`, `manualKey`,
`manualUnavailable` and `block`. Routes without a valid positive output have no
quoted value. The view and submission effect are encoded from the same model
state. React renders native pair/exchange selectors; it does not filter pools,
rank quotes or calculate an AMM price. The TypeScript adapter only translates
the existing address, integer and JSON representations.

## Proofs and external contracts

The pure model proves highest-quote membership and maximality, actual automatic
execution maximality, manual key preservation, supported-pair membership,
registered pool selection, effect-to-frontend consistency, quote-bound minimum,
pair-change reset, deterministic ties and pending capture preservation.
All 26 lemmas and theorems in `Routing.v` passed `Print Assumptions` with
`Closed under the global context` in the ordinary frontend theory mode.

`SwapRefinement.routed_swap_quote_matches_contract` connects a routed request to
the actual inherited production `AMMMath` helper's optimized generated-Yul
`Run.t` execution. Its input/output reserves come from the captured pool and
orientation. It reuses the existing frontend refinement and retains arbitrary
current precision contexts; it is not an 18-decimal special case.
The existing swap verification command checks all three helper, frontend and
routed refinement theorems with `coqchk` and the existing primitive/theory audit.
The audit target list also supplies its expected report count, avoiding a
separate stale numeric count when another refinement theorem is added.

These results do not prove RPC honesty, metadata honesty, address/JSON codecs,
React rendering, wallet behavior, the compilers, ABI decoding, MiniDEX storage
integration, ERC20 side effects or the full EVM. Pool identities, metadata and
reserves must describe the indicated deployment and a coherent observed block.
Wallet authorization remains the existing separately verified protocol. A quote
does not promise that the chain will remain unchanged before mining.

The independent public SDK acceptance uses real production exchange artifacts
and compares candidates with actual contract quotes on an isolated chain. It
checks amount-dependent winners, manual choice, unsupported/empty pools,
anonymous quotes, mixed precision, ties, pending capture across approval and
wallet changes. No browser is used for fault discovery.

After building the current production bundle, run:

```sh
contracts/node_modules/.bin/tsx frontend/acceptance/routing-public.mts
```

The same nine real-chain scenarios passed in the independent run and in the
implementation author's run. Local reports retain the program hash and actual
contract observations rather than committing environment-specific artifacts.
