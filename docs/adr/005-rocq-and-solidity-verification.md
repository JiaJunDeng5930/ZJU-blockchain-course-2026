# 005: Make verified logic the frontend implementation

Browser-driven fixes repeatedly exposed one user-visible inconsistency after another. This method did not provide a coherent argument about identity, asynchronous completion, amounts or transaction failure. The project now follows the requested Solidity and Rocq approach.

Rocq supplies the shared transaction vocabulary and the executable frontend decisions. Extraction to OCaml followed by js_of_ocaml supplies JavaScript; TypeScript does not reproduce these decisions. React owns rendering, and viem owns transport and ABI encoding. Monetary amounts remain exact integers throughout the proof and runtime paths.

Wallet identity and request identity belong to the verified state. Replies may affect a workflow only in the session and request that issued them. A confirmed transaction and a later failure to refresh observations are separate events. Approval and swap are separate transactions, so rollback of a swap cannot undo an earlier approval.

Production Solidity helpers are checked with SMTChecker. Complex arithmetic is preferentially connected to Rocq through the existing rocq-of-solidity translator. We do not build an EVM semantics or a Solidity compiler. The translator is a compiler fork; its revision and relationship to the deployed compiler must be recorded before claiming implementation refinement.

Proof checking, extraction and Solidity verification are the primary checks. Every claim states its premises and implementation connection. Unproved correspondence remains an explicit gap rather than an axiom named after the desired conclusion. solc, extraction/compilation tools, transport/ABI encoding and external wallet/blockchain behavior remain explicit trust boundaries.

The official Solidity semantics uses large Set inductives accepted by Coq 8.20.1 but rejected by the newer installed kernels. Pinning the entire proof/extraction pipeline to 8.20.1 preserves the upstream semantics and avoids maintaining a local semantic port. The language's former Coq name does not create a second proof system.

Actual compilation evidence also changed the backend choice: full-contract via-IR compilation fails in the pinned fork, while legacy code generation succeeds after ordinary Solidity refactors that reduce stack pressure. Deployment and artifact generation therefore use the same pinned native compiler, legacy code generation, Paris EVM and optimizer runs 200. Generated helper IR has its own execution theorem; trusting compiler lowering/optimization remains explicit.

The reserve bound is a protocol decision rather than a proof-only hypothesis. Both actual reserve updates and executable frontend plans enforce the Uniswap V2 range of 2^112−1 raw units. LP supply stays uint256; retaining OpenZeppelin sqrt/mulDiv avoids replacing mature arithmetic merely to simplify a proof. Their implementation refinement remains a separate obligation.

A single immutable build snapshot prevents concurrent proof compilation from mixing incompatible .vo assumptions. One generated JavaScript bundle is installed atomically, and changes trigger full reload so controllers cannot survive into a different extracted program. Generated ABI and runtime code come from actual Solidity artifacts. This keeps the evidence tied to the program that the application loads.

Frontend WETH principal and budget proofs are useful independently of the full-source Solidity checker. The latter currently reports unsupported features and is recorded as unproved. It is not replaced with a smaller mirrored helper and described as a complete WETH proof.

A real execution exposed another interface assumption: the latest mined timestamp may lag the next executable pending block, and the host clock may differ from chain time. The adapter therefore reads pending.timestamp for call preparation; the verified core still constructs and bounds the deadline. The final contract check uses the execution block timestamp. This changes the observation source rather than duplicating deadline arithmetic in TypeScript, and keeps mining latency outside the mathematical guarantee.
