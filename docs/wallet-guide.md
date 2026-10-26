# Wallet and first-trade guide

The application offers two explicit ways to sign transactions:

- **Local demo account** uses an unlocked, pre-funded account on the development node. Select one of the twenty addresses in **Test account**. No extension or private-key import is needed.
- **Browser wallet** uses an EIP-1193 wallet such as MetaMask. Click **Connect browser wallet** and approve access. The selected address appears under **Connected account**.

## Connect a new wallet

If the wallet is on another chain, click **Add / switch local network**. The application requests the network from the deployment file: chain 31337, local RPC `http://127.0.0.1:8545`, currency ETH. An unknown network is added before switching. Rejecting this request leaves a retry button; selecting a local test account also remains available.

Never import a development account's publicly known private key into a wallet containing real funds. A newly created empty wallet can instead receive local test assets directly from the page.

## Prepare assets

Open **Get ready for your first trade** and click **Prepare test assets**. It transfers 10 local ETH from the development node when the wallet has less than 0.01 ETH, then requests missing TKA and TKB faucet tokens. The browser wallet confirms each token claim. Existing balances are preserved, and unnecessary claims are skipped.

ETH pays gas; TKA and TKB are the traded assets. The guide updates after transaction receipts and becomes **Ready to trade** when both test tokens and gas are available. Individual faucet controls remain available in the balance cards.

## Complete the first trade

1. Open **Swap** and choose a pool and input token.
2. Enter an amount and review the quoted output, minimum received, price impact and slippage tolerance.
3. Click **Approve & swap**. When allowance is insufficient, approve the requested spending amount first. Confirm the swap next.
4. Read the confirmation and inspect **Transactions** for the independent approval and swap receipts.

Rejecting a later swap does not undo an already confirmed approval. Retrying can reuse that approval. Changing wallet account or network during an operation stops subsequent signing with the previous identity.

## Verification scope

The first-use browser acceptance starts from a newly generated, zero-asset local address, exercises rejected network switching followed by network addition, receives gas and tokens, then submits a real swap. An EIP-1193 adapter forwards transactions to the actual local chain. This validates the application's provider integration; it does not assert that a particular browser extension's confirmation UI has been tested.
