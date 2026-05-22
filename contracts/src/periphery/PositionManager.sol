// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../core/Pool.sol";
import "../core/interfaces/IPoolFactory.sol";
import "../core/interfaces/IPoolMintCallback.sol";
import "../libraries/TickMath.sol";
import "../libraries/LiquidityAmounts.sol";
import "../libraries/SafeCast.sol";

/// @title NFT Position Manager
/// @notice Wraps concentrated liquidity positions as ERC-721 tokens.
///         Each token ID represents a unique (pool, tickLower, tickUpper, owner) position.
contract PositionManager is ERC721, IPoolMintCallback {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    IPoolFactory public immutable factory;

    struct PositionData {
        address pool;
        int24   tickLower;
        int24   tickUpper;
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    uint256 private _nextTokenId = 1;
    mapping(uint256 => PositionData) private _positions;

    // ── Events ─────────────────────────────────────────────────────────────────
    event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1);

    // ── Errors ─────────────────────────────────────────────────────────────────
    error NotOwnerOrApproved();
    error DeadlineExpired();
    error ZeroLiquidity();
    error SlippageExceeded();
    error PoolNotFound();

    struct MintParams {
        address token0;
        address token1;
        uint24  fee;
        int24   tickLower;
        int24   tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    struct MintCallbackData {
        address token0;
        address token1;
        uint24  fee;
        address payer;
    }

    constructor(address _factory) ERC721("CL AMM Position", "CL-POS") {
        factory = IPoolFactory(_factory);
    }

    modifier checkDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        _;
    }

    modifier isAuthorized(uint256 tokenId) {
        if (!_isAuthorized(ownerOf(tokenId), msg.sender, tokenId)) revert NotOwnerOrApproved();
        _;
    }

    // ── IPoolMintCallback ──────────────────────────────────────────────────────
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override {
        MintCallbackData memory decoded = abi.decode(data, (MintCallbackData));
        // Verify the caller is the genuine pool for this token pair and fee
        address expectedPool = factory.getPool(decoded.token0, decoded.token1, decoded.fee);
        require(msg.sender == expectedPool, "UNAUTHORIZED_POOL");
        if (amount0Owed > 0) IERC20(decoded.token0).safeTransferFrom(decoded.payer, msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20(decoded.token1).safeTransferFrom(decoded.payer, msg.sender, amount1Owed);
    }

    // ── Mint new position ──────────────────────────────────────────────────────
    function mint(MintParams calldata params)
        external
        checkDeadline(params.deadline)
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        address poolAddr = factory.getPool(params.token0, params.token1, params.fee);
        if (poolAddr == address(0)) revert PoolNotFound();
        Pool pool = Pool(poolAddr);

        // Ensure tokens are ordered as the pool expects
        (address t0, address t1) = params.token0 < params.token1
            ? (params.token0, params.token1)
            : (params.token1, params.token0);

        {
            (uint160 sqrtPriceX96,,,,,) = _getSlot0(pool);
            uint160 sqrtRatioAX96 = TickMath.getSqrtRatioAtTick(params.tickLower);
            uint160 sqrtRatioBX96 = TickMath.getSqrtRatioAtTick(params.tickUpper);
            liquidity = LiquidityAmounts.getLiquidityForAmounts(
                sqrtPriceX96, sqrtRatioAX96, sqrtRatioBX96, params.amount0Desired, params.amount1Desired
            );
        }

        if (liquidity == 0) revert ZeroLiquidity();

        (amount0, amount1) = pool.mint(
            address(this),
            params.tickLower,
            params.tickUpper,
            liquidity,
            abi.encode(MintCallbackData({ token0: t0, token1: t1, fee: params.fee, payer: msg.sender }))
        );

        if (amount0 < params.amount0Min || amount1 < params.amount1Min) revert SlippageExceeded();

        tokenId = _nextTokenId++;
        _safeMint(params.recipient, tokenId);

        (uint256 fg0, uint256 fg1) = _getFeeGrowthInside(pool, params.tickLower, params.tickUpper);
        _positions[tokenId] = PositionData({
            pool:                       poolAddr,
            tickLower:                  params.tickLower,
            tickUpper:                  params.tickUpper,
            liquidity:                  liquidity,
            feeGrowthInside0LastX128:   fg0,
            feeGrowthInside1LastX128:   fg1,
            tokensOwed0:                0,
            tokensOwed1:                0
        });

        emit IncreaseLiquidity(tokenId, liquidity, amount0, amount1);
    }

    // ── Add liquidity to existing position ────────────────────────────────────
    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        checkDeadline(params.deadline)
        isAuthorized(params.tokenId)
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        PositionData storage pos = _positions[params.tokenId];
        Pool pool = Pool(pos.pool);

        (uint160 sqrtPriceX96,,,,,) = _getSlot0(pool);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtRatioAtTick(pos.tickLower),
            TickMath.getSqrtRatioAtTick(pos.tickUpper),
            params.amount0Desired,
            params.amount1Desired
        );
        if (liquidity == 0) revert ZeroLiquidity();

        (address t0, address t1, uint24 fee) = _poolTokens(pool);
        (amount0, amount1) = pool.mint(
            address(this),
            pos.tickLower,
            pos.tickUpper,
            liquidity,
            abi.encode(MintCallbackData({ token0: t0, token1: t1, fee: fee, payer: msg.sender }))
        );

        if (amount0 < params.amount0Min || amount1 < params.amount1Min) revert SlippageExceeded();

        _syncFees(pos, pool);
        pos.liquidity += liquidity;
        emit IncreaseLiquidity(params.tokenId, liquidity, amount0, amount1);
    }

    // ── Remove liquidity from existing position ───────────────────────────────
    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        checkDeadline(params.deadline)
        isAuthorized(params.tokenId)
        returns (uint256 amount0, uint256 amount1)
    {
        if (params.liquidity == 0) revert ZeroLiquidity();
        PositionData storage pos = _positions[params.tokenId];
        Pool pool = Pool(pos.pool);

        (amount0, amount1) = pool.burn(pos.tickLower, pos.tickUpper, params.liquidity);
        if (amount0 < params.amount0Min || amount1 < params.amount1Min) revert SlippageExceeded();

        _syncFees(pos, pool);
        unchecked { pos.liquidity -= params.liquidity; }
        pos.tokensOwed0 += uint128(amount0);
        pos.tokensOwed1 += uint128(amount1);

        emit DecreaseLiquidity(params.tokenId, params.liquidity, amount0, amount1);
    }

    // ── Collect fees ───────────────────────────────────────────────────────────
    function collect(CollectParams calldata params)
        external
        isAuthorized(params.tokenId)
        returns (uint256 amount0, uint256 amount1)
    {
        PositionData storage pos = _positions[params.tokenId];
        Pool pool = Pool(pos.pool);
        address recipient = params.recipient == address(0) ? address(this) : params.recipient;

        // Trigger burn(0) to sync fees owed from the pool
        pool.burn(pos.tickLower, pos.tickUpper, 0);
        _syncFees(pos, pool);

        uint128 req0 = params.amount0Max < pos.tokensOwed0 ? params.amount0Max : pos.tokensOwed0;
        uint128 req1 = params.amount1Max < pos.tokensOwed1 ? params.amount1Max : pos.tokensOwed1;

        (amount0, amount1) = pool.collect(recipient, pos.tickLower, pos.tickUpper, req0, req1);
        pos.tokensOwed0 -= uint128(amount0);
        pos.tokensOwed1 -= uint128(amount1);

        emit Collect(params.tokenId, recipient, amount0, amount1);
    }

    // ── Queries ────────────────────────────────────────────────────────────────
    function positions(uint256 tokenId) external view returns (PositionData memory) {
        return _positions[tokenId];
    }

    function totalSupply() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    // ── Helpers ────────────────────────────────────────────────────────────────
    function _getSlot0(Pool pool) private view returns (
        uint160 sqrtPriceX96, int24 tick, uint16 obsIndex, uint16 obsCard, uint16 obsCardNext, bool unlocked
    ) {
        (sqrtPriceX96, tick, obsIndex, obsCard, obsCardNext, unlocked) = pool.slot0();
    }

    function _poolTokens(Pool pool) private view returns (address t0, address t1, uint24 fee) {
        t0  = pool.token0();
        t1  = pool.token1();
        fee = pool.fee();
    }

    function _getFeeGrowthInside(Pool pool, int24 tickLower, int24 tickUpper)
        private view returns (uint256 fg0, uint256 fg1)
    {
        (uint160 sqrtPrice, int24 tick,,,,) = _getSlot0(pool);
        uint256 fgg0 = pool.feeGrowthGlobal0X128();
        uint256 fgg1 = pool.feeGrowthGlobal1X128();
        fg0 = fgg0; fg1 = fgg1; // simplified snapshot; full calc in Tick library
    }

    function _syncFees(PositionData storage pos, Pool pool) private {
        // Read the on-chain position that the pool manages for this contract
        Position.Info memory onChain = pool.getPosition(address(this), pos.tickLower, pos.tickUpper);
        unchecked {
            uint256 fg0 = onChain.feeGrowthInside0LastX128;
            uint256 fg1 = onChain.feeGrowthInside1LastX128;
            if (fg0 != pos.feeGrowthInside0LastX128 || fg1 != pos.feeGrowthInside1LastX128) {
                pos.tokensOwed0 += onChain.tokensOwed0;
                pos.tokensOwed1 += onChain.tokensOwed1;
                pos.feeGrowthInside0LastX128 = fg0;
                pos.feeGrowthInside1LastX128 = fg1;
            }
        }
    }
}
