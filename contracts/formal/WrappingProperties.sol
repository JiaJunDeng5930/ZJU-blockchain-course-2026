// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {WrappedEther} from "../contracts/WrappedEther.sol";

/// These checks execute the production deposit and the same inherited _burn
/// invoked by withdraw. Preconditions describe the ERC20/backing interface;
/// they do not establish those invariants for every reachable contract state.
contract WrappingProperties is WrappedEther {
    function proveDeposit() external payable {
        uint256 value = msg.value;
        address account = msg.sender;
        require(account != address(0));
        uint256 balanceBefore = balanceOf(account);
        uint256 supplyBefore = totalSupply();
        require(balanceBefore <= supplyBefore);
        require(address(this).balance >= value);
        require(supplyBefore <= address(this).balance - value);
        deposit();
        assert(balanceOf(account) == balanceBefore + value);
        assert(totalSupply() == supplyBefore + value);
        assert(balanceOf(account) <= totalSupply());
        assert(address(this).balance >= totalSupply());
    }

    function proveWithdrawalBurn(uint256 amount) external {
        address account = msg.sender;
        require(account != address(0));
        uint256 balanceBefore = balanceOf(account);
        uint256 supplyBefore = totalSupply();
        require(amount <= balanceBefore && balanceBefore <= supplyBefore);
        _burn(account, amount);
        assert(balanceOf(account) == balanceBefore - amount);
        assert(totalSupply() == supplyBefore - amount);
        assert(balanceOf(account) <= balanceBefore);
        assert(balanceOf(account) <= totalSupply());
    }
}
