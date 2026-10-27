# 020: Recover wrapping effects from receipts

Status: accepted

## Context

An A/WETH pool uses ERC20 WETH. A user may wrap ETH before depositing and unwrap
after redeeming. Refreshing must not erase the conversion's actual principal or
confuse ETH received with the net change after its execution fee.

WrappedEther emits ERC20 mint/burn Transfer events and has no Deposit or
Withdrawal events. Its deposit, withdraw and receive paths use the direct caller
as the owner. Its inherited decimals are fixed at 18 in this protocol.

## Decision

Extend the existing extracted receipt policy and unified transaction-result
entry. Select a mint or burn only when the receipt directly targets the
configured WrappedEther and its owner agrees with the receipt sender. The
empty-calldata receive path is a supported deposit. Ordinary token transfers,
approvals, other ERC20 mints and unconfigured WETH contracts are excluded.

Live execution and historical recovery share the event decoder and confirmation
component. Both apply the existing wrapping settlement and receipt-fee functions.
The historical read needs only the receipt and deployment identity; it does not
query balances or metadata or store another result inventory.

## Boundaries

The existing settlement proofs describe the selected conversion and its actual
fee. ABI decoding, the configured Solidity implementation and RPC receipts remain
external contracts, checked by public real-chain acceptance. An arbitrary
contract callback can perform additional transfers; one direct conversion result
does not represent those combined effects. Whole-source WETH SMT attempts remain
unclosed as documented in the formal README.

Reference: [OpenZeppelin ERC20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20).
