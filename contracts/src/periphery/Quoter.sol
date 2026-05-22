// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../core/Pool.sol";
import "../core/interfaces/IPoolFactory.sol";
import "../core/interfaces/IPoolSwapCallback.sol";
import "../libraries/TickMath.sol";
import "../libraries/SafeCast.sol";

/// @title Quoter — simulate swaps without spending gas on state changes
/// @notice Reverts with the result encoded so the caller can catch and decode.
contract Quoter is IPoolSwapCallback {
    using SafeCast for uint256;

    IPoolFactory public immutable factory;

    constructor(address _factory) {
        factory = IPoolFactory(_factory);
    }

    // ── Callback (reverts with result) ─────────────────────────────────────────
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata
    ) external pure override {
            // Revert with the OUTPUT amount (the negative delta of the output token)
        // amount0Delta < 0 means pool sends token0 (output), amount1Delta < 0 means pool sends token1 (output)
        uint256 amountOut = amount0Delta < 0
            ? uint256(-amount0Delta)
            : uint256(-amount1Delta);
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, amountOut)
            revert(ptr, 32)
        }
    }

    // ── Quote exact input, single hop ─────────────────────────────────────────
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountOut) {
        bool zeroForOne = tokenIn < tokenOut;
        address poolAddr = factory.getPool(tokenIn, tokenOut, fee);
        require(poolAddr != address(0), "POOL_NOT_FOUND");

        try Pool(poolAddr).swap(
            address(this),
            zeroForOne,
            amountIn.toInt256(),
            sqrtPriceLimitX96 == 0
                ? (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                : sqrtPriceLimitX96,
            abi.encode(tokenIn)
        ) {} catch (bytes memory reason) {
            amountOut = _parseRevertReason(reason);
        }
    }

    // ── Quote exact output, single hop ────────────────────────────────────────
    function quoteExactOutputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountOut,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountIn) {
        bool zeroForOne = tokenIn < tokenOut;
        address poolAddr = factory.getPool(tokenIn, tokenOut, fee);
        require(poolAddr != address(0), "POOL_NOT_FOUND");

        try Pool(poolAddr).swap(
            address(this),
            zeroForOne,
            -amountOut.toInt256(),
            sqrtPriceLimitX96 == 0
                ? (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                : sqrtPriceLimitX96,
            abi.encode(tokenIn)
        ) {} catch (bytes memory reason) {
            amountIn = _parseRevertReason(reason);
        }
    }

    function _parseRevertReason(bytes memory reason) private pure returns (uint256) {
        if (reason.length != 32) {
            if (reason.length < 68) revert("Unexpected revert");
            assembly { reason := add(reason, 68) }
            revert(string(reason));
        }
        return abi.decode(reason, (uint256));
    }
}
