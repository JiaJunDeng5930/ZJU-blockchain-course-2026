// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Unrestricted test faucet. Tokens have no economic backing.
contract TestToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /// @dev Public visibility lets the verification harness call this exact mint path.
    function faucet() public {
        _mint(msg.sender, 10_000 ether);
    }
}
