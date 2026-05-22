// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../libraries/TickMath.sol";

/// @dev Test harness that exposes TickMath library functions for JS tests
contract TickMathTest {
    function getSqrtRatioAtTick(int24 tick) external pure returns (uint160) {
        return TickMath.getSqrtRatioAtTick(tick);
    }

    function getTickAtSqrtRatio(uint160 sqrtPriceX96) external pure returns (int24) {
        return TickMath.getTickAtSqrtRatio(sqrtPriceX96);
    }

    function MIN_TICK() external pure returns (int24) { return TickMath.MIN_TICK; }
    function MAX_TICK() external pure returns (int24) { return TickMath.MAX_TICK; }
    function MIN_SQRT_RATIO() external pure returns (uint160) { return TickMath.MIN_SQRT_RATIO; }
    function MAX_SQRT_RATIO() external pure returns (uint160) { return TickMath.MAX_SQRT_RATIO; }
}
