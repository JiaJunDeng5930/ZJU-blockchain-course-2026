// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {TestToken} from "../contracts/TestToken.sol";

/// Local postconditions of the actual faucet function, under the ERC20 holder
/// bound. This harness does not prove that bound for every reachable state.
contract AssetsProperties is TestToken {
    constructor() TestToken("Verification token", "VERIFY") {}

    function proveFaucet() external {
        address account = msg.sender;
        uint256 balanceBefore = balanceOf(account);
        uint256 supplyBefore = totalSupply();
        uint256 credit = 10_000 ether;
        require(account != address(0));
        require(balanceBefore <= supplyBefore);
        require(supplyBefore <= type(uint256).max - credit);
        faucet();
        assert(balanceOf(account) == balanceBefore + credit);
        assert(totalSupply() == supplyBefore + credit);
        assert(balanceOf(account) <= totalSupply());
    }
}
