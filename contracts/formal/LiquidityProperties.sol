// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {LiquidityAccounting} from "../contracts/LiquidityAccounting.sol";

/// @notice Calls the production state-write functions, not a parallel arithmetic model.
contract LiquidityProperties {
    function mint(uint256 total, uint256 minted) public pure {
        uint256 base = total == 0 ? 1000 : total;
        // The successful-plan domain requires the resulting ABI value to fit uint256.
        require(minted <= type(uint256).max - base);
        uint256 next = LiquidityAccounting.mintTotal(total, minted, 1000);
        assert(next >= 1000);
        assert(next > base);
        assert(next - base == minted);
    }
    function burn(uint256 total, uint256 burned) public pure {
        uint256 next = LiquidityAccounting.burnTotal(total, burned, 1000);
        assert(next >= 1000);
        assert(next + burned == total);
        assert(next < total);
    }
    function increase(uint256 reserve, uint256 added) public pure {
        uint256 next = LiquidityAccounting.increaseReserve(reserve, added, (1 << 112) - 1);
        assert(next <= (1 << 112) - 1);
        assert(next >= reserve);
        assert(next - reserve == added);
    }
    function decrease(uint256 reserve, uint256 removed) public pure {
        uint256 next = LiquidityAccounting.reduceReserve(reserve, removed);
        assert(next > 0);
        assert(next + removed == reserve);
    }
}
