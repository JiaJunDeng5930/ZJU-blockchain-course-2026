// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AMMMath} from "../contracts/AMMMath.sol";

/// @dev Exercises the actual inherited production implementation on arbitrary inputs.
/// The harness does not substitute a second implementation of the AMM formula.
contract SwapProperties is AMMMath {
    function quoteOutputIsBelowReserve(uint256 reserveIn, uint256 reserveOut, uint256 amountIn)
        public pure
    {
        uint256 output = calculateAmountOut(reserveIn, reserveOut, amountIn);
        assert(output < reserveOut);
        if (amountIn == 0) assert(output == 0);
        assert((reserveIn + amountIn) * (reserveOut - output) >= reserveIn * reserveOut);
    }
}
