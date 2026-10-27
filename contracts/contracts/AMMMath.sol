// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Exact-input constant-product arithmetic for the supported uint112 pools.
/// @dev A base contract keeps the production function independently translatable
/// without introducing a separately deployed or linked Solidity library.
contract AMMMath {
    uint256 public constant MAX_RESERVE = (1 << 112) - 1;
    uint256 public constant FEE_BPS = 30;

    function calculateAmountOut(uint256 reserveIn, uint256 reserveOut, uint256 amountIn)
        public pure returns (uint256 amountOut)
    {
        require(reserveIn > 0 && reserveOut > 0, "MiniDEX: empty pool");
        require(reserveIn <= MAX_RESERVE && reserveOut <= MAX_RESERVE,
            "MiniDEX: reserve limit");
        require(amountIn <= MAX_RESERVE - reserveIn, "MiniDEX: reserve limit");
        uint256 weightedInput = amountIn * (10_000 - FEE_BPS);
        amountOut = weightedInput * reserveOut / (reserveIn * 10_000 + weightedInput);
    }
}
