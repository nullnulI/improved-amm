# SC6107 Concentrated Liquidity AMM

**Option 5: Automated Market Maker with Novel Features** — SC6107 Blockchain Development Fundamentals

A production-grade Uniswap V3-style **concentrated liquidity AMM** built from scratch in Solidity 0.8.24, with a full React frontend, 84 passing tests (unit + integration + fuzz/invariant + gas), and novel features including a protocol fee mechanism, JIT detection, range orders, and TWAP-based dynamic fee recommendations.

---

## Novel Features

| Feature | Description |
|---|---|
| **Protocol Owned Liquidity (POL)** | Factory owner can set a per-pool fee denominator (e.g. 1/5 of swap fees). Fees accrue in `protocolFees` and are collected via `collectProtocol`. |
| **JIT Liquidity Detection** | Frontend detects just-in-time LP minting (position minted in same block as a swap) and warns the LP. |
| **Range Orders** | LPs can place single-sided positions above (sell limit) or below (buy limit) the current price — concentrated liquidity acting as passive limit orders. |
| **Dynamic Fee Recommendation** | Real-time TWAP divergence (5m vs 30m) classifies volatility and recommends the optimal fee tier for both swappers and LPs. |
| **Multi-hop Swaps (UI)** | Frontend supports two-pool multi-hop routing via `SwapRouter.exactInput()` with a path encoder. |
| **TWAP Oracle** | Per-pool observation ring buffer enables manipulation-resistant TWAPs at any granularity. |

---

## Quick Start

```bash
npm install
npm run compile
npm test          # 84 tests: unit + integration + fuzz + gas
```

Run locally:

```bash
# Terminal 1
npm run node

# Terminal 2
npm run deploy    # prints JSON addresses

# Terminal 3
npm run dev       # frontend at http://localhost:5173
```

Paste the printed JSON into the app's **Deployment** panel and click **Load**.

---

## Test Coverage

```
contracts/test/
  ImprovedAMM.test.js          — V1 AMM baseline tests (20)
  Pool.test.js                 — unit: initialize, mint, swap, burn, collect, oracle (21)
  integration/FullFlow.test.js — end-to-end: factory → LP → swap → fees → NFT transfer (10)
  libraries/TickMath.test.js   — TickMath unit tests (10)
  fuzz/Invariants.test.js      — property/invariant tests across 75+ sampled inputs (22)
  gas/GasReport.test.js        — gas measurement with upper bounds (11)
```

**84 tests — all passing.**

Invariants verified:
- TickMath round-trip: `getTickAtSqrtRatio(getSqrtRatioAtTick(t)) == t` for 75+ ticks
- Monotonicity: sqrtPrice strictly increases with tick
- Swap conservation: token balance changes exactly match reported deltas
- Fee invariant: collected fees ≤ accrued fees
- Liquidity invariant: pool liquidity ≥ 0 at all times
- Protocol fee: correctly accrued and collected; only factory owner can configure
- Boundary: all out-of-range inputs revert

---

## Architecture

```
contracts/src/
  libraries/
    TickMath.sol          tick ↔ sqrtPrice in Q64.96 format
    FullMath.sol          512-bit overflow-safe mulDiv
    SqrtPriceMath.sol     token deltas from sqrtPrice changes
    LiquidityAmounts.sol  liquidity ↔ token amounts for deposit/withdraw
    SwapMath.sol          single-step swap computation with fee
    TickBitmap.sol        packed bitmap for efficient next-tick lookup
    Tick.sol              per-tick fee growth tracking (feeGrowthOutside)
    Position.sol          per-position fee accumulation snapshots
    Oracle.sol            TWAP ring buffer (observation array)
    LiquidityMath.sol     uint128 delta arithmetic
    SafeCast.sol          safe integer narrowing
  core/
    Pool.sol              AMM engine: mint / burn / swap / collect / oracle / protocol fee
    PoolFactory.sol       pool registry + fee tier management + protocol fee control
    interfaces/           IPoolFactory, IPoolMintCallback, IPoolSwapCallback
  periphery/
    PositionManager.sol   ERC-721 LP position NFT: mint / increaseLiquidity / decreaseLiquidity / collect
    SwapRouter.sol        exactInputSingle / exactOutputSingle / exactInput (multi-hop)
    Quoter.sol            gas-free swap simulation via revert-and-catch
  MockERC20.sol           mintable ERC-20 for testing

frontend/src/
  hooks/
    useWallet.js          MetaMask connection + chain validation
    usePool.js            live pool state polling + event history
  components/
    SwapPanel.jsx         single-hop + multi-hop swaps; volatility-based fee rec.
    LiquidityPanel.jsx    range/sell-order/buy-order LP with tick preview
    PositionsPanel.jsx    position management; JIT detection; increase/decrease
    AnalyticsPanel.jsx    TWAP oracle; price+volume chart; depth chart; IL calculator; POL controls
  constants.js            ABIs, math helpers, fee tiers, IL formula
  App.jsx                 tab layout, pool bar, config panel, wallet balances
```

See [`docs/architecture.md`](docs/architecture.md) for the complete design document.

---

## Gas Performance

Key operations measured on local Hardhat network (optimizer: 200 runs, viaIR):

| Operation | Gas |
|---|---:|
| mint (first LP, wide range) | ~445,000 |
| exactInputSingle (small swap) | ~136,000 |
| exactInput (multi-hop, 2 pools) | ~201,000 |
| collect fees | ~99,000 |
| decreaseLiquidity (50%) | ~189,000 |

Full breakdown in [`docs/gas-optimization.md`](docs/gas-optimization.md).

---

## Security Highlights

- **Reentrancy guard**: `slot0.unlocked` flag used as mutex, reset after every external call
- **Checks-Effects-Interactions**: all state committed before token transfers
- **Callback authentication**: both mint and swap callbacks verify `msg.sender == expectedPool`
- **Custom errors**: cheaper than revert strings, explicit failure modes
- **Protocol fee validation**: denominator must be 0 or ≥ 4 to prevent excessive capture
- **Slippage protection**: `amount0Min`/`amount1Min` on mint; `amountOutMinimum` on swap

See [`docs/security-analysis.md`](docs/security-analysis.md) for the full analysis.

---

## Documentation

| Document | Contents |
|---|---|
| [architecture.md](docs/architecture.md) | System design, math, fee accounting, tick crossing, oracle |
| [security-analysis.md](docs/security-analysis.md) | Threat model, attack vectors, mitigations |
| [gas-optimization.md](docs/gas-optimization.md) | Optimization strategies and measured gas costs |
| [deployment-guide.md](docs/deployment-guide.md) | Step-by-step local and testnet deployment |
| [user-guide.md](docs/user-guide.md) | Complete walkthrough of all frontend features |

---

## Team Contributions

| Member | Scope |
|---|---|
| Person 1 | V1 AMM baseline (`ImprovedAMM.sol`), project scaffold, Hardhat config |
| Person 2 | Math libraries (TickMath, FullMath, LiquidityAmounts, SwapMath, TickBitmap) + library unit tests |
| Person 3 | `Pool.sol` core logic + `PoolFactory.sol` + pool unit tests |
| Person 4 | `PositionManager.sol` (ERC-721), `SwapRouter.sol`, `Quoter.sol` + integration tests |
| Person 5 | React frontend, fuzz/gas tests, protocol fee mechanism, documentation |

---

## Attribution

Math library constants (TickMath magic ratios, FullMath 512-bit algorithm) are ported from [Uniswap V3 Core](https://github.com/Uniswap/v3-core) (MIT License). All contract logic, architecture, novel features, and frontend are independently implemented for this project.
