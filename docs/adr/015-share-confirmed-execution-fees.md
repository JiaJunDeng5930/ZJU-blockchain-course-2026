# ADR 015: Share confirmed execution fees across transaction results

Liquidity token amounts and retained pool fees do not describe the ETH paid to
execute a transaction. The payer is the receipt's sender, which can differ from
the recipient of an NFT or redeemed assets. A deposit can also require separate
approval transactions before its execution receipt exists.

Use one extracted Rocq definition for the execution fee carried by confirmed
liquidity results, the transaction journal and arbitrage summaries. Reusing this
definition makes agreement between those views a property of their construction;
calculating another fee in React or a transport bridge would duplicate policy.
A small pure dependency keeps this change out of unrelated AMM and Solidity
refinement inputs.

The inputs are the actual receipt's `gasUsed` and `effectiveGasPrice`, and the
output remains an exact wei integer. Receipt fields are supplied by the existing
RPC adapter under its valid Ethereum receipt contract. They are not estimates or
the transaction's maximum fee settings, and missing observations are not free
execution. Mathematical nonnegativity has the explicit premise that both receipt
fields are nonnegative.

Display this cost separately in ETH and identify the sender as payer. It covers
only that receipt, so earlier ERC20 approval costs are excluded. ERC20 amounts,
liquidity shares and realized token profit retain their own units. The result
does not convert between currencies or claim a combined net return.

Public-chain acceptance compares the reported cost with the sender's actual ETH
decrease during each value-free execution, isolating approvals in earlier blocks.
The arithmetic proof and this adapter check have different responsibilities;
neither claims to verify RPC honesty or EVM semantics.
