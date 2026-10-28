// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MiniDEX} from "../contracts/MiniDEX.sol";

/// Assertions inspect production storage; inherited public transitions remain available.
contract MiniDEXStateProperties is MiniDEX {
    constructor() MiniDEX("Storage verification") {}

    function checkPoolState(uint256 poolId) external view {
        if (poolId > 0 && poolId <= poolCount) {
            Pool storage pool = pools[poolId];
            assert(pool.token0 < pool.token1);
            assert(pool.reserve0 <= MAX_RESERVE && pool.reserve1 <= MAX_RESERVE);
            assert(pool.totalShares == 0 || pool.totalShares >= MINIMUM_LIQUIDITY);
        }
    }

    function checkPositionState(uint256 positionId) external view {
        Position storage position = positions[positionId];
        if (position.poolId != 0) {
            Pool storage pool = pools[position.poolId];
            assert(position.poolId <= poolCount && position.shares > 0 &&
                position.shares <= pool.totalShares &&
                MINIMUM_LIQUIDITY <= pool.totalShares - position.shares &&
                _ownerOf(positionId) != address(0));
        }
    }
}
