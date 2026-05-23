# SC6107 Concentrated Liquidity AMM

**Option 5: Automated Market Maker with Novel Features** - SC6107 Blockchain Development Fundamentals

A full-featured educational Uniswap V3-style **concentrated liquidity AMM** built in Solidity 0.8.24, with a React frontend, Sepolia deployment, 173 passing tests, and project-level extensions including protocol fees, JIT liquidity protection, range-order UX, TWAP analytics, and dynamic fee recommendations.

---

## Sepolia Deployment

Latest recorded Sepolia deployment. If the contracts are redeployed, run the deployment script again and update this table before submission.

| Contract | Sepolia Address |
|---|---|
| `PoolFactory` | [`0x80fEbDCd94639Ff5F3D21B2E6F772bA782B97c74`](https://sepolia.etherscan.io/address/0x80fEbDCd94639Ff5F3D21B2E6F772bA782B97c74) |
| `PositionManager` | [`0x518b4D94840F1b44AEC53f9E4C5286fE59CA899c`](https://sepolia.etherscan.io/address/0x518b4D94840F1b44AEC53f9E4C5286fE59CA899c) |
| `SwapRouter` | [`0x6f7471B49BC51551d6D0AF6d4C19FaE949CA47Cb`](https://sepolia.etherscan.io/address/0x6f7471B49BC51551d6D0AF6d4C19FaE949CA47Cb) |
| `Quoter` | [`0x7e730073cFc13827F435ca2Eb220444497fBC267`](https://sepolia.etherscan.io/address/0x7e730073cFc13827F435ca2Eb220444497fBC267) |
| `DynamicFeeAdvisor` | [`0xF4372ac6BEf5D56B197E69Af69dd873d26C8De21`](https://sepolia.etherscan.io/address/0xF4372ac6BEf5D56B197E69Af69dd873d26C8De21) |
| `Token A` | [`0xEd53256bCC1447Bc5b0954DB14481B14a3016322`](https://sepolia.etherscan.io/address/0xEd53256bCC1447Bc5b0954DB14481B14a3016322) |
| `Token B` | [`0x9DC22e741752A67FACDC0c35D852846ab99bbA22`](https://sepolia.etherscan.io/address/0x9DC22e741752A67FACDC0c35D852846ab99bbA22) |
| `Pool` | [`0x94E1A4F63f9D2522900AAD444F80C2a433637d91`](https://sepolia.etherscan.io/address/0x94E1A4F63f9D2522900AAD444F80C2a433637d91) |

Frontend config JSON:

```json
{
  "FACTORY": "0x80fEbDCd94639Ff5F3D21B2E6F772bA782B97c74",
  "POSITION_MANAGER": "0x518b4D94840F1b44AEC53f9E4C5286fE59CA899c",
  "SWAP_ROUTER": "0x6f7471B49BC51551d6D0AF6d4C19FaE949CA47Cb",
  "QUOTER": "0x7e730073cFc13827F435ca2Eb220444497fBC267",
  "DYNAMIC_FEE_ADVISOR": "0xF4372ac6BEf5D56B197E69Af69dd873d26C8De21",
  "TOKEN_A": "0xEd53256bCC1447Bc5b0954DB14481B14a3016322",
  "TOKEN_B": "0x9DC22e741752A67FACDC0c35D852846ab99bbA22",
  "POOL": "0x94E1A4F63f9D2522900AAD444F80C2a433637d91"
}
```

---

## Novel Features

| Feature | Description |
|---|---|
| **JIT Liquidity Protection** | `PositionManager` records the latest liquidity-add block and prevents same-block fee collection. The frontend also warns when a position is minted in the same block as swap activity. |
| **Dynamic Fee Advisor** | `DynamicFeeAdvisor` compares 5-minute and 30-minute TWAPs to classify volatility and recommend the most suitable fee tier. This is a recommendation layer, not automatic fee mutation inside the pool. |
| **Protocol Fee / POL Controls** | Factory owner can set a bounded per-pool protocol fee denominator. Accrued protocol fees are tracked separately from LP fee growth and can be collected by the owner. |
| **Range Orders** | Single-sided concentrated liquidity positions above or below the current price behave like passive sell or buy limit orders. |
| **Multi-hop Swaps** | `SwapRouter.exactInput()` supports encoded multi-hop paths, and the frontend exposes a two-hop demo flow. |
| **EIP-2612 Permit + Multicall** | Users can sign a permit and execute swap or mint actions in one transaction, avoiding separate approval transactions. |
| **TWAP Oracle and Analytics** | Per-pool observations support TWAP reads, volatility signals, price/volume charts, liquidity depth views, and impermanent-loss calculation. |

---

## Quick Start

```bash
npm install
npm run compile
npm test          # 173 passing tests
npm run build
```

Run locally:

```bash
# Terminal 1
npm run node

# Terminal 2
npm run deploy    # deploys to local Hardhat and prints frontend JSON

# Terminal 3
npm run dev       # frontend at http://localhost:5173
```

Paste the printed JSON into the app's **Deployment** panel and click **Load**.

Deploy to Sepolia:

```bash
# Set these first in your shell or CI environment
SEPOLIA_RPC_URL=<your_rpc_url>
PRIVATE_KEY=<your_deployer_private_key>

npm run deploy:sepolia
```

---

## Test Coverage

Current verification result:

```text
173 passing
```

Test suites include:

```text
contracts/test/
  DynamicFeeAdvisor.test.js      - TWAP volatility reports and fee recommendation
  EdgeCases.test.js              - revert paths, oracle branches, JIT protection, quoter branches
  ImprovedAMM.test.js            - V1 AMM baseline and regression tests
  Permit.test.js                 - EIP-2612 permit and SelfPermit multicall flows
  Pool.test.js                   - initialize, mint, swap, burn, collect, TWAP
  PoolFactory.test.js            - fee tiers, pool creation, access control
  fuzz/Invariants.test.js        - property/invariant tests across sampled inputs
  gas/GasReport.test.js          - gas measurement with upper bounds
  gas/PermitGas.test.js          - permit batching vs classic approve flow
  integration/FullFlow.test.js   - factory -> LP -> swap -> fees -> NFT transfer
  libraries/*.test.js            - TickMath, LiquidityAmounts, SafeCast coverage
```

Invariants verified:

- TickMath round-trip and monotonicity
- Swap balance conservation and execution price sanity
- LP fee collection bounded by accrued fees
- Pool liquidity remains non-negative
- No-liquidity pools cannot be swapped through
- Protocol fee lifecycle and access control
- Boundary inputs revert for invalid ticks and wrong price limits

---

## Architecture

```text
contracts/src/
  libraries/
    TickMath.sol          tick -> sqrtPrice in Q64.96 format
    FullMath.sol          512-bit overflow-safe mulDiv
    SqrtPriceMath.sol     token deltas from sqrtPrice changes
    LiquidityAmounts.sol  liquidity <-> token amounts for deposit/withdraw
    SwapMath.sol          single-step swap computation with fee
    TickBitmap.sol        packed bitmap for efficient next-tick lookup
    Tick.sol              per-tick fee growth tracking
    Position.sol          per-position fee accumulation snapshots
    Oracle.sol            TWAP ring buffer
    LiquidityMath.sol     uint128 delta arithmetic
    SafeCast.sol          safe integer narrowing
  core/
    Pool.sol              AMM engine: mint / burn / swap / collect / oracle / protocol fee
    PoolFactory.sol       pool registry + fee tier management + protocol fee control
    interfaces/           IPoolFactory, IPoolMintCallback, IPoolSwapCallback
  periphery/
    PositionManager.sol   ERC-721 LP position NFT
    SwapRouter.sol        exactInputSingle / exactOutputSingle / exactInput
    Quoter.sol            gas-free swap simulation via revert-and-catch
    DynamicFeeAdvisor.sol TWAP-based volatility and fee recommendation
    base/                 SelfPermit helpers
  MockERC20.sol           mintable ERC-20 with EIP-2612 permit for test/demo use

frontend/src/
  hooks/
    useWallet.js          MetaMask connection + chain validation
    usePool.js            live pool state polling + event history
  components/
    SwapPanel.jsx         single-hop + multi-hop swaps; fee recommendation; permit swap
    LiquidityPanel.jsx    range/sell-order/buy-order LP with tick preview
    PositionsPanel.jsx    NFT position management; JIT warning; increase/decrease
    AnalyticsPanel.jsx    TWAP oracle; charts; depth; IL calculator; POL controls
  constants.js            ABIs, math helpers, fee tiers, permit helpers
  App.jsx                 tab layout, pool bar, config panel, wallet balances
```

See [`docs/architecture.md`](docs/architecture.md) for the complete design document.

---

## Gas Performance

Key operations measured on local Hardhat network with optimizer 200 runs and `viaIR`:

| Operation | Gas |
|---|---:|
| `createPool` | ~3,711,000 |
| `mint` wide range | ~467,000 |
| `exactInputSingle` small swap | ~136,000 |
| `exactInput` multi-hop, 2 pools | ~201,000 |
| `collect` fees | ~101,000 |
| `decreaseLiquidity` 50% | ~189,000 |

Permit batching also reduces user transaction overhead:

| Flow | Classic | Permit multicall | Saved |
|---|---:|---:|---:|
| Swap | ~180,000 gas across 2 tx | ~150,000 gas in 1 tx | ~31,000 |
| Mint | ~428,000 gas across 3 tx | ~387,000 gas in 1 tx | ~41,000 |

Full breakdown in [`docs/gas-optimization.md`](docs/gas-optimization.md).

---

## Security Highlights

- **Reentrancy guard**: `slot0.unlocked` is used as a packed mutex.
- **Checks-Effects-Interactions**: pool state is committed before external token callbacks.
- **Callback authentication**: mint and swap callbacks verify `msg.sender == factory.getPool(...)`.
- **Slippage protection**: mint uses `amount0Min` / `amount1Min`; swaps use `amountOutMinimum` and `sqrtPriceLimitX96`.
- **Deadline protection**: user-facing periphery functions reject stale transactions.
- **Numeric safety**: `FullMath`, `SafeCast`, Q64.96 price math, and disciplined rounding.
- **Protocol fee bounds**: denominator must be `0` or `>= 4`, capping protocol capture at 25% of swap fees.
- **Known limitations documented**: no full MEV elimination, no timelock, no audit, and demo tokens are not production tokens.

See [`docs/security-analysis.md`](docs/security-analysis.md) for the full analysis.

---

## Documentation

| Document | Contents |
|---|---|
| [architecture.md](docs/architecture.md) | System design, math, fee accounting, tick crossing, oracle |
| [security-analysis.md](docs/security-analysis.md) | Threat model, attack vectors, mitigations, limitations |
| [gas-optimization.md](docs/gas-optimization.md) | Optimization strategies and measured gas costs |
| [deployment-guide.md](docs/deployment-guide.md) | Local and Sepolia deployment instructions |
| [user-guide.md](docs/user-guide.md) | Complete walkthrough of frontend features |

---

## Repository Structure

```text
improved-amm/
├── README.md
├── contracts/
│   ├── src/
│   └── test/
├── frontend/
├── docs/
├── scripts/
├── hardhat.config.js
├── package.json
└── package-lock.json
```

Generated folders such as `artifacts/`, `cache/`, `dist/`, `node_modules/`, and `ppt_preview/` should not be submitted as source deliverables.

---

## Team Contributions

Replace the placeholder names with the final team member names or GitHub usernames before submission.

| Member | Scope |
|---|---|
| Person 1 | Core pool engine: `Pool.sol`, swap loop, mint/burn/collect, fee growth, reentrancy lock |
| Person 2 | Math libraries: `TickMath`, `FullMath`, `SqrtPriceMath`, `LiquidityAmounts`, `SwapMath`, `TickBitmap`, `SafeCast` |
| Person 3 | Periphery contracts: `PoolFactory`, `PositionManager`, ERC-721 LP positions, `SwapRouter`, `Quoter` |
| Person 4 | Novel features and security: JIT protection, `DynamicFeeAdvisor`, protocol fee/POL, security analysis |
| Person 5 | Frontend, testing, and deployment: React UI, MetaMask flow, unit/integration/fuzz/gas tests, Sepolia deployment |

---

## Attribution

Math library constants and selected arithmetic techniques are adapted from [Uniswap V3 Core](https://github.com/Uniswap/v3-core) under the MIT License, especially `TickMath` and `FullMath`. OpenZeppelin contracts are used for standard ERC-20, ERC-721, permit, ownership, and safety utilities. The AMM integration, periphery design, frontend, tests, documentation, and course-specific feature layer are implemented for this project.
