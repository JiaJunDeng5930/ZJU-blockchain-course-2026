// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ExternalFundingToken is ERC20 {
    constructor() ERC20("External funding token", "FUND") {}

    function faucet() external {
        _mint(msg.sender, 7 ether);
    }
}
