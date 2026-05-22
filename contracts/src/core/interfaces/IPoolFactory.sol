// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Pool Factory Interface
/// @notice Minimal interface exposed by the pool factory to core and periphery contracts.
interface IPoolFactory {
    /// @notice Emitted when a new pool is deployed and registered.
    event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool);

    /// @notice Returns the registered pool for a token pair and fee tier, if it exists.
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);

    /// @notice Deploys and registers a new pool for the given token pair and fee tier.
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);

    /// @notice Returns the configured tick spacing for a fee tier.
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);

    /// @notice Returns the current factory owner.
    function owner() external view returns (address);

    /// @notice Enables a new fee tier with its corresponding tick spacing.
    function enableFeeAmount(uint24 fee, int24 tickSpacing) external;
}
