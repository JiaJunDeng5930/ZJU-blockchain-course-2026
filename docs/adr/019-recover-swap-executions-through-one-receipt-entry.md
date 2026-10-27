# 019: Recover swap executions through one receipt entry

Status: accepted

## Context

The reviewed swap quote exists in the current page. A mined receipt preserves
actual input and output amounts, trader and recipient, but it does not preserve
that earlier quote. Current reserves can also differ after another transaction,
including another transaction in the same block. Restoring the previous page's
comparison from current prices would invent historical information.

Transactions already offered separate creation, liquidity and arbitrage receipt
queries. Adding a fourth query would repeat the same manual read, error and retry
lifecycle and expose several buttons when transaction metadata was unavailable.

## Decision

Represent `SwapExecution` independently of the quote. Live `SwapResult` adds the
reviewed quote and minimum, while historical recovery returns only execution.
Both render the same actual amounts and use the same extracted execution-price
function; only a live result supplies the comparison section.

Use one transaction-result query. An extracted classifier selects contract
creation, configured arbitrage, configured liquidity or a configured direct
single-pool swap from receipt facts. Arbitrage retains its operation kind even
though its receipt contains two inner Swap events. Existing domain readers share
the already fetched receipt and keep their public behavior. There is no handler
registry or additional persistent result inventory.

Pool identity and asset metadata use the receipt block. Swap quantities come
from the actual event; execution price uses those quantities rather than pool
reserves. Trader, recipient and ETH payer remain distinct fields. RPC errors
remain query errors and cannot change a previously confirmed journal entry.

## Boundaries

The DApp executes one direct pool swap, including when Best selects the venue.
Multiple swaps in one direct exchange receipt are not represented as one trade.
ABI decoding, complete receipt logs and historical RPC responses remain trusted
interfaces. Rocq proves selection and dispatch properties, not EVM behavior.

References: [Uniswap V2 pair interface](https://github.com/Uniswap/v2-core/blob/master/contracts/interfaces/IUniswapV2Pair.sol),
[viem event parsing](https://viem.sh/docs/contract/parseEventLogs), and
[viem receipt reads](https://viem.sh/docs/actions/public/getTransactionReceipt).
