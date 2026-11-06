# Connect a wallet and make the first trade

Open the top-right wallet button. **Demo wallet** selects one of twenty unlocked, pre-funded local accounts. For an extension such as MetaMask, choose **Connect browser wallet** and approve the connection.

## Prepare the local network and assets

Use **Add / switch local network** when the extension is on another chain. The defaults are chain ID `31337`, RPC `http://127.0.0.1:8545` and currency ETH. Use a separate test wallet: development account keys are publicly known.

Click **Prepare test assets** for gas and missing TKA/TKB. The individual **Claim** controls also fund newly created test tokens. Wait for each confirmation before spending the assets.

## Review, confirm, then read the actual result

Choose **Swap → Active pool**, the input direction and amount. **Review swap** shows the spending amount, expected output and minimum received; **Confirm swap** sends the workflow, including an ERC20 approval when required. Read **Confirmed swap** for actual settlement and expand **Transaction details** for the receipt.

An already confirmed approval remains valid if the later swap is rejected. Changing account or network stops further signing under the old identity. **Transactions** shows each approval and business transaction separately; an observation error is not a reverted receipt.

## Continue observing after a refresh

The same tab can resume observation of known pending transactions without signing or sending later steps. Completed activity belongs to the current page and is not a persistent archive. The [pending-transaction contract](../formal/PENDING-TRANSACTIONS.md) explains storage and observation limits; [public-entry acceptances](../frontend/acceptance/README.md) cover funding and recovery on real isolated chains.
