# Token authorization management

The Token approvals page reads allowances for the connected account's known
ERC20 assets and the contracts in the current deployment: its exchanges and
atomic arbitrage contract. Native ETH is not an ERC20 authorization. WETH uses
its ordinary ERC20 allowance. Imported assets retain the existing catalog's
18-decimal standard-token contract.

The feature only revokes an existing authorization. It neither grants a new
amount nor automatically sends revocations after trades. A confirmed approval
survives rejection or failure of a later swap; revoking it does not undo an
already executed swap or transfer. These rules follow
[ERC-20](https://eips.ethereum.org/EIPS/eip-20).

## Executable model and wallet integration

`theories/Frontend/Allowances.v` defines the supported token/spender product,
read requests, observations, review, cancellation, zero-amount write plan,
false-return refusal and receipt verification. It is extracted by the existing
`WalletExtract.v` into the same JavaScript bundle as the other frontend rules.
There is no additional compilation mode or independent wallet implementation.

Each allowance controller obtains current identity and pending-operation state
from the existing wallet kernel closure. A response belongs to a monotonically
numbered request and its captured wallet identity, including the session epoch.
Changing account, chain or wallet session discards the old observation and
review. An earlier request cannot overwrite a later one. Rows with a failed read
have no numeric value; they cannot be mistaken for zero or used to revoke.

All allowance reads in one refresh use one explicit mined block. Previous values
may remain visible while loading, with their original observed block, but cannot
be submitted. The reviewed plan includes the owner, token, spender and original
exact allowance. Confirmation takes that plan once and uses `WalletController.perform`
and the existing writer and transaction journal. The existing wallet authority
check still runs immediately before broadcasting. Cancel only removes review.
A zero allowance cannot create a review or send an unnecessary approval.

The revoke write amount is always zero. A simulation returning `false` is
rejected before broadcast, as required for an ERC20 boolean return. A mined
receipt by itself does not establish that authorization was removed. The SDK
reads the allowance at that receipt's block; only zero marks the result verified.
A positive value, missing value, failed read, or an observation before that block
remains unverified. Refresh can retry observation. An observation failure after
confirmation never changes the confirmed transaction into a failed transaction.
Subsequent observations can also reveal a newly granted nonzero allowance.

The shared `Types.uint256_max` constant classifies an unlimited authorization.
The display preserves its exact integer in addition to showing Unlimited.
All other quantities retain exact decimal integer strings at the JSON boundary.
React renders model-provided availability and outcomes; it does not implement
allowance policy, request reconciliation or transaction parameter calculation.

## Proofs and boundaries

All 19 model theorems passed `Print Assumptions` with `Closed under the global context`.
The model proves that account changes discard foreign observations, successful
request acceptance belongs to the current owner, stale requests are ignored,
revocation requires a positive registered allowance, a reviewed write keeps its
captured sender, the submitted parameter is zero, a false simulation is refused,
and a verified result requires a zero observation at or after the receipt block.
Cancellation preserves observations and removes the review. The unlimited
classification is equal to the shared uint256 maximum.

These properties concern the extracted model under its external interface
contracts. Addresses use the project's existing viem canonical address codec;
RPC values and receipts must describe the indicated chain, owner, pair and block.
The deployment and catalog supply the supported contract addresses. The proofs
do not certify the JSON codec, viem, RPC honesty, ERC20 implementations, React,
OCaml/JavaScript compilation, or full EVM execution. In particular, simulated
success is not a proof that a later transaction will succeed; receipt and
allowance observations remain necessary.

## Public SDK and acceptance

`frontend/src/chain/allowances.ts` exports `AllowanceController(client, wallet,
tokens)`. Its public methods are `refresh`, `review`, `cancel`, `confirm`,
`getSnapshot`, `subscribe` and `dispose`. `getSnapshot` retains a stable reference
between changes for React's external-store contract. Wallet subscriptions are owned
by external-store subscribe/cleanup, not by construction during render. A new
subscription after cleanup reconnects to wallet events. A non-React caller can
also read the current projection without subscribing. The controller
interprets RPC and wallet effects; decisions come from the extracted model.

The independent acceptance runner uses a real isolated chain and the public SDK.
It covers finite and unlimited approvals, zero and cancellation, unsupported
pairs, actual zero approval without changing unrelated authorizations or pool
authority, false ERC20 returns, receipt observation failure and recovery, and
stale account/response isolation. It does not inspect the feature's model,
bridge, SDK implementation or React, and does not use a browser.

```sh
npm run formal:build
npm --prefix frontend run build
contracts/node_modules/.bin/tsx frontend/acceptance/allowances-public.mts
```

Execution reports are local evidence under `.local/`; generated JavaScript and
proof build products are not committed.
