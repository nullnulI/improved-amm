# SC6107 Concentrated Liquidity AMM

**Option 5: Automated Market Maker with Novel Features** — SC6107 Blockchain Development Fundamentals

A full Uniswap V3-style **concentrated liquidity AMM** built from scratch in Solidity 0.8.24.

## Features

- **Concentrated liquidity** — LPs choose `[tickLower, tickUpper]` price ranges, maximising capital efficiency over Uni V2
- **ERC-721 NFT positions** — each LP position is a unique, transferable NFT
- **Three fee tiers** — 0.05% / 0.30% / 1.00% with corresponding tick spacings (10 / 60 / 200)
- **TWAP oracle** — manipulation-resistant geometric mean price feed built into every pool
- **Multi-hop SwapRouter** — exact-input single and multi-hop routing
- **Gas-free Quoter** — simulate any swap without spending gas
- **51 passing tests** — unit, integration, and pool-flow tests

## Quick Start

```bash
npm install
npm run compile
npm test
```

Run a local chain and deploy:

```bash
# Terminal 1
npm run node

# Terminal 2
npm run deploy
```

Copy the printed addresses into `frontend/src/App.jsx`, then start the dev server:

```bash
npm run dev
```

## Project Structure

```
contracts/src/
  libraries/              Math primitives
    TickMath.sol          tick ↔ sqrtPrice (Q64.96)
    FullMath.sol          512-bit mulDiv
    SqrtPriceMath.sol     token deltas from price changes
    LiquidityAmounts.sol  liquidity ↔ token amounts
    SwapMath.sol          single-step swap computation
    TickBitmap.sol        packed tick initialized-flag bitmap
    Tick.sol              per-tick fee tracking
    Position.sol          per-position fee accumulation
    Oracle.sol            TWAP observation ring-buffer
    LiquidityMath.sol     uint128 add/subtract with delta
    SafeCast.sol          safe integer down-casts
  core/
    Pool.sol              concentrated liquidity engine (mint/burn/swap/collect)
    PoolFactory.sol       deploys and registers pools
    interfaces/           callback interfaces
  periphery/
    PositionManager.sol   ERC-721 NFT LP position manager
    SwapRouter.sol        single-hop and multi-hop swap router
    Quoter.sol            gas-free price quoter
  MockERC20.sol           mintable test token
  ImprovedAMM.sol         V1 baseline (virtual reserves + dynamic fees)
  test/
    TickMathTest.sol      test harness for TickMath library

contracts/test/
  ImprovedAMM.test.js     V1 tests
  Pool.test.js            concentrated liquidity pool tests
  integration/
    FullFlow.test.js      end-to-end: factory → LP → swap → collect
  libraries/
    TickMath.test.js      tick math unit tests

docs/
  architecture.md         full system design, math, security
  security-analysis.md
  gas-optimization.md
```

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the complete design including math, fee accounting, tick crossing, and TWAP oracle.

## Team Contributions

| Member | Scope |
|--------|-------|
| Person 1 | V1 AMM baseline (`ImprovedAMM.sol`), project scaffold, Hardhat config |
| Person 2 | Math libraries (TickMath, FullMath, LiquidityAmounts, SwapMath, TickBitmap) + library unit tests |
| Person 3 | `Pool.sol` core logic + `PoolFactory.sol` + Pool integration tests |
| Person 4 | `PositionManager.sol` (ERC-721), `SwapRouter.sol`, `Quoter.sol` + full integration tests |
| Person 5 | React frontend, analytics dashboard, deployment scripts, documentation |

## Attribution

Math library constants (TickMath magic ratios, FullMath 512-bit algorithm) are ported from [Uniswap V3 Core](https://github.com/Uniswap/v3-core) (MIT License). All contract logic and architecture are independently implemented for this project.
