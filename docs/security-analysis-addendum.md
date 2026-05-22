# Security Analysis Addendum

This document is an additive note for the current concentrated-liquidity architecture. It does not replace the original `security-analysis.md`; instead, it highlights controls and risks that are specific to the newer pool-based design.

## Scope

The current implementation centers around:

- `Pool.sol` as the concentrated-liquidity execution engine
- `PoolFactory.sol` as the registry and protocol-fee controller
- `PositionManager.sol` as the NFT wrapper for LP positions
- `SwapRouter.sol` and `Quoter.sol` as user-facing periphery contracts
- Oracle and pricing libraries used by the pool for TWAP and tick-based accounting

## Current Security Controls

- **Reentrancy lock in the pool**
  - The pool uses `slot0.unlocked` as a lightweight mutex around state-changing entry points such as `mint`, `burn`, `collect`, `swap`, and observation-capacity updates.
  - This design follows a checks-effects-interactions style and is more relevant to the current architecture than a generic `ReentrancyGuard` description.

- **Callback-based payment verification**
  - Both minting and swapping rely on callback settlement.
  - After the callback returns, the pool validates that the required token balances were actually received before finalizing the operation.

- **Factory-gated protocol fee controls**
  - Protocol fee configuration and fee collection are restricted to the factory or the factory owner.
  - The pool also enforces a denominator constraint so protocol capture cannot be configured to an excessively aggressive value.

- **Bounded price movement during swaps**
  - Swaps require a valid `sqrtPriceLimitX96`.
  - This prevents execution beyond an explicitly bounded price movement and reduces the chance of unexpected path traversal.

- **Tick and liquidity accounting**
  - Tick crossing, fee growth, and position accounting are separated into libraries.
  - This keeps the pool logic modular and reduces the chance of mixing liquidity accounting with token-transfer side effects.

- **TWAP observation support**
  - The pool maintains observations for time-weighted pricing.
  - This is a meaningful improvement over pure spot-price dependence, especially for analytics and fee recommendation features.

## Important Residual Risks

- **No full MEV protection**
  - User-configured deadlines and minimum output checks help, but they do not eliminate sandwich or ordering risk.

- **Oracle freshness depends on pool activity**
  - TWAP quality depends on the observation history and the cadence of state updates.
  - Thin or newly created pools may provide weaker oracle signals than active pools.

- **Centralized factory authority**
  - The factory owner can enable fee tiers and manage protocol-fee collection.
  - This is acceptable for a project setting, but it remains a governance centralization point.

- **Unsupported token behaviors**
  - The system assumes standard ERC-20 transfer semantics.
  - Fee-on-transfer, rebasing, or otherwise unusual tokens may break accounting assumptions.

- **Complexity risk in concentrated-liquidity math**
  - Tick movement, bitmap traversal, price math, and fee-growth bookkeeping are significantly more complex than a constant-product AMM.
  - Even when the implementation is logically structured, this complexity raises audit burden.

## Practical Hardening Directions

- Expand targeted tests for oracle edge cases and observation wrap-around behavior.
- Add focused tests for protocol-fee administration and quote paths that are currently lightly covered.
- Keep all user-facing documentation aligned with the current `Pool`/`PositionManager`/`Router` architecture.
- If the project evolves beyond coursework, add static analysis, symbolic analysis, and external review.

## Summary

The current codebase already includes several meaningful defensive patterns for a coursework-scale concentrated-liquidity AMM: internal locking, callback verification, protocol-fee gating, bounded swap execution, and TWAP support. The main remaining concerns are not missing core controls, but rather governance centralization, token-assumption limits, MEV exposure, and the inherent complexity of concentrated-liquidity accounting.
