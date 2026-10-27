// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract PrecisionToken is ERC20 {
    uint8 private immutable precision;

    constructor(string memory name_, string memory symbol_, uint8 precision_)
        ERC20(name_, symbol_)
    {
        precision = precision_;
    }

    function decimals() public view override returns (uint8) {
        return precision;
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract UnreadablePrecisionToken is ERC20 {
    constructor() ERC20("No readable precision", "NOD") {}

    function decimals() public pure override returns (uint8) {
        revert("metadata unavailable");
    }
}
