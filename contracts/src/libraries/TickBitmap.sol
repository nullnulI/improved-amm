// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Packed tick bitmap: each bit represents whether a tick is initialized
library TickBitmap {
    /// @notice Map a tick to its word and bit position inside the bitmap
    function position(int24 tick) private pure returns (int16 wordPos, uint8 bitPos) {
        wordPos = int16(tick >> 8);
        bitPos  = uint8(int8(tick % 256));
    }

    /// @notice Flip a tick's initialized status
    function flipTick(
        mapping(int16 => uint256) storage self,
        int24 tick,
        int24 tickSpacing
    ) internal {
        require(tick % tickSpacing == 0);
        (int16 wordPos, uint8 bitPos) = position(tick / tickSpacing);
        uint256 mask = 1 << bitPos;
        self[wordPos] ^= mask;
    }

    /// @notice Find next initialized tick in the same 256-tick word
    /// @param lte  If true, search leftward (lower ticks); otherwise rightward
    /// @return next        The next tick (may be uninitialized)
    /// @return initialized Whether next is an initialized tick
    function nextInitializedTickWithinOneWord(
        mapping(int16 => uint256) storage self,
        int24 tick,
        int24 tickSpacing,
        bool lte
    ) internal view returns (int24 next, bool initialized) {
        int24 compressed = tick / tickSpacing;
        if (tick < 0 && tick % tickSpacing != 0) compressed--;

        if (lte) {
            (int16 wordPos, uint8 bitPos) = position(compressed);
            uint256 mask = (1 << bitPos) - 1 + (1 << bitPos);
            uint256 masked = self[wordPos] & mask;
            initialized = masked != 0;
            unchecked {
                next = initialized
                    ? (compressed - int24(uint24(bitPos - _msb(masked)))) * tickSpacing
                    : (compressed - int24(uint24(bitPos))) * tickSpacing;
            }
        } else {
            (int16 wordPos, uint8 bitPos) = position(compressed + 1);
            uint256 mask = ~((1 << bitPos) - 1);
            uint256 masked = self[wordPos] & mask;
            initialized = masked != 0;
            unchecked {
                next = initialized
                    ? (compressed + 1 + int24(uint24(_lsb(masked) - bitPos))) * tickSpacing
                    : (compressed + 1 + int24(uint24(type(uint8).max - bitPos))) * tickSpacing;
            }
        }
    }

    function _msb(uint256 x) private pure returns (uint8 r) {
        require(x > 0);
        if (x >= 0x100000000000000000000000000000000) { x >>= 128; r += 128; }
        if (x >= 0x10000000000000000) { x >>= 64; r += 64; }
        if (x >= 0x100000000) { x >>= 32; r += 32; }
        if (x >= 0x10000) { x >>= 16; r += 16; }
        if (x >= 0x100) { x >>= 8; r += 8; }
        if (x >= 0x10) { x >>= 4; r += 4; }
        if (x >= 0x4) { x >>= 2; r += 2; }
        if (x >= 0x2) r += 1;
    }

    function _lsb(uint256 x) private pure returns (uint8 r) {
        require(x > 0);
        r = 255;
        if (x & type(uint128).max > 0) { r -= 128; } else { x >>= 128; }
        if (x & type(uint64).max > 0)  { r -= 64; }  else { x >>= 64; }
        if (x & type(uint32).max > 0)  { r -= 32; }  else { x >>= 32; }
        if (x & type(uint16).max > 0)  { r -= 16; }  else { x >>= 16; }
        if (x & type(uint8).max > 0)   { r -= 8; }   else { x >>= 8; }
        if (x & 0xf > 0)               { r -= 4; }   else { x >>= 4; }
        if (x & 0x3 > 0)               { r -= 2; }   else { x >>= 2; }
        if (x & 0x1 > 0)               r -= 1;
    }
}
