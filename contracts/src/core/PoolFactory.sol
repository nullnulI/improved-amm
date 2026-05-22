// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Pool.sol";
import "./interfaces/IPoolFactory.sol";

/// @title Pool factory — deploys and registers concentrated liquidity pools
contract PoolFactory is IPoolFactory {
    address public override owner;

    /// fee (in pips) → tick spacing
    mapping(uint24 => int24) public override feeAmountTickSpacing;

    /// token0 → token1 → fee → pool address
    mapping(address => mapping(address => mapping(uint24 => address))) public override getPool;

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor() {
        owner = msg.sender;
        // Register the three standard fee tiers used in Uniswap V3
        feeAmountTickSpacing[500]   = 10;   // 0.05%
        feeAmountTickSpacing[3000]  = 60;   // 0.30%
        feeAmountTickSpacing[10000] = 200;  // 1.00%
        emit FeeAmountEnabled(500, 10);
        emit FeeAmountEnabled(3000, 60);
        emit FeeAmountEnabled(10000, 200);
    }

    event FeeAmountEnabled(uint24 indexed fee, int24 indexed tickSpacing);

    function enableFeeAmount(uint24 fee, int24 tickSpacing) external override onlyOwner {
        require(fee < 1_000_000);
        require(tickSpacing > 0 && tickSpacing < 16384);
        require(feeAmountTickSpacing[fee] == 0);
        feeAmountTickSpacing[fee] = tickSpacing;
        emit FeeAmountEnabled(fee, tickSpacing);
    }

    function createPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external override returns (address pool) {
        require(tokenA != tokenB, "SAME_TOKEN");
        (address _token0, address _token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(_token0 != address(0), "ZERO_ADDRESS");
        int24 tickSpacing = feeAmountTickSpacing[fee];
        require(tickSpacing != 0, "FEE_NOT_ENABLED");
        require(getPool[_token0][_token1][fee] == address(0), "POOL_EXISTS");

        pool = address(new Pool(address(this), _token0, _token1, fee, tickSpacing));
        getPool[_token0][_token1][fee] = pool;
        getPool[_token1][_token0][fee] = pool;

        emit PoolCreated(_token0, _token1, fee, tickSpacing, pool);
    }
}
