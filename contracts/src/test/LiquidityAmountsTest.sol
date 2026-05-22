// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../libraries/LiquidityAmounts.sol";

/// @notice Thin wrapper that exposes LiquidityAmounts library internals for coverage testing.
///         Allows direct calls to internal helpers with unsorted inputs to trigger the
///         sqrtRatioAX96 > sqrtRatioBX96 sorting branch in each function.
contract LiquidityAmountsTest {
    function getLiquidityForAmount0(uint160 a, uint160 b, uint256 amt)
        external pure returns (uint128)
    {
        return LiquidityAmounts.getLiquidityForAmount0(a, b, amt);
    }

    function getLiquidityForAmount1(uint160 a, uint160 b, uint256 amt)
        external pure returns (uint128)
    {
        return LiquidityAmounts.getLiquidityForAmount1(a, b, amt);
    }

    function getLiquidityForAmounts(uint160 p, uint160 a, uint160 b, uint256 amt0, uint256 amt1)
        external pure returns (uint128)
    {
        return LiquidityAmounts.getLiquidityForAmounts(p, a, b, amt0, amt1);
    }

    function getAmount0ForLiquidity(uint160 a, uint160 b, uint128 liq)
        external pure returns (uint256)
    {
        return LiquidityAmounts.getAmount0ForLiquidity(a, b, liq);
    }

    function getAmount1ForLiquidity(uint160 a, uint160 b, uint128 liq)
        external pure returns (uint256)
    {
        return LiquidityAmounts.getAmount1ForLiquidity(a, b, liq);
    }

    function getAmountsForLiquidity(uint160 p, uint160 a, uint160 b, uint128 liq)
        external pure returns (uint256, uint256)
    {
        return LiquidityAmounts.getAmountsForLiquidity(p, a, b, liq);
    }
}
