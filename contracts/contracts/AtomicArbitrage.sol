// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MiniDEX} from "./MiniDEX.sol";
import {ArbitrageSettlement} from "./ArbitrageSettlement.sol";

/// @notice Caller-funded, two-leg atomic arbitrage. Profit is denominated in tokenIn, excluding gas.
contract AtomicArbitrage is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct ArbitrageRequest {
        address buyDex;
        uint256 buyPool;
        address sellDex;
        uint256 sellPool;
        address tokenIn;
        uint256 amountIn;
        uint256 minProfit;
        uint256 deadline;
    }

    event ArbitrageExecuted(address indexed trader, address indexed buyDex, address indexed sellDex,
        address tokenIn, uint256 amountIn, uint256 intermediateAmount, uint256 amountOut, uint256 profit);
    event PoolReservesChanged(address indexed exchange, uint256 indexed poolId,
        uint256 reserve0Before, uint256 reserve1Before, uint256 reserve0After, uint256 reserve1After);

    function execute(address buyDex, uint256 buyPool, address sellDex, uint256 sellPool,
        address tokenIn, uint256 amountIn, uint256 minProfit, uint256 deadline)
        external nonReentrant returns (uint256 profit)
    {
        // Keep the public ABI while the legacy compiler carries one internal
        // request pointer instead of eight live arguments across both swaps.
        return _execute(ArbitrageRequest(buyDex, buyPool, sellDex, sellPool,
            tokenIn, amountIn, minProfit, deadline));
    }

    function _execute(ArbitrageRequest memory request) private returns (uint256 profit) {
        require(block.timestamp <= request.deadline, "Arbitrage: expired deadline");
        require(request.buyDex != request.sellDex && request.amountIn > 0, "Arbitrage: invalid route");
        address tokenOut;
        {
            (address buy0, address buy1,,,,) = MiniDEX(request.buyDex).pools(request.buyPool);
            (address sell0, address sell1,,,,) = MiniDEX(request.sellDex).pools(request.sellPool);
            require(buy0 != address(0) && buy0 == sell0 && buy1 == sell1,
                "Arbitrage: pool pairs differ");
            require(request.tokenIn == buy0 || request.tokenIn == buy1, "Arbitrage: token not in pool");
            tokenOut = request.tokenIn == buy0 ? buy1 : buy0;
        }
        IERC20 capital = IERC20(request.tokenIn);
        uint256 balanceBefore = capital.balanceOf(address(this));
        capital.safeTransferFrom(msg.sender, address(this), request.amountIn);
        capital.forceApprove(request.buyDex, request.amountIn);
        uint256 intermediateAmount = _swapWithReserves(request.buyDex, request.buyPool,
            request.tokenIn, request.amountIn, request.deadline);
        IERC20(tokenOut).forceApprove(request.sellDex, intermediateAmount);
        _swapWithReserves(request.sellDex, request.sellPool, tokenOut, intermediateAmount, request.deadline);
        uint256 amountOut = capital.balanceOf(address(this)) - balanceBefore;
        profit = ArbitrageSettlement.checkedProfit(request.amountIn, amountOut, request.minProfit);
        capital.safeTransfer(msg.sender, amountOut);
        emit ArbitrageExecuted(msg.sender, request.buyDex, request.sellDex, request.tokenIn,
            request.amountIn, intermediateAmount, amountOut, profit);
    }

    // Block snapshots can include other transactions; these observations belong
    // to this leg and disappear together with its logs if settlement reverts.
    function _swapWithReserves(address exchange, uint256 poolId, address tokenIn,
        uint256 amountIn, uint256 deadline) private returns (uint256 amountOut)
    {
        (,, uint256 reserve0Before, uint256 reserve1Before,,) = MiniDEX(exchange).pools(poolId);
        amountOut = MiniDEX(exchange).swap(poolId, tokenIn, amountIn, 1, address(this), deadline);
        (,, uint256 reserve0After, uint256 reserve1After,,) = MiniDEX(exchange).pools(poolId);
        emit PoolReservesChanged(exchange, poolId, reserve0Before, reserve1Before, reserve0After, reserve1After);
    }
}
