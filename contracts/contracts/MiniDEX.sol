// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {AMMMath} from "./AMMMath.sol";
import {LiquidityAccounting} from "./LiquidityAccounting.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @notice Constant-product pools with ERC721 liquidity shares and 0.3% retained fees.
contract MiniDEX is ERC721, ReentrancyGuard, AMMMath {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    uint256 public poolCount;
    uint256 public nextPositionId = 1;

    struct Pool {
        address token0;
        address token1;
        uint256 reserve0;
        uint256 reserve1;
        uint256 totalShares;
        uint256 createdAt;
    }

    struct Position {
        uint256 poolId;
        uint256 shares;
        uint256 amount0;
        uint256 amount1;
        uint256 createdAt;
    }

    mapping(uint256 => Pool) public pools;
    mapping(uint256 => Position) public positions;
    mapping(address => mapping(address => uint256)) private poolIds;

    event PoolCreated(uint256 indexed poolId, address indexed token0, address indexed token1);
    event LiquidityAdded(uint256 indexed poolId, uint256 indexed positionId, address indexed provider,
        uint256 amount0, uint256 amount1, uint256 shares);
    event LiquidityRemoved(uint256 indexed poolId, uint256 indexed positionId, address indexed owner,
        uint256 amount0, uint256 amount1, uint256 shares);
    event Swap(uint256 indexed poolId, address indexed sender, address indexed tokenIn,
        uint256 amountIn, uint256 amountOut, address recipient);

    constructor(string memory name_) ERC721(name_, "MLP") {}

    modifier beforeDeadline(uint256 deadline) {
        require(block.timestamp <= deadline, "MiniDEX: expired deadline");
        _;
    }

    function getPool(address tokenA, address tokenB) public view returns (uint256) {
        return tokenA < tokenB ? poolIds[tokenA][tokenB] : poolIds[tokenB][tokenA];
    }

    function createPool(address tokenA, address tokenB) external returns (uint256 poolId) {
        require(tokenA != tokenB, "MiniDEX: identical tokens");
        require(tokenA.code.length > 0 && tokenB.code.length > 0, "MiniDEX: token must be contract");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(poolIds[token0][token1] == 0, "MiniDEX: pair exists");
        poolId = ++poolCount;
        pools[poolId] = Pool(token0, token1, 0, 0, 0, block.timestamp);
        poolIds[token0][token1] = poolId;
        emit PoolCreated(poolId, token0, token1);
    }

    function addLiquidity(uint256 poolId, uint256 amount0Desired, uint256 amount1Desired,
        uint256 amount0Min, uint256 amount1Min, uint256 deadline)
        external nonReentrant beforeDeadline(deadline) returns (uint256 positionId)
    {
        Pool storage pool = _pool(poolId);
        uint256 amount0 = amount0Desired;
        uint256 amount1 = amount1Desired;
        uint256 shares;
        if (pool.totalShares == 0) {
            require(amount0 <= MAX_RESERVE && amount1 <= MAX_RESERVE, "MiniDEX: reserve limit");
            uint256 initialShares = Math.sqrt(amount0 * amount1);
            require(initialShares > MINIMUM_LIQUIDITY, "MiniDEX: initial liquidity too small");
            // These shares remain permanently unowned so the pool can never reset to zero.
            shares = initialShares - MINIMUM_LIQUIDITY;
        } else {
            uint256 amount1Optimal = Math.mulDiv(amount0, pool.reserve1, pool.reserve0);
            if (amount1Optimal <= amount1) {
                amount1 = amount1Optimal;
            } else {
                amount0 = Math.mulDiv(amount1, pool.reserve0, pool.reserve1);
            }
            shares = Math.min(Math.mulDiv(amount0, pool.totalShares, pool.reserve0),
                Math.mulDiv(amount1, pool.totalShares, pool.reserve1));
        }
        require(amount0 > 0 && amount1 > 0 && shares > 0, "MiniDEX: zero liquidity");
        require(amount0 >= amount0Min && amount1 >= amount1Min, "MiniDEX: liquidity slippage");
        _receiveExact(pool.token0, amount0);
        _receiveExact(pool.token1, amount1);
        pool.reserve0 = LiquidityAccounting.increaseReserve(pool.reserve0, amount0, MAX_RESERVE);
        pool.reserve1 = LiquidityAccounting.increaseReserve(pool.reserve1, amount1, MAX_RESERVE);
        pool.totalShares = LiquidityAccounting.mintTotal(pool.totalShares, shares, MINIMUM_LIQUIDITY);
        positionId = nextPositionId++;
        positions[positionId] = Position(poolId, shares, amount0, amount1, block.timestamp);
        _safeMint(msg.sender, positionId);
        emit LiquidityAdded(poolId, positionId, msg.sender, amount0, amount1, shares);
    }

    function removeLiquidity(uint256 positionId, uint256 amount0Min, uint256 amount1Min, uint256 deadline)
        external nonReentrant beforeDeadline(deadline)
    {
        address owner = ownerOf(positionId);
        require(_isAuthorized(owner, msg.sender, positionId), "MiniDEX: position not authorized");
        Position memory position = positions[positionId];
        Pool storage pool = pools[position.poolId];
        uint256 amount0 = Math.mulDiv(position.shares, pool.reserve0, pool.totalShares);
        uint256 amount1 = Math.mulDiv(position.shares, pool.reserve1, pool.totalShares);
        require(amount0 >= amount0Min && amount1 >= amount1Min, "MiniDEX: withdrawal slippage");
        _burn(positionId);
        delete positions[positionId];
        pool.reserve0 = LiquidityAccounting.reduceReserve(pool.reserve0, amount0);
        pool.reserve1 = LiquidityAccounting.reduceReserve(pool.reserve1, amount1);
        pool.totalShares = LiquidityAccounting.burnTotal(pool.totalShares, position.shares, MINIMUM_LIQUIDITY);
        IERC20(pool.token0).safeTransfer(owner, amount0);
        IERC20(pool.token1).safeTransfer(owner, amount1);
        emit LiquidityRemoved(position.poolId, positionId, owner, amount0, amount1, position.shares);
    }

    function quote(uint256 poolId, address tokenIn, uint256 amountIn) public view returns (uint256 amountOut) {
        Pool storage pool = _pool(poolId);
        require(tokenIn == pool.token0 || tokenIn == pool.token1, "MiniDEX: token not in pool");
        (uint256 reserveIn, uint256 reserveOut) = tokenIn == pool.token0
            ? (pool.reserve0, pool.reserve1) : (pool.reserve1, pool.reserve0);
        require(reserveIn > 0 && reserveOut > 0, "MiniDEX: empty pool");
        amountOut = calculateAmountOut(reserveIn, reserveOut, amountIn);
    }

    function swap(uint256 poolId, address tokenIn, uint256 amountIn, uint256 minAmountOut,
        address recipient, uint256 deadline)
        external nonReentrant beforeDeadline(deadline) returns (uint256 amountOut)
    {
        Pool storage pool = _pool(poolId);
        require(recipient != address(0) && recipient != address(this), "MiniDEX: invalid recipient");
        amountOut = quote(poolId, tokenIn, amountIn);
        require(amountIn > 0 && amountOut > 0, "MiniDEX: zero swap");
        require(amountOut >= minAmountOut, "MiniDEX: swap slippage");
        _receiveExact(tokenIn, amountIn);
        address tokenOut;
        if (tokenIn == pool.token0) {
            pool.reserve0 = LiquidityAccounting.increaseReserve(pool.reserve0, amountIn, MAX_RESERVE);
            pool.reserve1 = LiquidityAccounting.reduceReserve(pool.reserve1, amountOut);
            tokenOut = pool.token1;
        } else {
            pool.reserve1 = LiquidityAccounting.increaseReserve(pool.reserve1, amountIn, MAX_RESERVE);
            pool.reserve0 = LiquidityAccounting.reduceReserve(pool.reserve0, amountOut);
            tokenOut = pool.token0;
        }
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
        emit Swap(poolId, msg.sender, tokenIn, amountIn, amountOut, recipient);
    }

    function tokenURI(uint256 positionId) public view override returns (string memory) {
        _requireOwned(positionId);
        Position memory position = positions[positionId];
        Pool memory pool = pools[position.poolId];
        // Keep metadata assembly within the legacy code generator's stack limit.
        bytes memory metadata = abi.encodePacked(
            '{"name":"MiniDEX position #', positionId.toString(), '","description":"Redeemable constant-product liquidity shares; initial amounts are historical.",'
        );
        metadata = abi.encodePacked(
            metadata, '"attributes":[{"trait_type":"Pool","value":', position.poolId.toString(), '},{"trait_type":"Shares (raw)","value":"', position.shares.toString()
        );
        metadata = abi.encodePacked(
            metadata, '"},{"trait_type":"Initial token0 (raw)","value":"', position.amount0.toString(), '"},{"trait_type":"Initial token1 (raw)","value":"', position.amount1.toString()
        );
        metadata = abi.encodePacked(
            metadata, '"},{"trait_type":"Created timestamp","value":', position.createdAt.toString(), '}],"token0":"', Strings.toHexString(pool.token0)
        );
        metadata = abi.encodePacked(
            metadata, '","token1":"', Strings.toHexString(pool.token1), '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(metadata));
    }

    function _pool(uint256 poolId) private view returns (Pool storage pool) {
        pool = pools[poolId];
        require(pool.token0 != address(0), "MiniDEX: pool not found");
    }

    function _receiveExact(address token, uint256 amount) private {
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        // DEFENSE: permissionless pool creation admits transfer-tax tokens, whose short receipts
        // would otherwise let swaps spend reserves belonging to another pool in this exchange.
        require(IERC20(token).balanceOf(address(this)) - balanceBefore == amount,
            "MiniDEX: transfer-tax tokens unsupported");
    }
}
