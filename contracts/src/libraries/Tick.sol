// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./LiquidityMath.sol";
import "./SafeCast.sol";

/// @title Tick data structure and operations
library Tick {
    struct Info {
        uint128 liquidityGross;   // total liquidity that references this tick
        int128  liquidityNet;     // net change to active liquidity when tick is crossed left→right
        uint256 feeGrowthOutside0X128;
        uint256 feeGrowthOutside1X128;
        int56   tickCumulativeOutside;
        uint160 secondsPerLiquidityOutsideX128;
        uint32  secondsOutside;
        bool    initialized;
    }

    function tickSpacingToMaxLiquidityPerTick(int24 tickSpacing) internal pure returns (uint128) {
        int24 minTick = (int24(-887272) / tickSpacing) * tickSpacing;
        int24 maxTick = -minTick;
        uint24 numTicks = uint24((maxTick - minTick) / tickSpacing) + 1;
        return type(uint128).max / numTicks;
    }

    /// @notice Retrieve the fee growth inside a tick range up to the current tick
    function getFeeGrowthInside(
        mapping(int24 => Tick.Info) storage self,
        int24 tickLower,
        int24 tickUpper,
        int24 tickCurrent,
        uint256 feeGrowthGlobal0X128,
        uint256 feeGrowthGlobal1X128
    ) internal view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128) {
        Tick.Info storage lower = self[tickLower];
        Tick.Info storage upper = self[tickUpper];

        uint256 feeGrowthBelow0X128;
        uint256 feeGrowthBelow1X128;
        if (tickCurrent >= tickLower) {
            feeGrowthBelow0X128 = lower.feeGrowthOutside0X128;
            feeGrowthBelow1X128 = lower.feeGrowthOutside1X128;
        } else {
            unchecked {
                feeGrowthBelow0X128 = feeGrowthGlobal0X128 - lower.feeGrowthOutside0X128;
                feeGrowthBelow1X128 = feeGrowthGlobal1X128 - lower.feeGrowthOutside1X128;
            }
        }

        uint256 feeGrowthAbove0X128;
        uint256 feeGrowthAbove1X128;
        if (tickCurrent < tickUpper) {
            feeGrowthAbove0X128 = upper.feeGrowthOutside0X128;
            feeGrowthAbove1X128 = upper.feeGrowthOutside1X128;
        } else {
            unchecked {
                feeGrowthAbove0X128 = feeGrowthGlobal0X128 - upper.feeGrowthOutside0X128;
                feeGrowthAbove1X128 = feeGrowthGlobal1X128 - upper.feeGrowthOutside1X128;
            }
        }

        unchecked {
            feeGrowthInside0X128 = feeGrowthGlobal0X128 - feeGrowthBelow0X128 - feeGrowthAbove0X128;
            feeGrowthInside1X128 = feeGrowthGlobal1X128 - feeGrowthBelow1X128 - feeGrowthAbove1X128;
        }
    }

    /// @notice Update a tick when liquidity is added or removed; return true if tick was flipped
    function update(
        mapping(int24 => Tick.Info) storage self,
        int24 tick,
        int24 tickCurrent,
        int128 liquidityDelta,
        uint256 feeGrowthGlobal0X128,
        uint256 feeGrowthGlobal1X128,
        bool upper,
        uint128 maxLiquidity
    ) internal returns (bool flipped) {
        Tick.Info storage info = self[tick];
        uint128 liquidityGrossBefore = info.liquidityGross;
        uint128 liquidityGrossAfter = LiquidityMath.addDelta(liquidityGrossBefore, liquidityDelta);
        require(liquidityGrossAfter <= maxLiquidity);
        flipped = (liquidityGrossAfter == 0) != (liquidityGrossBefore == 0);
        if (liquidityGrossBefore == 0) {
            // Initialize feeGrowthOutside to current globals if tick is below current price
            if (tick <= tickCurrent) {
                info.feeGrowthOutside0X128 = feeGrowthGlobal0X128;
                info.feeGrowthOutside1X128 = feeGrowthGlobal1X128;
            }
            info.initialized = true;
        }
        info.liquidityGross = liquidityGrossAfter;
        unchecked {
            info.liquidityNet = upper
                ? info.liquidityNet - liquidityDelta
                : info.liquidityNet + liquidityDelta;
        }
    }

    /// @notice Clear a tick when it's no longer referenced
    function clear(mapping(int24 => Tick.Info) storage self, int24 tick) internal {
        delete self[tick];
    }

    /// @notice Flip fee growth references when price crosses this tick
    function cross(
        mapping(int24 => Tick.Info) storage self,
        int24 tick,
        uint256 feeGrowthGlobal0X128,
        uint256 feeGrowthGlobal1X128
    ) internal returns (int128 liquidityNet) {
        Tick.Info storage info = self[tick];
        unchecked {
            info.feeGrowthOutside0X128 = feeGrowthGlobal0X128 - info.feeGrowthOutside0X128;
            info.feeGrowthOutside1X128 = feeGrowthGlobal1X128 - info.feeGrowthOutside1X128;
        }
        liquidityNet = info.liquidityNet;
    }
}
