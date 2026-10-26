# ADR 001: AMM liquidity positions and local demonstration

Status: accepted

The starter has no implemented domain behavior. Use two independent MiniDEX deployments with identical token pairs. Each MiniDEX owns multiple pools and is also the ERC721 position issuer. This keeps each position's redemption authority and pool accounting in one contract. OpenZeppelin supplies ERC20, ERC721, SafeERC20, Math and ReentrancyGuard.

Pool prices follow constant product with a fixed 30 basis point swap fee retained in reserves. Position NFTs hold immutable minted liquidity shares; redemption burns the entire position and returns its share of current reserves, including accrued fees. Additional deposits use the current reserve ratio and transfer only the required amounts. Permanently locked initial shares prevent resetting a pool and first-depositor rounding attacks. Native ETH is represented by a WETH contract with explicit wrap/unwrap in the UI.

Support standard non-rebasing ERC20 tokens without transfer taxes. Anyone may create a pool. Pool tokens are sorted by address and duplicate pairs rejected within an exchange. Every operation uses a deadline and minimum received amounts. The NFT owner or approved operator can redeem; proceeds always go to the current owner. NFT metadata is self-contained JSON. Fee income changes reserves; there is no second reward ledger.

AtomicArbitrage pulls caller-funded capital, executes token A -> token B -> token A on two exchanges, checks an explicit minimum net token profit, and refunds capital plus profit within one transaction. Any failure reverts all effects. This is prefunded arbitrage, not a flash loan. Quoted profit excludes gas and the UI identifies that limitation.

The default development chain is Hardhat, chain ID 31337, with 20 pre-funded accounts. The UI supports explicit local RPC account selection and injected wallets. Local unlocked accounts are only a teaching mode. Deployment exports ABI/address data to shared/deployment.json; the UI and simulator consume that file. Generated live deployment data and simulation runs are ignored; screenshots and reproducible commands are committed.

Validation uses public contract transactions and real browser interactions against the local chain. Financial invariants, ownership transfer/redemption, deadline/slippage failure and unprofitable-arbitrage rollback are verified through public APIs and balances. No implementation-specific permanent unit tests are needed.
