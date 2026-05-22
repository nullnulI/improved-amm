// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Apply a signed liquidity delta to a uint128
library LiquidityMath {
    function addDelta(uint128 x, int128 y) internal pure returns (uint128 z) {
        if (y < 0) {
            require((z = x - uint128(-y)) < x, "LS");
        } else {
            require((z = x + uint128(y)) >= x, "LA");
        }
    }
}
