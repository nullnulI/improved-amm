// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../libraries/TickMath.sol";
import "../libraries/Tick.sol";
import "../libraries/TickBitmap.sol";
import "../libraries/Position.sol";
import "../libraries/Oracle.sol";
import "../libraries/SwapMath.sol";
import "../libraries/SqrtPriceMath.sol";
import "../libraries/LiquidityMath.sol";
import "../libraries/FullMath.sol";
import "../libraries/SafeCast.sol";
import "./interfaces/IPoolMintCallback.sol";
import "./interfaces/IPoolSwapCallback.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Concentrated Liquidity Pool
/// @notice Implements Uniswap V3-style concentrated liquidity with TWAP oracle and fee accumulation.
contract Pool {
    using SafeERC20 for IERC20;
    using Tick for mapping(int24 => Tick.Info);
    using TickBitmap for mapping(int16 => uint256);
    using Position for mapping(bytes32 => Position.Info);
    using Position for Position.Info;
    using Oracle for Oracle.Observation[65535];
    using SafeCast for uint256;
    using SafeCast for int256;

    // ── Immutables ─────────────────────────────────────────────────────────────
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint24  public immutable fee;
    int24   public immutable tickSpacing;
    uint128 public immutable maxLiquidityPerTick;

    // ── Slot0 (packed into one storage word) ──────────────────────────────────
    struct Slot0 {
        uint160 sqrtPriceX96;
        int24   tick;
        uint16  observationIndex;
        uint16  observationCardinality;
        uint16  observationCardinalityNext;
        bool    unlocked;
    }
    Slot0 public slot0;

    // ── Pool state ─────────────────────────────────────────────────────────────
    uint256 public feeGrowthGlobal0X128;
    uint256 public feeGrowthGlobal1X128;
    uint128 public liquidity;

    struct ProtocolFees { uint128 token0; uint128 token1; }
    ProtocolFees public protocolFees;

    mapping(int24 => Tick.Info)           public ticks;
    mapping(int16 => uint256)             public tickBitmap;
    mapping(bytes32 => Position.Info)     public positions;
    Oracle.Observation[65535]             public observations;

    // ── Events ─────────────────────────────────────────────────────────────────
    event Initialize(uint160 sqrtPriceX96, int24 tick);
    event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper,
               uint128 amount, uint256 amount0, uint256 amount1);
    event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper,
               uint128 amount, uint256 amount0, uint256 amount1);
    event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1,
               uint160 sqrtPriceX96, uint128 liquidity, int24 tick);
    event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper,
                  uint128 amount0, uint128 amount1);
    event CollectProtocol(address indexed sender, address indexed recipient, uint128 amount0, uint128 amount1);
    event IncreaseObservationCardinalityNext(uint16 oldNext, uint16 newNext);

    // ── Errors ─────────────────────────────────────────────────────────────────
    error Locked();
    error NotInitialized();
    error AlreadyInitialized();
    error InvalidTickRange();
    error ZeroLiquidity();
    error InsufficientToken0();
    error InsufficientToken1();
    error PriceLimitOutOfBounds();
    error PriceLimitWrongDirection();

    modifier lock() {
        if (!slot0.unlocked) revert Locked();
        slot0.unlocked = false;
        _;
        slot0.unlocked = true;
    }

    constructor(
        address _factory,
        address _token0,
        address _token1,
        uint24 _fee,
        int24 _tickSpacing
    ) {
        factory     = _factory;
        token0      = _token0;
        token1      = _token1;
        fee         = _fee;
        tickSpacing = _tickSpacing;
        maxLiquidityPerTick = Tick.tickSpacingToMaxLiquidityPerTick(_tickSpacing);
    }

    // ── Initialise ─────────────────────────────────────────────────────────────
    function initialize(uint160 sqrtPriceX96) external {
        if (slot0.sqrtPriceX96 != 0) revert AlreadyInitialized();
        int24 tick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);
        (uint16 cardinality, uint16 cardinalityNext) = observations.initialize(_blockTimestamp());
        slot0 = Slot0({
            sqrtPriceX96:               sqrtPriceX96,
            tick:                       tick,
            observationIndex:           0,
            observationCardinality:     cardinality,
            observationCardinalityNext: cardinalityNext,
            unlocked:                   true
        });
        emit Initialize(sqrtPriceX96, tick);
    }

    // ── Add liquidity ──────────────────────────────────────────────────────────
    function mint(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount,
        bytes calldata data
    ) external lock returns (uint256 amount0, uint256 amount1) {
        if (slot0.sqrtPriceX96 == 0) revert NotInitialized();
        if (amount == 0) revert ZeroLiquidity();
        _checkTicks(tickLower, tickUpper);

        (, int256 amount0Int, int256 amount1Int) = _modifyPosition(
            ModifyPositionParams({
                owner:       recipient,
                tickLower:   tickLower,
                tickUpper:   tickUpper,
                liquidityDelta: int256(uint256(amount)).toInt128()
            })
        );

        amount0 = uint256(amount0Int);
        amount1 = uint256(amount1Int);

        uint256 balance0Before = _balance0();
        uint256 balance1Before = _balance1();
        IPoolMintCallback(msg.sender).uniswapV3MintCallback(amount0, amount1, data);
        if (amount0 > 0 && balance0Before + amount0 > _balance0()) revert InsufficientToken0();
        if (amount1 > 0 && balance1Before + amount1 > _balance1()) revert InsufficientToken1();

        emit Mint(msg.sender, recipient, tickLower, tickUpper, amount, amount0, amount1);
    }

    // ── Remove liquidity (does not transfer; use collect after) ───────────────
    function burn(
        int24 tickLower,
        int24 tickUpper,
        uint128 amount
    ) external lock returns (uint256 amount0, uint256 amount1) {
        _checkTicks(tickLower, tickUpper);
        (Position.Info storage position, int256 amount0Int, int256 amount1Int) = _modifyPosition(
            ModifyPositionParams({
                owner:          msg.sender,
                tickLower:      tickLower,
                tickUpper:      tickUpper,
                liquidityDelta: -int256(uint256(amount)).toInt128()
            })
        );
        amount0 = uint256(-amount0Int);
        amount1 = uint256(-amount1Int);
        if (amount0 > 0 || amount1 > 0) {
            position.tokensOwed0 += uint128(amount0);
            position.tokensOwed1 += uint128(amount1);
        }
        emit Burn(msg.sender, tickLower, tickUpper, amount, amount0, amount1);
    }

    // ── Collect accrued fees & burned tokens ──────────────────────────────────
    function collect(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external lock returns (uint128 amount0, uint128 amount1) {
        Position.Info storage position = positions.get(msg.sender, tickLower, tickUpper);
        amount0 = amount0Requested > position.tokensOwed0 ? position.tokensOwed0 : amount0Requested;
        amount1 = amount1Requested > position.tokensOwed1 ? position.tokensOwed1 : amount1Requested;
        if (amount0 > 0) { position.tokensOwed0 -= amount0; IERC20(token0).safeTransfer(recipient, amount0); }
        if (amount1 > 0) { position.tokensOwed1 -= amount1; IERC20(token1).safeTransfer(recipient, amount1); }
        emit Collect(msg.sender, recipient, tickLower, tickUpper, amount0, amount1);
    }

    // ── Swap ───────────────────────────────────────────────────────────────────
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external lock returns (int256 amount0, int256 amount1) {
        if (slot0.sqrtPriceX96 == 0) revert NotInitialized();
        require(amountSpecified != 0);

        Slot0 memory slot0Start = slot0;
        if (zeroForOne) {
            if (!(sqrtPriceLimitX96 < slot0Start.sqrtPriceX96 && sqrtPriceLimitX96 > TickMath.MIN_SQRT_RATIO))
                revert PriceLimitOutOfBounds();
        } else {
            if (!(sqrtPriceLimitX96 > slot0Start.sqrtPriceX96 && sqrtPriceLimitX96 < TickMath.MAX_SQRT_RATIO))
                revert PriceLimitOutOfBounds();
        }

        SwapState memory state = SwapState({
            amountSpecifiedRemaining: amountSpecified,
            amountCalculated:         0,
            sqrtPriceX96:             slot0Start.sqrtPriceX96,
            tick:                     slot0Start.tick,
            feeGrowthGlobalX128:      zeroForOne ? feeGrowthGlobal0X128 : feeGrowthGlobal1X128,
            liquidity:                liquidity
        });

        while (state.amountSpecifiedRemaining != 0 && state.sqrtPriceX96 != sqrtPriceLimitX96) {
            StepComputations memory step;
            step.sqrtPriceStartX96 = state.sqrtPriceX96;

            (step.tickNext, step.initialized) = tickBitmap.nextInitializedTickWithinOneWord(
                state.tick, tickSpacing, zeroForOne
            );

            if (step.tickNext < TickMath.MIN_TICK) step.tickNext = TickMath.MIN_TICK;
            else if (step.tickNext > TickMath.MAX_TICK) step.tickNext = TickMath.MAX_TICK;

            step.sqrtPriceNextX96 = TickMath.getSqrtRatioAtTick(step.tickNext);

            (state.sqrtPriceX96, step.amountIn, step.amountOut, step.feeAmount) = SwapMath.computeSwapStep(
                state.sqrtPriceX96,
                (zeroForOne ? step.sqrtPriceNextX96 < sqrtPriceLimitX96 : step.sqrtPriceNextX96 > sqrtPriceLimitX96)
                    ? sqrtPriceLimitX96
                    : step.sqrtPriceNextX96,
                state.liquidity,
                state.amountSpecifiedRemaining,
                fee
            );

            if (amountSpecified > 0) {
                unchecked {
                    state.amountSpecifiedRemaining -= (step.amountIn + step.feeAmount).toInt256();
                    state.amountCalculated -= step.amountOut.toInt256();
                }
            } else {
                unchecked {
                    state.amountSpecifiedRemaining += step.amountOut.toInt256();
                    state.amountCalculated         += (step.amountIn + step.feeAmount).toInt256();
                }
            }

            if (state.liquidity > 0) {
                unchecked {
                    state.feeGrowthGlobalX128 += FullMath.mulDiv(step.feeAmount, 0x100000000000000000000000000000000, state.liquidity);
                }
            }

            if (state.sqrtPriceX96 == step.sqrtPriceNextX96) {
                if (step.initialized) {
                    // Update fee globals before crossing
                    if (zeroForOne) feeGrowthGlobal0X128 = state.feeGrowthGlobalX128;
                    else            feeGrowthGlobal1X128 = state.feeGrowthGlobalX128;

                    int128 liquidityNet = ticks.cross(step.tickNext, feeGrowthGlobal0X128, feeGrowthGlobal1X128);
                    if (zeroForOne) liquidityNet = -liquidityNet;
                    state.liquidity = LiquidityMath.addDelta(state.liquidity, liquidityNet);
                }
                unchecked {
                    state.tick = zeroForOne ? step.tickNext - 1 : step.tickNext;
                }
            } else if (state.sqrtPriceX96 != step.sqrtPriceStartX96) {
                state.tick = TickMath.getTickAtSqrtRatio(state.sqrtPriceX96);
            }
        }

        // ── Commit state ───────────────────────────────────────────────────────
        if (state.tick != slot0Start.tick) {
            (uint16 obsIndex, uint16 obsCardinality) = observations.write(
                slot0Start.observationIndex,
                _blockTimestamp(),
                slot0Start.tick,
                liquidity,
                slot0Start.observationCardinality,
                slot0Start.observationCardinalityNext
            );
            slot0.sqrtPriceX96           = state.sqrtPriceX96;
            slot0.tick                   = state.tick;
            slot0.observationIndex       = obsIndex;
            slot0.observationCardinality = obsCardinality;
        } else {
            slot0.sqrtPriceX96 = state.sqrtPriceX96;
        }

        if (liquidity != state.liquidity) liquidity = state.liquidity;

        if (zeroForOne) {
            feeGrowthGlobal0X128 = state.feeGrowthGlobalX128;
        } else {
            feeGrowthGlobal1X128 = state.feeGrowthGlobalX128;
        }

        (amount0, amount1) = zeroForOne == (amountSpecified > 0)
            ? (amountSpecified - state.amountSpecifiedRemaining, state.amountCalculated)
            : (state.amountCalculated, amountSpecified - state.amountSpecifiedRemaining);

        if (zeroForOne) {
            if (amount1 < 0) IERC20(token1).safeTransfer(recipient, uint256(-amount1));
            uint256 balance0Before = _balance0();
            IPoolSwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
            require(_balance0() >= balance0Before + uint256(amount0));
        } else {
            if (amount0 < 0) IERC20(token0).safeTransfer(recipient, uint256(-amount0));
            uint256 balance1Before = _balance1();
            IPoolSwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
            require(_balance1() >= balance1Before + uint256(amount1));
        }

        emit Swap(msg.sender, recipient, amount0, amount1, state.sqrtPriceX96, state.liquidity, state.tick);
    }

    // ── Increase TWAP observation capacity ─────────────────────────────────────
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external lock {
        uint16 observationCardinalityNextOld = slot0.observationCardinalityNext;
        uint16 observationCardinalityNextNew = observations.grow(observationCardinalityNextOld, observationCardinalityNext);
        slot0.observationCardinalityNext = observationCardinalityNextNew;
        if (observationCardinalityNextOld != observationCardinalityNextNew)
            emit IncreaseObservationCardinalityNext(observationCardinalityNextOld, observationCardinalityNextNew);
    }

    // ── TWAP read ──────────────────────────────────────────────────────────────
    function observe(uint32[] calldata secondsAgos) external view returns (
        int56[] memory tickCumulatives,
        uint160[] memory secondsPerLiquidityCumulativeX128s
    ) {
        return observations.observe(
            _blockTimestamp(),
            secondsAgos,
            slot0.tick,
            slot0.observationIndex,
            liquidity,
            slot0.observationCardinality
        );
    }

    /// @notice Returns time-weighted average tick over a period
    function getTWAP(uint32 secondsAgo) external view returns (int24 arithmeticMeanTick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = secondsAgo;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives,) = observations.observe(
            _blockTimestamp(), secondsAgos, slot0.tick,
            slot0.observationIndex, liquidity, slot0.observationCardinality
        );
        int56 tickCumulativesDelta = tickCumulatives[1] - tickCumulatives[0];
        arithmeticMeanTick = int24(tickCumulativesDelta / int56(uint56(secondsAgo)));
        if (tickCumulativesDelta < 0 && (tickCumulativesDelta % int56(uint56(secondsAgo)) != 0))
            arithmeticMeanTick--;
    }

    // ── Position state query ───────────────────────────────────────────────────
    function getPosition(address owner, int24 tickLower, int24 tickUpper)
        external view returns (Position.Info memory)
    {
        return positions.get(owner, tickLower, tickUpper);
    }

    // ── Internals ──────────────────────────────────────────────────────────────
    struct ModifyPositionParams {
        address owner;
        int24   tickLower;
        int24   tickUpper;
        int128  liquidityDelta;
    }

    struct SwapState {
        int256  amountSpecifiedRemaining;
        int256  amountCalculated;
        uint160 sqrtPriceX96;
        int24   tick;
        uint256 feeGrowthGlobalX128;
        uint128 liquidity;
    }

    struct StepComputations {
        uint160 sqrtPriceStartX96;
        int24   tickNext;
        bool    initialized;
        uint160 sqrtPriceNextX96;
        uint256 amountIn;
        uint256 amountOut;
        uint256 feeAmount;
    }

    function _modifyPosition(ModifyPositionParams memory params)
        private
        returns (Position.Info storage position, int256 amount0, int256 amount1)
    {
        _checkTicks(params.tickLower, params.tickUpper);
        Slot0 memory _slot0 = slot0;

        position = _updatePosition(params.owner, params.tickLower, params.tickUpper, params.liquidityDelta, _slot0.tick);

        if (params.liquidityDelta != 0) {
            if (_slot0.tick < params.tickLower) {
                amount0 = SqrtPriceMath.getAmount0Delta(
                    TickMath.getSqrtRatioAtTick(params.tickLower),
                    TickMath.getSqrtRatioAtTick(params.tickUpper),
                    params.liquidityDelta
                );
            } else if (_slot0.tick < params.tickUpper) {
                uint128 liquidityBefore = liquidity;
                (uint16 obsIdx, uint16 obsCard) = observations.write(
                    _slot0.observationIndex, _blockTimestamp(), _slot0.tick,
                    liquidityBefore, _slot0.observationCardinality, _slot0.observationCardinalityNext
                );
                slot0.observationIndex       = obsIdx;
                slot0.observationCardinality = obsCard;

                amount0 = SqrtPriceMath.getAmount0Delta(
                    _slot0.sqrtPriceX96,
                    TickMath.getSqrtRatioAtTick(params.tickUpper),
                    params.liquidityDelta
                );
                amount1 = SqrtPriceMath.getAmount1Delta(
                    TickMath.getSqrtRatioAtTick(params.tickLower),
                    _slot0.sqrtPriceX96,
                    params.liquidityDelta
                );
                liquidity = LiquidityMath.addDelta(liquidityBefore, params.liquidityDelta);
            } else {
                amount1 = SqrtPriceMath.getAmount1Delta(
                    TickMath.getSqrtRatioAtTick(params.tickLower),
                    TickMath.getSqrtRatioAtTick(params.tickUpper),
                    params.liquidityDelta
                );
            }
        }
    }

    function _updatePosition(
        address owner,
        int24 tickLower,
        int24 tickUpper,
        int128 liquidityDelta,
        int24 tick
    ) private returns (Position.Info storage position) {
        position = positions.get(owner, tickLower, tickUpper);

        uint256 _feeGrowthGlobal0X128 = feeGrowthGlobal0X128;
        uint256 _feeGrowthGlobal1X128 = feeGrowthGlobal1X128;

        bool flippedLower;
        bool flippedUpper;
        if (liquidityDelta != 0) {
            flippedLower = ticks.update(tickLower, tick, liquidityDelta, _feeGrowthGlobal0X128, _feeGrowthGlobal1X128, false, maxLiquidityPerTick);
            flippedUpper = ticks.update(tickUpper, tick, liquidityDelta, _feeGrowthGlobal0X128, _feeGrowthGlobal1X128, true,  maxLiquidityPerTick);
            if (flippedLower) tickBitmap.flipTick(tickLower, tickSpacing);
            if (flippedUpper) tickBitmap.flipTick(tickUpper, tickSpacing);
        }

        (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128) =
            ticks.getFeeGrowthInside(tickLower, tickUpper, tick, _feeGrowthGlobal0X128, _feeGrowthGlobal1X128);

        position.update(liquidityDelta, feeGrowthInside0X128, feeGrowthInside1X128);

        if (liquidityDelta < 0) {
            if (flippedLower) ticks.clear(tickLower);
            if (flippedUpper) ticks.clear(tickUpper);
        }
    }

    function _checkTicks(int24 tickLower, int24 tickUpper) private pure {
        if (tickLower >= tickUpper) revert InvalidTickRange();
        if (tickLower < TickMath.MIN_TICK) revert InvalidTickRange();
        if (tickUpper > TickMath.MAX_TICK) revert InvalidTickRange();
    }

    function _balance0() private view returns (uint256) { return IERC20(token0).balanceOf(address(this)); }
    function _balance1() private view returns (uint256) { return IERC20(token1).balanceOf(address(this)); }
    function _blockTimestamp() private view returns (uint32) { return uint32(block.timestamp); }
}
