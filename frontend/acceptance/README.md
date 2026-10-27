# Frontend public acceptance

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
