# Gas Optimization

## Optimization Strategies

### Compiler Settings

- Solidity optimizer enabled with **200 runs**.
- `viaIR: true` enables the IR-based optimizer pipeline and cross-function inlining.
- `evmVersion: cancun` targets the current EVM feature set used by Hardhat.

### Storage Design

- `Slot0` packs `uint160 sqrtPriceX96`, `int24 tick`, three `uint16` oracle fields, and the reentrancy flag into one 256-bit word.
- `ProtocolFees` packs two `uint128` balances into one storage slot.
- `Position.Info` stores fee-growth snapshots instead of duplicating absolute fee history.
- Custom errors are used on the main pool paths to reduce revert cost and make failure modes explicit.

### Arithmetic

- `FullMath.mulDiv` performs 512-bit intermediate arithmetic to avoid phantom overflow in fee, swap, and liquidity calculations.
- `FullMath.mulDivRoundingUp` is used where rounding direction matters for pool safety.
- `unchecked {}` blocks are used only where overflow is bounded by protocol invariants.
- `SafeCast` centralizes downcast checks at library boundaries.

### Tick and Swap Efficiency

- `TickBitmap` stores initialized ticks in packed 256-bit words, avoiding linear scans across empty ticks.
- Swap execution advances from initialized tick to initialized tick instead of iterating over every possible price point.
- The pool uses a callback-based token-pull pattern, so it only checks balances around mint/swap callbacks instead of performing redundant transfers.

---

## Measured Gas Costs

Results captured by `contracts/test/gas/GasReport.test.js` on the local Hardhat network:

| Operation | Gas Used | Upper Bound |
|---|---:|---:|
| `createPool` | 3,711,067 | 4,500,000 |
| `initialize` | 70,254 | 120,000 |
| `mint` wide range | 467,417 | 600,000 |
| `mint` narrow range | 381,468 | 600,000 |
| `exactInputSingle` 1 token | 135,718 | 200,000 |
| `exactInputSingle` 500 tokens | 112,227 | 400,000 |
| `exactOutputSingle` | 104,558 | 250,000 |
| `increaseLiquidity` | 249,047 | 350,000 |
| `decreaseLiquidity` 50% | 189,378 | 300,000 |
| `collect` fees | 100,990 | 250,000 |
| `exactInput` multi-hop, 2 pools | 201,226 | 500,000 |

Total gas across all 11 benchmarked operations: **5,723,350**.

These figures vary with state, especially tick crossings, storage warmth, active liquidity, and oracle writes.

---

## Permit + Multicall Savings

`SwapRouter` and `PositionManager` inherit `Multicall` and `SelfPermit`, allowing an EIP-2612 permit signature and the target action to execute in a single transaction.

Measured by `contracts/test/gas/PermitGas.test.js`:

| Flow | Classic | Permit Multicall | Saved |
|---|---:|---:|---:|
| Swap: `approve` + `exactInputSingle` | 180,256 gas across 2 tx | 149,535 gas in 1 tx | 30,721 gas |
| Mint: `approve` x2 + `mint` | 428,109 gas across 3 tx | 386,848 gas in 1 tx | 41,261 gas |

The saving comes from removing standalone approval transactions. Permit verification has its own cost, but it still improves both gas and UX by reducing wallet confirmations and avoiding lingering broad allowances.

---

## Trade-offs

| Choice | Benefit | Cost |
|---|---|---|
| `viaIR: true` | Strong optimizer and better inlining | Longer compile time |
| Full pool deployment per pair | No proxy overhead and simpler audit surface | Higher `createPool` cost |
| Reentrancy flag in `Slot0` | Saves a dedicated storage slot | Less familiar than OpenZeppelin `ReentrancyGuard` |
| Tick bitmap search | Efficient next-tick lookup | More complex implementation |
| Callback token pulls | Matches V3-style periphery and avoids unnecessary transfers | Requires callback authentication |

---

## Further Opportunities

- Pack `protocolFee` into `Slot0` to save one `SLOAD` per swap when protocol fees are active.
- Warm up oracle cardinality at deployment for pools expected to serve long-window TWAPs.
- Convert remaining revert strings to custom errors.
- Add deeper gas snapshots for Sepolia transactions, not only local Hardhat execution.
