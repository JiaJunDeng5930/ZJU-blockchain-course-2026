// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library ArbitrageSettlement {
    // The production call and SMT harness share this rule rather than duplicating it.
    function checkedProfit(uint256 amountIn, uint256 amountOut, uint256 minProfit)
        internal pure returns (uint256)
    {
        require(amountOut > amountIn && amountOut - amountIn >= minProfit,
            "Arbitrage: insufficient profit");
        return amountOut - amountIn;
    }
}
