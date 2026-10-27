// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ArbitrageSettlement} from "../contracts/ArbitrageSettlement.sol";

contract ArbitrageProperties {
    function settlement(uint256 capital, uint256 returned, uint256 minimum)
        external pure returns (uint256 gain)
    {
        gain = ArbitrageSettlement.checkedProfit(capital, returned, minimum);
        assert(gain > 0);
        assert(gain >= minimum);
        assert(returned == capital + gain);
        assert(gain == returned - capital);
    }
}
