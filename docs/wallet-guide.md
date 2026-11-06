# Wallet and first-trade guide

Open the wallet button in the top-right corner. The application offers two signing paths:

- **Demo wallet** uses an unlocked, pre-funded account on the local development node. Choose one of its twenty test accounts; no extension or private-key import is required.
- **Browser wallet** uses an EIP-1193 wallet such as MetaMask. Click **Connect browser wallet** and approve the site's connection request.

## Connect and prepare assets

If the browser wallet is on another chain, use **Add / switch local network**. Review chain ID `31337`, RPC `http://127.0.0.1:8545` and currency ETH before confirming. Rejecting the request leaves a retry action.

Use **Prepare test assets** in the wallet panel to receive local ETH for gas and claim missing TKA/TKB. The local node sends ETH; the selected wallet calls the ERC20 faucets. Each transaction has its own confirmation. Individual faucet controls can also claim a token created through **Pools & tokens**.

The development accounts' private keys are publicly known test keys. Use a separate test wallet for browser-wallet demonstrations.

## Complete the first trade

1. Open **Swap** and select the intended **Active pool**.
2. Choose the input direction and enter an amount. Review the output, minimum received and slippage setting.
3. Click **Review swap**, then **Confirm swap**. If needed, approve the requested token spending first, and then confirm the swap.
4. Read the actual confirmed result and transaction hash. **Transactions** shows the current page's independent approval and business-transaction states.

Rejecting a later swap does not undo an already confirmed approval. A new review can reuse that approval. Changing account or network stops later signing under the old identity. A receipt-observation error does not mean that the transaction reverted.

## Pending transactions after refresh

Known pending transactions are saved in the same tab's `sessionStorage`. Refreshing resumes their observation without requesting signatures or automatically submitting later workflow steps. Completed activity is kept only in the current page's memory; tabs do not merge archives.

The public-entry acceptances `npm run test:asset-setup`, `npm run test:funding-confirmation` and `npm run test:pending` use real isolated chains to check the corresponding behaviors. Formal and external-interface boundaries are described in [the formal guide](../formal/README.md).
