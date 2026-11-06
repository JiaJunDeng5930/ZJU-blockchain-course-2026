# Frontend public acceptance

These runners use the application's public wallet and SDK entry points, the extracted frontend kernel and real isolated local chains. They do not reset the development chain. Assertions use confirmed receipts, events and before/after state rather than copied internal implementations.

From the repository root, run the relevant command below. Each npm command builds the current sources first. Reports and complete logs are written under `.local/`; a failing assertion or incomplete test-node cleanup exits nonzero.

| Command | External behavior |
| --- | --- |
| `npm run test:asset-setup` | Empty-wallet funding, token creation/import, selected-exchange empty-pool creation and ETH/WETH conservation |
| `npm run test:creation-results` | Confirmed creation remains distinct from metadata discovery and later pool observations |
| `npm run test:precision` | Exact amounts and prices across standard ERC20 decimal precisions, swaps, liquidity and arbitrage |
| `npm run test:pool-location` | Explicit pool identity, selection after a new snapshot, and refusal of a pool outside the deployment |
| `npm run test:deadlines` | Fresh business-call deadlines after a delayed approval |
| `npm run test:swap-settlement` | Actual single-pool execution, realized price, quote difference and separate ETH execution fee |
| `npm run test:pending` | Same-tab pending observation after refresh, checkpoint cleanup, no completed-history restoration and storage-failure feedback |
| `npm run test:replacements` | Active transaction repricing/cancellation, approval continuation and wallet-identity isolation |
| `npm run test:funding-confirmation` | Actual recipients, fee payers, partial funding and balance synchronization after confirmation |
| `npm run test:wrapping-settlement` | Consecutive wrapping/unwrapping and the A/WETH pool, NFT, redemption and unwrap path |
| `npm run test:initial-liquidity` | Explicit first-deposit price, locked minimum shares and resulting ownership |
| `npm run test:liquidity-balances` | Balance-bounded deposits, mixed precision, integer rounding, actual allowances and redemption |
| `npm run test:liquidity-evidence` | Confirmed mint, transfer and burn results checked against events, ownership and balances |
| `npm run test:liquidity-fees` | Exact ETH fees and fee payers for liquidity actions |
| `npm run test:chain-read` | RPC read failure, recovery and manual retries without fabricating chain data |
| `npm run test:simulation` | Real HTTP/worker control, task restoration, polling, safe stop and old-task isolation |
| `npm run test:simulation-failure` | Failure state and retained receipt/NFT evidence when cleanup cannot complete |
| `npm run test:arbitrage-capital` | Exact requested capital, mixed precision, insufficient funds and unprofitable routes |
| `npm run test:arbitrage-evidence` | Actual two-leg amounts, profit, fee and both pools' before/after state |
| `npm run test:wrapping-callback` | ETH recipient callbacks, rejection rollback and repeat-spend prevention |
| `npm run test:liquidity-callback` | ERC721 receiver callbacks, forwarded ownership, rejection rollback and other-position protection |

The ordinary swap always uses an explicitly selected pool. Multi-pool price-difference detection remains part of the course's automatic arbitrage behavior.

The current activity view and pending checkpoints are separate from the course-required pool-level liquidity provenance. The latter remains available, including original providers and redeemed positions. The application does not maintain long-term cross-tab transaction archives or expose a generic historical business-result reader. The scope is recorded in [ADR 024](../../docs/adr/024-course-delivery-scope.md).

For a bounded direct rerun after a successful build, invoke the named `.mts` program with `contracts/node_modules/.bin/tsx`. If this machine's native file watcher reports `EMFILE`, setting `CHOKIDAR_USEPOLLING=true` for that process uses Hardhat's supported polling watcher; it does not change the application or its test criteria.

These checks validate the stated public integrations. They do not establish browser rendering, all ERC20 behavior, full EVM semantics or unproved global storage invariants. See [formal boundaries](../../formal/README.md) and [browser acceptance](../README.md).
