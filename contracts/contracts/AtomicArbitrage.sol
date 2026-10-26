// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MiniDEX} from "./MiniDEX.sol";

/// @notice Caller-funded, two-leg atomic arbitrage. Profit is denominated in tokenIn, excluding gas.
contract AtomicArbitrage is ReentrancyGuard {
    using SafeERC20 for IERC20;

    event ArbitrageExecuted(address indexed trader, address indexed buyDex, address indexed sellDex,
        address tokenIn, uint256 amountIn, uint256 intermediateAmount, uint256 amountOut, uint256 profit);

    function execute(address buyDex, uint256 buyPool, address sellDex, uint256 sellPool,
        address tokenIn, uint256 amountIn, uint256 minProfit, uint256 deadline)
        external nonReentrant returns (uint256 profit)
    {
        require(block.timestamp <= deadline, "Arbitrage: expired deadline");
        require(buyDex != sellDex && amountIn > 0, "Arbitrage: invalid route");
        (address buy0, address buy1,,,,) = MiniDEX(buyDex).pools(buyPool);
        (address sell0, address sell1,,,,) = MiniDEX(sellDex).pools(sellPool);
        require(buy0 != address(0) && buy0 == sell0 && buy1 == sell1,
            "Arbitrage: pool pairs differ");
        require(tokenIn == buy0 || tokenIn == buy1, "Arbitrage: token not in pool");
        address tokenOut = tokenIn == buy0 ? buy1 : buy0;
        IERC20 capital = IERC20(tokenIn);
        uint256 balanceBefore = capital.balanceOf(address(this));
        capital.safeTransferFrom(msg.sender, address(this), amountIn);
        capital.forceApprove(buyDex, amountIn);
        uint256 intermediateAmount = MiniDEX(buyDex).swap(buyPool, tokenIn, amountIn, 1, address(this), deadline);
        IERC20(tokenOut).forceApprove(sellDex, intermediateAmount);
        MiniDEX(sellDex).swap(sellPool, tokenOut, intermediateAmount, 1, address(this), deadline);
        uint256 amountOut = capital.balanceOf(address(this)) - balanceBefore;
        require(amountOut > amountIn && amountOut - amountIn >= minProfit, "Arbitrage: insufficient profit");
        profit = amountOut - amountIn;
        capital.safeTransfer(msg.sender, amountOut);
        emit ArbitrageExecuted(msg.sender, buyDex, sellDex, tokenIn, amountIn, intermediateAmount, amountOut, profit);
    }
}
