// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./FullMath.sol";
import "./SafeCast.sol";

/// @title Compute token deltas from sqrt price changes
library SqrtPriceMath {
    using SafeCast for uint256;

    uint256 internal constant Q96 = 0x1000000000000000000000000;

    /// @notice Amount of token0 needed to move price from sqrtRatioAX96 to sqrtRatioBX96
    function getAmount0Delta(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint128 liquidity,
        bool roundUp
    ) internal pure returns (uint256 amount0) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        uint256 numerator1 = uint256(liquidity) << 96;
        uint256 numerator2 = sqrtRatioBX96 - sqrtRatioAX96;
        require(sqrtRatioAX96 > 0);
        return roundUp
            ? FullMath.mulDivRoundingUp(FullMath.mulDivRoundingUp(numerator1, numerator2, sqrtRatioBX96), 1, sqrtRatioAX96)
            : FullMath.mulDiv(FullMath.mulDiv(numerator1, numerator2, sqrtRatioBX96), 1, sqrtRatioAX96);
    }

    /// @notice Amount of token1 needed to move price from sqrtRatioAX96 to sqrtRatioBX96
    function getAmount1Delta(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint128 liquidity,
        bool roundUp
    ) internal pure returns (uint256 amount1) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        return roundUp
            ? FullMath.mulDivRoundingUp(liquidity, sqrtRatioBX96 - sqrtRatioAX96, Q96)
            : FullMath.mulDiv(liquidity, sqrtRatioBX96 - sqrtRatioAX96, Q96);
    }

    /// @notice Signed wrappers (used in Pool swap accounting)
    function getAmount0Delta(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        int128 liquidity
    ) internal pure returns (int256 amount0) {
        return liquidity < 0
            ? -int256(getAmount0Delta(sqrtRatioAX96, sqrtRatioBX96, uint128(-liquidity), false))
            :  int256(getAmount0Delta(sqrtRatioAX96, sqrtRatioBX96, uint128(liquidity), true));
    }

    function getAmount1Delta(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        int128 liquidity
    ) internal pure returns (int256 amount1) {
        return liquidity < 0
            ? -int256(getAmount1Delta(sqrtRatioAX96, sqrtRatioBX96, uint128(-liquidity), false))
            :  int256(getAmount1Delta(sqrtRatioAX96, sqrtRatioBX96, uint128(liquidity), true));
    }

    /// @notice Next sqrt price after spending exactly amountIn of the input token
    function getNextSqrtPriceFromInput(
        uint160 sqrtPX96,
        uint128 liquidity,
        uint256 amountIn,
        bool zeroForOne
    ) internal pure returns (uint160 sqrtQX96) {
        require(sqrtPX96 > 0 && liquidity > 0);
        return zeroForOne
            ? getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountIn, true)
            : getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountIn, true);
    }

    /// @notice Next sqrt price after removing exactly amountOut of the output token
    function getNextSqrtPriceFromOutput(
        uint160 sqrtPX96,
        uint128 liquidity,
        uint256 amountOut,
        bool zeroForOne
    ) internal pure returns (uint160 sqrtQX96) {
        require(sqrtPX96 > 0 && liquidity > 0);
        return zeroForOne
            ? getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountOut, false)
            : getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountOut, false);
    }

    function getNextSqrtPriceFromAmount0RoundingUp(
        uint160 sqrtPX96,
        uint128 liquidity,
        uint256 amount,
        bool add
    ) private pure returns (uint160) {
        if (amount == 0) return sqrtPX96;
        uint256 numerator1 = uint256(liquidity) << 96;
        if (add) {
            unchecked {
                uint256 product = amount * sqrtPX96;
                if (product / amount == sqrtPX96) {
                    uint256 denominator = numerator1 + product;
                    if (denominator >= numerator1) {
                        return SafeCast.toUint160(FullMath.mulDivRoundingUp(numerator1, sqrtPX96, denominator));
                    }
                }
                return SafeCast.toUint160(FullMath.mulDivRoundingUp(numerator1, 1, (numerator1 / sqrtPX96) + amount));
            }
        } else {
            unchecked {
                uint256 product = amount * sqrtPX96;
                require(product / amount == sqrtPX96 && numerator1 > product);
                uint256 denominator = numerator1 - product;
                return SafeCast.toUint160(FullMath.mulDivRoundingUp(numerator1, sqrtPX96, denominator));
            }
        }
    }

    function getNextSqrtPriceFromAmount1RoundingDown(
        uint160 sqrtPX96,
        uint128 liquidity,
        uint256 amount,
        bool add
    ) private pure returns (uint160) {
        if (add) {
            uint256 quotient = amount <= type(uint160).max
                ? (amount << 96) / liquidity
                : FullMath.mulDiv(amount, Q96, liquidity);
            return SafeCast.toUint160(uint256(sqrtPX96) + quotient);
        } else {
            uint256 quotient = amount <= type(uint160).max
                ? FullMath.mulDivRoundingUp(amount, Q96, liquidity)
                : FullMath.mulDivRoundingUp(amount, Q96, liquidity);
            require(sqrtPX96 > quotient);
            unchecked { return uint160(sqrtPX96 - quotient); }
        }
    }
}
