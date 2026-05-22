// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPoolFactory {
    event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool);

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
    function owner() external view returns (address);
    function enableFeeAmount(uint24 fee, int24 tickSpacing) external;
}
