# Transaction history acceptance

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
