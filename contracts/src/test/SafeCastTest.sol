// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../libraries/SafeCast.sol";

/// @notice Thin wrapper that exposes SafeCast internals for coverage testing
contract SafeCastTest {
    function toUint128(uint256 y) external pure returns (uint128) {
        return SafeCast.toUint128(y);
    }

    function toUint160(uint256 y) external pure returns (uint160) {
        return SafeCast.toUint160(y);
    }

    function toInt128(int256 y) external pure returns (int128) {
        return SafeCast.toInt128(y);
    }

    function toInt256(uint256 y) external pure returns (int256) {
        return SafeCast.toInt256(y);
    }
}
