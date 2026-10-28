// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {TestToken} from "../contracts/TestToken.sol";

/// This query has no holder-bound precondition. It is kept separate from the
/// local faucet proof so an unclosed reachable-state obligation cannot pass it.
contract AssetsReachabilityProperties is TestToken {
    constructor() TestToken("Verification token", "VERIFY") {}

    function proveReachableBacking(address holder) external view {
        assert(balanceOf(holder) <= totalSupply());
    }
}
