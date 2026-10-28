// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ICallbackLiquidityDEX {
    function addLiquidity(uint256, uint256, uint256, uint256, uint256, uint256) external returns (uint256);
    function removeLiquidity(uint256, uint256, uint256, uint256) external;
    function safeTransferFrom(address, address, uint256) external;
}

interface ICallbackLiquidityToken {
    function approve(address, uint256) external returns (bool);
}

/// A real contract holder; all pool and NFT behavior goes through the DEX ABI.
contract LiquidityCallbackActor {
    ICallbackLiquidityDEX public immutable dex;
    ICallbackLiquidityToken public immutable token0;
    ICallbackLiquidityToken public immutable token1;
    uint8 public mode;
    address public forwardTo;
    uint256 public victim;
    address public victimOwner;
    uint256 public callbacks;
    uint256 public lastReceived;
    uint256 public attempts;
    bool public victimRemoved;
    bool public victimMoved;

    constructor(address dex_, address token0_, address token1_) {
        dex = ICallbackLiquidityDEX(dex_);
        token0 = ICallbackLiquidityToken(token0_);
        token1 = ICallbackLiquidityToken(token1_);
    }

    function configure(uint8 mode_, address forwardTo_, uint256 victim_, address victimOwner_) external {
        mode = mode_; forwardTo = forwardTo_; victim = victim_; victimOwner = victimOwner_;
    }

    function approveTokens(uint256 amount) external {
        require(token0.approve(address(dex), amount));
        require(token1.approve(address(dex), amount));
    }

    function provide(uint256 pool, uint256 amount0, uint256 amount1) external returns (uint256) {
        return dex.addLiquidity(pool, amount0, amount1, 0, 0, block.timestamp + 1200);
    }

    function forward(uint256 position, address recipient) external {
        dex.safeTransferFrom(address(this), recipient, position);
    }

    function redeem(uint256 position) external {
        dex.removeLiquidity(position, 0, 0, block.timestamp + 1200);
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        require(msg.sender == address(dex), "fixture DEX only");
        callbacks += 1; lastReceived = id;
        if (mode == 1) return bytes4(0);
        if (mode == 2) revert("fixture rejects NFT");
        if (mode == 3) dex.safeTransferFrom(address(this), forwardTo, id);
        if (mode == 4) {
            attempts += 2;
            (victimRemoved,) = address(dex).call(abi.encodeCall(
                ICallbackLiquidityDEX.removeLiquidity, (victim, 0, 0, block.timestamp + 1200)));
            (victimMoved,) = address(dex).call(abi.encodeCall(
                ICallbackLiquidityDEX.safeTransferFrom, (victimOwner, address(this), victim)));
        }
        return this.onERC721Received.selector;
    }
}
