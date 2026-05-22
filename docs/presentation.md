# 5-Minute Presentation Script

## 1. Problem (0:00-1:00)

Uniswap V2 popularized the constant-product AMM, but normal CPAMMs expose traders to price impact and liquidity providers to market risk. Our project keeps the simple `x * y = k` model, then adds course-project improvements that are easy to reason about and test.

## 2. Architecture (1:00-2:00)

The project has two mock ERC-20 assets, one AMM pool, an ERC-20 LP token, and a React demo frontend. The pool owns the reserves, mints LP shares, and supports bidirectional swaps.

## 3. AMM Math (2:00-3:00)

The base model is `x * y = k`. Our pool quotes swaps using actual reserves plus virtual reserves, then only pays from actual reserves. The quote details show expected output, dynamic fee, and price impact before the user sends a transaction.

## 4. Demo Flow (3:00-4:00)

Use local defaults, mint tokens, approve the AMM, add liquidity, quote and execute an A-to-B swap, switch direction, quote and execute a B-to-A swap, then remove liquidity. Point out the fee, price impact, and reserve changes.

## 5. Security and Limitations (4:00-5:00)

The MVP includes slippage protection, deadline checks, zero-output swap rejection, reentrancy protection, bounded virtual reserve updates, and proportional liquidity checks. It is not production-ready because it lacks oracle protection, governance, formal audits, and advanced MEV defenses.
