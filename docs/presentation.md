# 5-Minute Presentation Outline

## 1. Problem

Uniswap V2 popularized the constant-product AMM, but normal CPAMMs expose users to price impact and liquidity providers to market risk.

## 2. Architecture

The project has two mock ERC-20 assets, one AMM pool, an ERC-20 LP token, and a React demo frontend.

## 3. AMM Math

The base model is `x * y = k`. Our pool quotes swaps using actual reserves plus virtual reserves, then only pays from actual reserves.

## 4. Demo Flow

Mint tokens, approve the AMM, add liquidity, quote a swap, execute the swap, then inspect reserve changes.

## 5. Security and Limitations

The MVP includes slippage and deadline protection. It is not production-ready because it lacks oracle protection, governance, formal audits, and advanced MEV defenses.
