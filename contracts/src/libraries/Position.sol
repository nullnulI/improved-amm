// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./FullMath.sol";
import "./SafeCast.sol";

/// @title LP position state and fee accounting
library Position {
    struct Info {
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    function get(
        mapping(bytes32 => Info) storage self,
        address owner,
        int24 tickLower,
        int24 tickUpper
    ) internal view returns (Info storage position) {
        position = self[keccak256(abi.encodePacked(owner, tickLower, tickUpper))];
    }

    function update(
        Info storage self,
        int128 liquidityDelta,
        uint256 feeGrowthInside0X128,
        uint256 feeGrowthInside1X128
    ) internal {
        Info memory _self = self;
        uint128 liquidityNext;
        if (liquidityDelta == 0) {
            require(_self.liquidity > 0);
            liquidityNext = _self.liquidity;
        } else {
            liquidityNext = liquidityDelta < 0
                ? _self.liquidity - uint128(-liquidityDelta)
                : _self.liquidity + uint128(liquidityDelta);
        }

        // Accumulate fees owed since last update
        unchecked {
            uint128 tokensOwed0 = SafeCast.toUint128(
                FullMath.mulDiv(feeGrowthInside0X128 - _self.feeGrowthInside0LastX128, _self.liquidity, 0x100000000000000000000000000000000)
            );
            uint128 tokensOwed1 = SafeCast.toUint128(
                FullMath.mulDiv(feeGrowthInside1X128 - _self.feeGrowthInside1LastX128, _self.liquidity, 0x100000000000000000000000000000000)
            );

            if (liquidityDelta != 0) self.liquidity = liquidityNext;
            self.feeGrowthInside0LastX128 = feeGrowthInside0X128;
            self.feeGrowthInside1LastX128 = feeGrowthInside1X128;
            if (tokensOwed0 > 0 || tokensOwed1 > 0) {
                self.tokensOwed0 += tokensOwed0;
                self.tokensOwed1 += tokensOwed1;
            }
        }
    }
}
