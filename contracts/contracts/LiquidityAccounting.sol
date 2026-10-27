// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Checked transitions used at the liquidity pool's state-write boundary.
library LiquidityAccounting {
    function mintTotal(uint256 total, uint256 minted, uint256 locked)
        internal pure returns (uint256 next)
    {
        require(minted > 0, "MiniDEX: zero shares");
        require(total == 0 || total >= locked, "MiniDEX: invalid share supply");
        return (total == 0 ? locked : total) + minted;
    }

    function burnTotal(uint256 total, uint256 burned, uint256 locked)
        internal pure returns (uint256 next)
    {
        require(total >= locked && burned > 0 && burned <= total - locked,
            "MiniDEX: locked liquidity");
        return total - burned;
    }

    function increaseReserve(uint256 reserve, uint256 added, uint256 limit)
        internal pure returns (uint256 next)
    {
        require(reserve <= limit && added <= limit - reserve, "MiniDEX: reserve limit");
        return reserve + added;
    }

    function reduceReserve(uint256 reserve, uint256 removed)
        internal pure returns (uint256 next)
    {
        require(removed < reserve, "MiniDEX: permanent liquidity");
        return reserve - removed;
    }
}
