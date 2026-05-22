// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Pool.sol";
import "./interfaces/IPoolFactory.sol";

/// @title Pool Factory
/// @notice Deploys and registers concentrated liquidity pools. Manages fee tiers and protocol fees.
/// @dev    Pools are created deterministically from (token0, token1, fee). The factory owner
///         can enable new fee tiers and configure protocol fees across any deployed pool.
contract PoolFactory is IPoolFactory {
    /// @notice Address that controls factory-level operations (fee tiers, protocol fees)
    address public override owner;

    /// @notice Maps a fee tier (in pips) to its corresponding tick spacing
    mapping(uint24 => int24) public override feeAmountTickSpacing;

    /// @notice Retrieves the pool address for a given (token0, token1, fee) triplet
    mapping(address => mapping(address => mapping(uint24 => address))) public override getPool;

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    /// @notice Deploy the factory and register the three standard Uniswap V3 fee tiers
    constructor() {
        owner = msg.sender;
        feeAmountTickSpacing[500]   = 10;   // 0.05% — stable pairs, high volume
        feeAmountTickSpacing[3000]  = 60;   // 0.30% — standard pairs
        feeAmountTickSpacing[10000] = 200;  // 1.00% — exotic / high-volatility pairs
        emit FeeAmountEnabled(500, 10);
        emit FeeAmountEnabled(3000, 60);
        emit FeeAmountEnabled(10000, 200);
    }

    event FeeAmountEnabled(uint24 indexed fee, int24 indexed tickSpacing);

    /// @notice Register a new fee tier. Only callable by the factory owner.
    /// @param fee         Fee amount in hundredths of a basis point (e.g. 500 = 0.05%)
    /// @param tickSpacing Tick spacing associated with this fee tier (must be 1–16383)
    function enableFeeAmount(uint24 fee, int24 tickSpacing) external override onlyOwner {
        require(fee < 1_000_000);
        require(tickSpacing > 0 && tickSpacing < 16384);
        require(feeAmountTickSpacing[fee] == 0);
        feeAmountTickSpacing[fee] = tickSpacing;
        emit FeeAmountEnabled(fee, tickSpacing);
    }

    /// @notice Deploy a new concentrated liquidity pool for the given token pair and fee tier.
    /// @dev    Tokens are sorted so token0 < token1. Reverts if the pool already exists.
    /// @param tokenA First token (order does not matter)
    /// @param tokenB Second token (order does not matter)
    /// @param fee    Fee tier (must already be enabled via enableFeeAmount)
    /// @return pool  Address of the newly created Pool contract
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

    /// @notice Configure the protocol fee denominator for a deployed pool.
    ///         A denominator of N means 1/N of each swap fee accrues to the protocol.
    /// @dev    Only callable by the factory owner. The pool enforces N ≥ 4.
    /// @param pool         Address of the Pool to configure
    /// @param denominator  Fee denominator (0 = disabled, ≥ 4 = enabled)
    function setPoolProtocolFee(address pool, uint8 denominator) external onlyOwner {
        Pool(pool).setProtocolFee(denominator);
    }

    /// @notice Collect all accrued protocol fees from a pool and send to `recipient`.
    /// @dev    Only callable by the factory owner.
    /// @param pool      Pool to collect from
    /// @param recipient Address to receive the fees
    /// @return amount0  Token0 collected
    /// @return amount1  Token1 collected
    function collectPoolProtocol(address pool, address recipient)
        external
        onlyOwner
        returns (uint128 amount0, uint128 amount1)
    {
        (amount0, amount1) = Pool(pool).collectProtocol(recipient);
    }
}
