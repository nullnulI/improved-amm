# Flash Loan Proposal

This note is a lightweight implementation proposal for adding flash-loan support to the current concentrated-liquidity AMM. It is intentionally scoped as an additive design note and does not imply that the feature is already implemented.

## Motivation

Flash loans would add one more DeFi-native primitive to the project without requiring a major architectural rewrite. The current `Pool.sol` structure already contains several useful building blocks:

- direct custody of `token0` and `token1`
- callback-based interaction patterns
- balance-delta verification after external callbacks
- a pool-level reentrancy lock

Because of that, a minimal flash-loan feature should fit the existing design reasonably well.

## Minimal Interface Shape

A simple version can follow this pattern:

```solidity
function flash(
    address recipient,
    uint256 amount0,
    uint256 amount1,
    bytes calldata data
) external;
```

The pool would transfer the requested tokens, invoke a borrower callback, and then verify that the borrowed amounts plus fees were returned before the transaction completes.

## Suggested Callback

The borrower side can use a dedicated callback interface:

```solidity
interface IPoolFlashCallback {
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external;
}
```

This keeps the integration style consistent with the current mint and swap callback flows.

## Minimal Execution Flow

1. Validate that at least one borrow amount is non-zero.
2. Compute `fee0` and `fee1`.
3. Transfer the borrowed tokens to the recipient.
4. Invoke the borrower callback.
5. Verify that pool balances increased by at least `amount + fee`.
6. Route the fee according to the project’s chosen accounting rule.
7. Emit a flash-loan event.

## Simple Fee Strategy

For a coursework-scale implementation, the simplest strategy is:

- charge a fixed fee proportional to `amount0` and `amount1`
- keep the fee denominator aligned with the pool fee style where practical
- treat returned fees as pool income first
- optionally split out a protocol portion later if the project wants tighter integration with protocol-fee accounting

This avoids overcomplicating the first version.

## Suggested Test Scope

The first implementation only needs a few focused tests:

- successful flash loan with full repayment
- revert when the callback does not return enough `token0`
- revert when the callback does not return enough `token1`
- revert when both requested amounts are zero

These tests are enough to demonstrate behavior without creating a large testing surface.

## Recommendation

If the feature is added later, it should be implemented as a small, isolated extension to `Pool.sol` plus one callback interface and a compact borrower test contract. That would provide visible technical depth while keeping the current codebase stable.
