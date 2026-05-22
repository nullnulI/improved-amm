// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../core/Pool.sol";
import "../core/interfaces/IPoolFactory.sol";

/// @title Dynamic Fee Advisor
/// @notice On-chain volatility oracle that queries TWAP data from deployed pools and recommends
///         the optimal fee tier. Addresses the bonus requirement: "Dynamic fee adjustment based
///         on volatility." LPs and routers can query this contract before selecting a pool.
/// @dev    Uses the revert-safe try/catch pattern to gracefully degrade when a pool lacks
///         sufficient observation history. In that case the advisor falls back to the spot tick.
contract DynamicFeeAdvisor {
    IPoolFactory public immutable factory;

    // ── Fee tiers ──────────────────────────────────────────────────────────────
    uint24 public constant LOW_VOL_FEE   = 500;    // 0.05% — stable / correlated pairs
    uint24 public constant MED_VOL_FEE   = 3000;   // 0.30% — standard pairs
    uint24 public constant HIGH_VOL_FEE  = 10000;  // 1.00% — exotic / high-volatility pairs

    // ── Volatility thresholds (absolute tick divergence between 5-min and 30-min TWAP) ─
    /// @dev 1 tick ≈ 0.01% price move.  50 ticks ≈ 0.5%, 200 ticks ≈ 2%.
    int24 public constant MED_VOL_TICKS  = 50;
    int24 public constant HIGH_VOL_TICKS = 200;

    // ── TWAP windows ──────────────────────────────────────────────────────────
    uint32 public constant SHORT_WINDOW = 300;   // 5 minutes
    uint32 public constant LONG_WINDOW  = 1800;  // 30 minutes

    struct VolatilityReport {
        int24  twap5m;
        int24  twap30m;
        int24  tickDivergence;
        uint24 recommendedFeeTier;
        uint8  volatilityLevel;  // 0 = Low, 1 = Medium, 2 = High
        bool   hasSufficientHistory;
    }

    error PoolNotFound(address tokenA, address tokenB, uint24 fee);

    constructor(address _factory) {
        factory = IPoolFactory(_factory);
    }

    // ── Primary query ──────────────────────────────────────────────────────────

    /// @notice Compute on-chain volatility and recommend the optimal fee tier for a pair.
    /// @dev    Reads TWAP at 5-minute and 30-minute windows from the specified pool.
    ///         Falls back gracefully when the pool lacks enough observation history.
    /// @param tokenA    First token of the pair (order does not matter)
    /// @param tokenB    Second token of the pair
    /// @param refFee    Fee tier of the reference pool used for TWAP data
    /// @return report   Full volatility report including recommended fee tier
    function getVolatilityReport(
        address tokenA,
        address tokenB,
        uint24  refFee
    ) external view returns (VolatilityReport memory report) {
        address poolAddr = factory.getPool(tokenA, tokenB, refFee);
        if (poolAddr == address(0)) revert PoolNotFound(tokenA, tokenB, refFee);
        Pool pool = Pool(poolAddr);

        // ── Read short TWAP (5 min) ────────────────────────────────────────────
        bool shortOk;
        try pool.getTWAP(SHORT_WINDOW) returns (int24 twap5m) {
            report.twap5m = twap5m;
            shortOk = true;
        } catch {
            // Insufficient history — fall back to spot tick
            (, int24 spotTick,,,,) = pool.slot0();
            report.twap5m = spotTick;
        }

        // ── Read long TWAP (30 min) ────────────────────────────────────────────
        bool longOk;
        try pool.getTWAP(LONG_WINDOW) returns (int24 twap30m) {
            report.twap30m = twap30m;
            longOk = true;
        } catch {
            report.twap30m = report.twap5m;
        }

        report.hasSufficientHistory = shortOk && longOk;

        // ── Compute absolute tick divergence ───────────────────────────────────
        int24 div = report.twap5m > report.twap30m
            ? report.twap5m - report.twap30m
            : report.twap30m - report.twap5m;
        report.tickDivergence = div;

        // ── Map divergence → recommended fee tier ─────────────────────────────
        if (div >= HIGH_VOL_TICKS) {
            report.recommendedFeeTier = HIGH_VOL_FEE;
            report.volatilityLevel    = 2; // High
        } else if (div >= MED_VOL_TICKS) {
            report.recommendedFeeTier = MED_VOL_FEE;
            report.volatilityLevel    = 1; // Medium
        } else {
            report.recommendedFeeTier = LOW_VOL_FEE;
            report.volatilityLevel    = 0; // Low
        }
    }

    /// @notice Return the address of the pool matching the TWAP-recommended fee tier.
    ///         Returns address(0) if that fee tier pool has not been deployed yet.
    /// @param tokenA    First token of the pair
    /// @param tokenB    Second token of the pair
    /// @param refFee    Fee tier of the reference pool used for TWAP data
    /// @return optPool  Address of the recommended pool (may be address(0) if not deployed)
    /// @return optFee   Recommended fee tier
    function getOptimalPool(
        address tokenA,
        address tokenB,
        uint24  refFee
    ) external view returns (address optPool, uint24 optFee) {
        VolatilityReport memory report = this.getVolatilityReport(tokenA, tokenB, refFee);
        optFee  = report.recommendedFeeTier;
        optPool = factory.getPool(tokenA, tokenB, optFee);
    }

    /// @notice Convenience helper: true if the given fee tier is currently optimal for this pair.
    /// @param tokenA  First token
    /// @param tokenB  Second token
    /// @param refFee  Reference pool fee
    /// @param checkFee Fee tier to evaluate
    function isOptimalFeeTier(
        address tokenA,
        address tokenB,
        uint24  refFee,
        uint24  checkFee
    ) external view returns (bool) {
        VolatilityReport memory report = this.getVolatilityReport(tokenA, tokenB, refFee);
        return report.recommendedFeeTier == checkFee;
    }
}
