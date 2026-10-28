// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {TestToken} from "../contracts/TestToken.sol";

/// Local postconditions call the inherited production faucet without replacing
/// its ERC20 storage. The caller-balance theorem assumes the holder bound;
/// proving that bound in every reachable ERC20 state is a separate obligation.
contract AssetsProperties is TestToken {
    constructor() TestToken("Verification token", "VERIFY") {}

    function proveSupplyDelta() external {
        require(msg.sender != address(0));
        uint256 beforeSupply = totalSupply();
        faucet();
        uint256 afterSupply = totalSupply();
        assert(afterSupply >= beforeSupply && afterSupply - beforeSupply == 10_000 ether);
    }

    function proveCallerBalance() external {
        require(msg.sender != address(0));
        uint256 beforeBalance = balanceOf(msg.sender);
        require(beforeBalance <= totalSupply());
        faucet();
        uint256 afterBalance = balanceOf(msg.sender);
        assert(afterBalance >= beforeBalance && afterBalance - beforeBalance == 10_000 ether);
        assert(afterBalance <= totalSupply());
    }

    function proveOtherBalance(address other) external {
        require(other != msg.sender);
        uint256 beforeBalance = balanceOf(other);
        faucet();
        assert(balanceOf(other) == beforeBalance);
    }
}
