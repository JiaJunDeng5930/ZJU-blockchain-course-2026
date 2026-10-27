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
