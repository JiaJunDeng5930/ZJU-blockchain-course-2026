// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ERC-20 permits approve to return false. This fixture preserves an existing
// allowance so the public client must distinguish refusal from revocation.
contract RefusingApproval is ERC20 {
    constructor() ERC20("Refusing Approval", "REFUSE") {
        _mint(msg.sender, 1_000 ether);
    }

    function seed(address owner, address spender, uint256 amount) external {
        _approve(owner, spender, amount);
    }

    function approve(address, uint256) public pure override returns (bool) {
        return false;
    }
}
