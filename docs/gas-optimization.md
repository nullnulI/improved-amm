# Gas Optimization

## Optimization Strategies

### Compiler Settings
- Solidity optimizer enabled with **200 runs** (balances deployment vs call cost)
- `viaIR: true` for the IR-based optimizer pipeline, enabling cross-function inlining
- `evmVersion: cancun` targets PUSH0 and transient-storage opcodes

### Storage Design
- `Slot0` struct is packed into **one 256-bit storage word**: `uint160 sqrtPriceX96 + int24 tick + uint16 × 3 + bool = 256 bits`
- `ProtocolFees` packs two `uint128` values into one slot
- `Position.Info` stores only the delta snapshot, not absolute values — fee claims use subtraction
- Custom errors (`error Locked()`, `error ZeroLiquidity()`, …) replace revert strings, saving ~50 gas per revert

### Reentrancy Guard
- Uses a storage flag in `slot0.unlocked` rather than a separate `uint256` slot — the flag read/write is part of the already-loaded `slot0` word

### Arithmetic
- `FullMath.mulDiv` uses 512-bit intermediate arithmetic to avoid phantom overflow while remaining gas-efficient
- `unchecked {}` blocks are applied where overflow is provably impossible (fee growth accumulation, tick arithmetic)
- `SafeCast` eliminates redundant bounds checks by performing them once at the boundary

### Token Transfers
- `SafeERC20` used throughout — consistent with production standards and avoids silent transfer failures
- Callbacks (mint, swap) follow **Checks-Effects-Interactions**: state committed before token transfer
- No unnecessary ERC20 `balanceOf` calls — the callback pattern guarantees token delivery

---

## Measured Gas Costs (Hardhat local network, optimizer 200 runs, viaIR)

Results captured by `contracts/test/gas/GasReport.test.js` on the local Hardhat network:

| Operation | Gas Used | Notes |
|---|---:|---|
| `createPool` | ~3,696,230 | Deploys full Pool contract with all libraries |
| `initialize` | ~70,254 | Sets sqrtPriceX96, writes first oracle observation |
| `mint` (wide, ±12000 ticks) | ~445,108 | First mint to two fresh ticks |
| `mint` (narrow, ±60 ticks) | ~359,159 | Concentrated position, lower tickBitmap writes |
| `exactInputSingle` (1 token) | ~135,575 | In-range single-step swap |
| `exactInputSingle` (500 tokens) | ~112,084 | Price moves within active range; fewer SSTORE than expected because tick is not crossed |
| `exactOutputSingle` | ~104,371 | Exact-output single hop |
| `increaseLiquidity` | ~243,844 | Adds to existing position (no tick flip) |
| `decreaseLiquidity` (50%) | ~189,421 | Partial burn, no tick clear |
| `collect` (fees) | ~98,704 | Triggers burn(0) sync then transfers |
| `exactInput` (multi-hop, 2 pools) | ~200,813 | Token0 → Token1 → TokenC through two pools |

Total gas across all 11 benchmarked operations: **~5,655,593**

> All measurements are approximate and vary with specific state (tick crossings, storage warmth, EVM version). On a public testnet or mainnet, expect comparable figures.

---

## Batch Operations: EIP-2612 Permit + Multicall

`SwapRouter` and `PositionManager` inherit `Multicall` + `SelfPermit`, so an off-chain
EIP-2612 signature and the on-chain action execute in **one transaction** instead of a
separate `approve` transaction followed by the action. Measured by
`contracts/test/gas/PermitGas.test.js`:

| Flow | Classic (separate approve) | Permit multicall | Saved |
|---|---:|---:|---:|
| Swap: `approve` + `exactInputSingle` | 180,244 (2 tx) | 149,535 (1 tx) | **30,709 (~17%)** |
| Mint: `approve` ×2 + `mint` | 405,911 (3 tx) | 364,606 (1 tx) | **41,305 (~10%)** |

The saving comes from eliminating each standalone `approve` transaction's ~21,000-gas
intrinsic cost (plus its calldata), partially offset by the permit's `ecrecover` and
nonce SSTORE. The mint figures use pre-initialized ticks so the comparison isolates the
batching effect rather than one-time tick-initialization cost.

Beyond raw gas, batching gives a single wallet confirmation and an atomic
approve-and-act (the allowance never lingers between transactions). The frontend exposes
this via an **EIP-2612 permit** toggle on the Swap panel; the classic fallback path now
approves the **exact** amount instead of an over-approval.

---

## Key Trade-offs

| Choice | Pro | Con |
|---|---|---|
| `viaIR: true` | Best optimizer; enables cross-function inlining | Longer compile time |
| `createPool` deploys full Pool | No proxy overhead; full bytecode visible for auditing | High deployment cost |
| Custom reentrancy in `slot0` | Saves one storage slot | Less explicit than OpenZeppelin's `ReentrancyGuard` |
| Tick bitmap search | O(1) amortised next-tick lookup | Complex; bugs would be expensive |
| Callback pattern for token pulls | No pre-approval needed from pool | Requires callers to implement callbacks |

---

## Further Opportunities

- **Packing `protocolFee` into `Slot0`** would save one SLOAD per swap when the protocol fee is active
- ~~**Multicall** on the PositionManager would let LPs mint + increase in one tx~~ — **implemented** via `Multicall` + `SelfPermit` (see *Batch Operations* above)
- **TWAP cardinality warm-up** (calling `increaseObservationCardinalityNext` at deployment) saves gas on the first oracle write
