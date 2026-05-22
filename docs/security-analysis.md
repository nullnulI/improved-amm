# Security Analysis

This document covers the security model of the **V3 concentrated liquidity stack** (`Pool` + `PoolFactory` + `PositionManager` + `SwapRouter` + `Quoter` and the eleven math libraries under `contracts/src/libraries/`). The legacy `ImprovedAMM.sol` is a V2-style baseline kept only for regression tests and is **not** part of the security perimeter described here (see §13).

Every claim below is anchored to a specific `file.sol:line` so reviewers can verify it directly.

---

## 1. Threat Model & Trust Assumptions

### Assets at risk

| Asset | Where it lives | Worst-case loss |
|---|---|---|
| Pool token0 / token1 reserves | `Pool` contract balance | drained by malicious mint/swap/burn |
| LP position state | `positions[bytes32]` mapping in `Pool` + ERC-721 token in `PositionManager` | stolen position liquidity or fees |
| Accumulated swap fees (LP) | `feeGrowthGlobal0X128 / feeGrowthGlobal1X128` + per-tick `feeGrowthOutside` | LP fee dilution or theft |
| Protocol fees | `protocolFees.token0 / token1` in each `Pool` | unauthorised redirection |
| TWAP integrity | `observations[65535]` ring buffer | external consumers fed manipulated price |

### Trust tiers

| Principal | Trust level | Capabilities |
|---|---|---|
| Arbitrary EOA / contract | Untrusted | call `mint / burn / swap / collect / initialize / observe` |
| Implementer of `IPoolMintCallback` / `IPoolSwapCallback` | Untrusted, but identity-verified at call site | receive token-pull callbacks during `mint` / `swap` |
| `PoolFactory.owner` (deployer key) | Partially trusted | enable fee tiers, set per-pool protocol fee, collect protocol fees |
| Deployed `Pool` instance | Trusted relative to its own state | enforces the invariants below |

The factory owner is **the only privileged on-chain role**. It can change the protocol fee denominator (within bounds — see §7) and collect protocol-owned fees. It **cannot** alter pool reserves, LP positions, fee tiers retroactively, or the math libraries.

### Out of scope

- Off-chain key management of the factory owner
- Compiler / EVM bugs
- Front-end XSS / wallet phishing
- Tokens that deviate from ERC-20 (rebasing, fee-on-transfer, callback-on-transfer) — explicitly unsupported, see §13

---

## 2. Reentrancy Protection

**Mechanism.** Every state-mutating external function on `Pool` is gated by a `lock` modifier that reads and writes a single bit packed into `Slot0`:

```solidity
// contracts/src/core/Pool.sol:44-52
struct Slot0 {
    uint160 sqrtPriceX96;
    int24   tick;
    uint16  observationIndex;
    uint16  observationCardinality;
    uint16  observationCardinalityNext;
    bool    unlocked;   // ← reentrancy flag, lives in the same 256-bit word
}

// contracts/src/core/Pool.sol:99-104
modifier lock() {
    if (!slot0.unlocked) revert Locked();
    slot0.unlocked = false;
    _;
    slot0.unlocked = true;
}
```

**Coverage.** `mint`, `burn`, `swap`, `collect`, and `increaseObservationCardinalityNext` all carry `lock` ([Pool.sol:155, 194, 229, 255, 431](../contracts/src/core/Pool.sol)). Cross-function reentrancy through any of these paths is therefore impossible while a call is in-flight.

**Why pack into Slot0.** Reusing the last byte of an already-loaded storage word means the lock incurs zero extra `SLOAD`/`SSTORE` beyond the slot0 reads the swap already performs. OpenZeppelin's `ReentrancyGuard` would cost an additional dedicated slot.

**`initialize` is intentionally unguarded.** Before `initialize`, `slot0.unlocked == false` (default zero). Adding `lock` would make the first call revert with `Locked()`. Instead, `initialize` uses a dedicated `AlreadyInitialized` check ([Pool.sol:125](../contracts/src/core/Pool.sol)) and sets `unlocked = true` as part of its first write.

**Residual risk.** A token implementing ERC-777-style transfer callbacks could attempt re-entry during the `safeTransfer` calls in `collect` or `swap`. The CEI ordering (§4) ensures all relevant state is already committed when the transfer fires, so even a successful re-entry into a different `Pool` instance cannot read inconsistent state for *this* pool. Re-entry into the *same* pool is blocked by `lock`.

---

## 3. Callback Authentication

**Threat.** `PositionManager.uniswapV3MintCallback` and `SwapRouter.uniswapV3SwapCallback` pull tokens via `safeTransferFrom(payer, msg.sender, amount)`. If an attacker could call these callbacks directly, they could steal any tokens the user has approved to the periphery contract.

**Mechanism.** Every callback resolves the expected pool address from the factory registry and rejects any other caller:

```solidity
// contracts/src/periphery/PositionManager.sol:117-119
address expectedPool = factory.getPool(decoded.token0, decoded.token1, decoded.fee);
require(msg.sender == expectedPool, "UNAUTHORIZED_POOL");
```

`SwapRouter.uniswapV3SwapCallback` does the same at [SwapRouter.sol:78-80](../contracts/src/periphery/SwapRouter.sol).

**`Quoter` needs no auth.** Its callback always reverts unconditionally ([Quoter.sol:22-37](../contracts/src/periphery/Quoter.sol)), so even if invoked by a non-pool, no state changes and no token movements occur.

**Attack scenarios and where they break:**

| Attempt | Where it dies | Result |
|---|---|---|
| Call `PM.uniswapV3MintCallback(huge, huge, encodedData)` directly | `msg.sender ≠ expectedPool` | revert `"UNAUTHORIZED_POOL"` |
| Deploy a fake pool that mimics the interface and triggers PM | `factory.getPool(...)` returns only factory-deployed pools | expected pool address mismatches `msg.sender`, revert |
| Inside a legitimate callback, re-enter `Pool.swap` on the same pool | `Pool.lock` modifier | revert `Locked()` |
| Encode bogus `(token0, token1, fee)` in callback data to fool the auth check | `factory.getPool` returns `address(0)` for unknown tuples; `address(0) ≠ msg.sender` | revert |

**Residual risk.** Trust is fully delegated to `PoolFactory.getPool`. The factory is non-upgradeable in this implementation; its mapping is append-only via `createPool` ([PoolFactory.sol:56-73](../contracts/src/core/PoolFactory.sol)), so a compromised owner cannot inject a fake pool record. Owner cannot overwrite an existing `getPool[t0][t1][fee]` because of the `require(getPool[...] == address(0), "POOL_EXISTS")` guard ([PoolFactory.sol:66](../contracts/src/core/PoolFactory.sol)).

---

## 4. Checks-Effects-Interactions Ordering

Every external function commits *all* state changes before any external interaction. Below is the explicit sequence for the three critical paths.

### `Pool.mint` ([Pool.sol:149-179](../contracts/src/core/Pool.sol))

```
1. CHECKS
   - slot0.sqrtPriceX96 != 0           (NotInitialized)
   - amount > 0                        (ZeroLiquidity)
   - _checkTicks(tickLower, tickUpper) (InvalidTickRange)
2. EFFECTS
   - _modifyPosition() writes ticks, tickBitmap, positions, liquidity, observations
3. INTERACTIONS
   - read balance0Before / balance1Before
   - call IPoolMintCallback.uniswapV3MintCallback(amount0, amount1, data)
   - require balance0After ≥ balance0Before + amount0     (InsufficientToken0)
   - require balance1After ≥ balance1Before + amount1     (InsufficientToken1)
4. EMIT Mint
```

Even if the callback re-enters the pool through some other entry point, `lock` blocks it. If the callback returns without transferring enough tokens, the balance check reverts the *entire* transaction including the state changes from step 2.

### `Pool.swap` ([Pool.sol:249-390](../contracts/src/core/Pool.sol))

```
1. CHECKS
   - slot0.sqrtPriceX96 != 0
   - amountSpecified != 0
   - sqrtPriceLimitX96 in correct direction & within (MIN, MAX)
2. EFFECTS (inside the tick loop)
   - per-step: update state.sqrtPriceX96 / amountIn / amountOut / feeAmount
   - per-step: route protocol fee, update feeGrowthGlobal
   - per-step: on tick cross, ticks.cross() + liquidity delta
3. COMMIT (after the loop)
   - write slot0, liquidity, feeGrowthGlobal0/1X128, observations
4. INTERACTIONS
   - safeTransfer output token to recipient
   - call IPoolSwapCallback.uniswapV3SwapCallback(amount0, amount1, data)
   - require pool balance increased by ≥ amountIn   (line 381 / 386)
5. EMIT Swap
```

Sending the output before the callback is the standard V3 pattern that enables flash swaps. Safety holds because the post-callback balance check enforces full repayment — the pool's own balance is the authoritative ledger.

### `Pool.collect` ([Pool.sol:223-236](../contracts/src/core/Pool.sol))

```
1. EFFECTS
   - position.tokensOwed0/1 -= amount   (BEFORE transfer)
2. INTERACTIONS
   - safeTransfer to recipient
3. EMIT Collect
```

`collect` has no business-level checks (any caller may collect from their own position; positions with zero `tokensOwed` simply transfer zero). Decrementing `tokensOwed` before the transfer means a reentrant call would see the already-reduced balance.

---

## 5. Custom Errors & Failure Modes

`Pool` declares 9 custom errors ([Pool.sol:88-97](../contracts/src/core/Pool.sol)):

| Error | Thrown by | Trigger |
|---|---|---|
| `Locked()` | `lock` modifier | concurrent reentry |
| `NotInitialized()` | `mint`, `swap` | `slot0.sqrtPriceX96 == 0` |
| `AlreadyInitialized()` | `initialize` | re-initialisation attempt |
| `InvalidTickRange()` | `_checkTicks` | `tickLower >= tickUpper` or out-of-range |
| `ZeroLiquidity()` | `mint` | `amount == 0` |
| `InsufficientToken0()` | `mint` post-callback | callback failed to deliver token0 |
| `InsufficientToken1()` | `mint` post-callback | callback failed to deliver token1 |
| `PriceLimitOutOfBounds()` | `swap` | `sqrtPriceLimitX96` outside `(MIN, MAX)` or wrong side of current price |
| `PriceLimitWrongDirection()` | reserved | (declared, unused — kept for forward compatibility) |

**Why custom errors.** They save ~50 gas per revert vs. revert strings and produce a deterministic 4-byte selector that the front end can identify. The front end's `SwapPanel.jsx` / `LiquidityPanel.jsx` already use `e.shortMessage || e.reason || e.message` to surface the most readable form.

**Style inconsistency to clean up.** `setProtocolFee` and `collectProtocol` still use revert strings (`"NOT_FACTORY_OWNER"`, `"INVALID_PROTOCOL_FEE"`, [Pool.sol:399-403, 417-420](../contracts/src/core/Pool.sol)). Functionally identical; cosmetic debt to repay in a future patch.

---

## 6. Numeric Safety

| Risk | Mitigation | Where |
|---|---|---|
| `a * b` overflow inside fee/liquidity math | `FullMath.mulDiv` with 512-bit intermediate | [FullMath.sol:8-45](../contracts/src/libraries/FullMath.sol) |
| `a * b / d` rounding bias | `FullMath.mulDivRoundingUp` for LP-favorable direction | [FullMath.sol:48-54](../contracts/src/libraries/FullMath.sol) |
| Integer truncation on downcasts | `SafeCast.toInt128 / toUint128 / toUint160 / toInt256` | [SafeCast.sol](../contracts/src/libraries/SafeCast.sol) |
| Default overflow on `+ - *` | Solidity 0.8.24 checked arithmetic | [hardhat.config.js:5](../hardhat.config.js) |
| Wraparound semantics needed (ring arithmetic) | Explicit `unchecked {}` blocks | [Pool.sol:301-310, 324-326, 339-341](../contracts/src/core/Pool.sol) (swap loop), [Oracle.sol:42-52](../contracts/src/libraries/Oracle.sol) (timestamp deltas) |
| Tick ↔ sqrtPrice precision loss | Q64.96 fixed-point; round-trip identity verified | [TickMath.sol](../contracts/src/libraries/TickMath.sol); Invariants I1 ([Invariants.test.js:88-99](../contracts/test/fuzz/Invariants.test.js)) |
| Liquidity per tick overflow | Hard cap `uint128.max / numTicks` | [Tick.sol:20-25](../contracts/src/libraries/Tick.sol) |

**Rounding discipline.** Every place where amounts are computed from a price delta picks the direction that favours the pool / disadvantages the caller:

- `getAmount0Delta(..., roundUp=true)` when LP must *deposit*; `roundUp=false` when LP is *withdrawing* ([SqrtPriceMath.sol:14-40](../contracts/src/libraries/SqrtPriceMath.sol))
- Same pattern inside `SwapMath.computeSwapStep` ([SwapMath.sol:34-89](../contracts/src/libraries/SwapMath.sol))
- Net effect: any sub-wei dust stays in the pool, never leaks to an attacker

---

## 7. Protocol Fee (POL) Safety

**Mechanism.** Each `Pool` stores an optional `uint8 protocolFee` denominator. During each swap step, the LP-bound fee is split:

```solidity
// contracts/src/core/Pool.sol:312-322
uint256 lpFeeAmount = step.feeAmount;
if (protocolFee > 0) {
    uint256 protocolDelta = lpFeeAmount / protocolFee;
    if (zeroForOne) {
        unchecked { protocolFees.token0 += uint128(protocolDelta); }
    } else {
        unchecked { protocolFees.token1 += uint128(protocolDelta); }
    }
    lpFeeAmount -= protocolDelta;
}
```

The remainder flows into `feeGrowthGlobal`, so LP fee tracking is unaffected by protocol fee configuration.

**Bounds and access control:**

```solidity
// contracts/src/core/Pool.sol:398-406
function setProtocolFee(uint8 _protocolFee) external {
    require(
        msg.sender == factory || msg.sender == IPoolFactory(factory).owner(),
        "NOT_FACTORY_OWNER"
    );
    require(_protocolFee == 0 || _protocolFee >= 4, "INVALID_PROTOCOL_FEE");
    protocolFee = _protocolFee;
    emit SetProtocolFee(_protocolFee);
}
```

- `denominator == 0` → disabled (default)
- `denominator >= 4` → enabled, protocol captures `1/N` of each swap fee, capped at 25%
- `denominator ∈ {1, 2, 3}` → reverts (would let the protocol take 33–100% of LP fees)

`collectProtocol` is gated by the same dual-path access check ([Pool.sol:417-420](../contracts/src/core/Pool.sol)).

**Test coverage.** Invariants I6 verifies the full lifecycle (non-owner rejection, accrual on enable, owner-only collection, zero-out after collect, no accrual when disabled) at [Invariants.test.js:286-342](../contracts/test/fuzz/Invariants.test.js).

**Residual risk.** The factory owner is a single EOA in the current deployment script ([deploy.js:9](../scripts/deploy.js)). A compromised owner key can:
1. Set protocol fee to its maximum (25%) immediately — bounded, but still a value transfer from LPs
2. Drain accumulated `protocolFees` to any address

This is acceptable for a course MVP. For production: multisig + 24-hour timelock on `setPoolProtocolFee` and `collectPoolProtocol` (see §14).

---

## 8. TWAP Oracle & Manipulation Analysis

The TWAP is the most security-relevant external surface, because external consumers (lending markets, derivatives, other AMMs) may build on it.

### 8.1 How it works

The pool stores up to 65535 observations in a ring buffer ([Oracle.sol:6-11](../contracts/src/libraries/Oracle.sol)):

```solidity
struct Observation {
    uint32  blockTimestamp;
    int56   tickCumulative;                       // Σ tick × Δt
    uint160 secondsPerLiquidityCumulativeX128;    // Σ Δt / liquidity
    bool    initialized;
}
```

Observations are written at most once per block. The trigger sites are:
- During `swap`, if the tick changed ([Pool.sol:347-356](../contracts/src/core/Pool.sol))
- During `_modifyPosition`, if the current price is inside the position's range ([Pool.sol:528-535](../contracts/src/core/Pool.sol))

`observe(secondsAgos[])` reads from the ring buffer using a binary search ([Oracle.sol:89-109](../contracts/src/libraries/Oracle.sol)) and linearly interpolates between the two surrounding observations ([Oracle.sol:178-193](../contracts/src/libraries/Oracle.sol)).

### 8.2 Why geometric, not arithmetic, mean

`tickCumulative` integrates the tick value over time. Tick is defined as `log_1.0001(price)`, so:

```
arithmeticMeanTick = (tickCumulative[t1] - tickCumulative[t0]) / (t1 - t0)
geometricMeanPrice = 1.0001^arithmeticMeanTick
```

The result is the **time-weighted geometric mean** of price. This is the manipulation-resistant choice: a flash spike to 10× the spot price contributes only `log_1.0001(10) ≈ 23,000` ticks of cumulative impulse — diluted across the entire observation window.

### 8.3 Manipulation cost (informal model)

To shift an `n`-block TWAP by `Δ` price units, an attacker must hold the pool's instantaneous price at the target value for ~`n` blocks. Cost per block:

```
cost/block ≈ price_impact_to_move_×_swap_size + n × gas + n × opportunity_cost_of_capital
```

For a pool with active liquidity `L` and a target shift of `+x%`:

| Target TWAP shift | Window | Min blocks held (12s/block) | Approx. capital locked |
|---|---|---:|---|
| +1% | 5 min | 25 | `L × 1% × 25 blocks` (price-impact slippage to move spot, multiplied by hold time) |
| +5% | 5 min | 25 | `L × 5% × 25 blocks` |
| +1% | 30 min | 150 | `L × 1% × 150 blocks` |
| +5% | 30 min | 150 | `L × 5% × 150 blocks` |

These are first-order estimates; the actual cost is higher because each block the attacker pays the bid/ask spread to an arbitrageur trying to revert the price.

**Implication for consumers.** A 5-minute window is acceptable for UI display but inadequate for collateral pricing on a pool with `L < $100k`. A 30-minute window is generally sufficient for mid-cap pools; high-value protocols should request 24-hour TWAPs and grow the observation cardinality up front via `increaseObservationCardinalityNext` ([Pool.sol:431-437](../contracts/src/core/Pool.sol)).

### 8.4 Known oracle limitations

- **Cold start.** A freshly initialised pool has `cardinality == 1`. The first TWAP read with `secondsAgo > 0` will revert with `"OLD"` ([Oracle.sol:130](../contracts/src/libraries/Oracle.sol)). The front end's `usePool.js:41-48` handles this by wrapping the read in `try / catch` and falling back to "no history".
- **Stale pools.** In a pool with no activity for an extended period, the most recent observation can become arbitrarily old. The next read interpolates from that stale point — which mathematically represents *the price during the inactive period*, not a current value. This is the correct semantic, but consumers must be aware.
- **32-bit timestamp wraparound.** `blockTimestamp` is `uint32`, wrapping in 2106. `Oracle.transform` uses `unchecked { uint32 delta = blockTimestamp - last.blockTimestamp; }` ([Oracle.sol:42-52](../contracts/src/libraries/Oracle.sol)) which handles the wrap correctly. Callers passing `secondsAgo` larger than `2^32` are not protected — but no realistic window approaches that.
- **`liquidity == 0` divisor handling.** When active liquidity is zero, `secondsPerLiquidityCumulativeX128` would divide by zero. The code substitutes 1 to avoid the revert ([Oracle.sol:48](../contracts/src/libraries/Oracle.sol)). Consumers of `secondsPerLiquidity` should account for periods with no active liquidity.

### 8.5 Recommended consumer rules

- Prefer **TWAP over spot** (`slot0.sqrtPriceX96`) for any decision worth more than the swap fee.
- Use **≥30 min** windows for value-at-risk decisions; 5 min is for UI hints only.
- Reject reads from pools where the oldest observation is younger than your window (i.e. pool too new).
- Grow the cardinality at pool deployment to enable longer windows later.

---

## 9. Slippage, Deadline, and Price-Limit Protection

Every user-facing entry point accepts slippage and freshness bounds.

| Entry point | Slippage parameters | Deadline | Reference |
|---|---|---|---|
| `PositionManager.mint` | `amount0Min`, `amount1Min` | yes | [PositionManager.sol:49-61, 166](../contracts/src/periphery/PositionManager.sol) |
| `PositionManager.increaseLiquidity` | `amount0Min`, `amount1Min` | yes | [PositionManager.sol:63-70, 220](../contracts/src/periphery/PositionManager.sol) |
| `PositionManager.decreaseLiquidity` | `amount0Min`, `amount1Min` | yes | [PositionManager.sol:72-78, 244](../contracts/src/periphery/PositionManager.sol) |
| `SwapRouter.exactInputSingle` | `amountOutMinimum`, `sqrtPriceLimitX96` | yes | [SwapRouter.sol:26-35, 117](../contracts/src/periphery/SwapRouter.sol) |
| `SwapRouter.exactOutputSingle` | `amountInMaximum`, `sqrtPriceLimitX96` | yes | [SwapRouter.sol:37-46, 143](../contracts/src/periphery/SwapRouter.sol) |
| `SwapRouter.exactInput` (multi-hop) | `amountOutMinimum` per route | yes | [SwapRouter.sol:48-54, 180](../contracts/src/periphery/SwapRouter.sol) |

**Two-layer swap protection.** `amountOutMinimum` is the router-level check; `sqrtPriceLimitX96` is the pool-level check. Even if the front end miscomputes `amountOutMinimum`, the pool will stop trading the moment the price crosses the requested limit ([Pool.sol:277, 292](../contracts/src/core/Pool.sol)). This matters for multi-block sandwiches where the attacker can manipulate `block.timestamp` near `deadline`.

**Deadline semantics.** Modifiers `checkDeadline(uint256)` ([PositionManager.sol:98-101](../contracts/src/periphery/PositionManager.sol), [SwapRouter.sol:65-68](../contracts/src/periphery/SwapRouter.sol)) reject any transaction included after `block.timestamp > deadline`. Front end default: `now + 3600s` ([constants.js:41-43](../frontend/src/constants.js)). Tight deadlines materially reduce sandwich-attack reorg windows.

---

## 10. MEV / Sandwich Considerations

### What is implemented

- Per-swap slippage bound (`amountOutMinimum`, `sqrtPriceLimitX96`) — best defence available against an attacker who must complete a sandwich within the user's tolerance
- Deadlines on every entry point
- TWAP availability so external protocols depending on this pool's price are insulated from short-lived manipulation (§8)

### What is **not** implemented

- No commit-reveal swap flow
- No private mempool / Flashbots-only RPC
- No batch auction (FBA) or frequent-batch settlement
- No on-chain JIT-LP fee redirection
- No on-chain dynamic fee adjustment (the dynamic-fee logic in `SwapPanel.jsx:170-176` is a *UI recommendation* only)

### Realistic sandwich analysis

For an attacker to profit from a sandwich:

```
attacker_profit ≈ victim_slippage_used − 2 × (swap_fee + gas_round_trip)
```

If the victim sets slippage to 0.1% on a 0.30% fee tier, the round-trip fee alone (0.60%) exceeds the available slippage and the attack is unprofitable. At 1.0% slippage the attack becomes profitable for large trades. The front-end default of 0.5% ([constants.js:81-85](../frontend/src/constants.js)) sits at the edge.

**Honest disclosure.** Robust MEV defence is a protocol-level concern. Implementing commit-reveal in a single pool adds significant UX friction (two transactions) and gas cost without solving the broader problem. This project chooses transparent disclosure over partial defence.

### JIT liquidity

The front-end `PositionsPanel.jsx:73-90` detects positions minted in the same block as a swap and surfaces a warning, but there is **no on-chain enforcement**. A complete JIT defence would require:

1. Recording `mintBlock` on each position
2. On burn, if `block.number - mintBlock < N`, redirect the position's earned `feeGrowthInside` to a shared LP pool

This is in the future-hardening list (§14).

---

## 11. Boundary & Input Validation

| Validation | Location | Failure mode |
|---|---|---|
| `tickLower < tickUpper` | `_checkTicks` | `InvalidTickRange` |
| `tickLower ≥ MIN_TICK`, `tickUpper ≤ MAX_TICK` | `_checkTicks` ([Pool.sol:590-594](../contracts/src/core/Pool.sol)) | `InvalidTickRange` |
| Tick alignment to `tickSpacing` | `TickBitmap.flipTick` ([TickBitmap.sol:18](../contracts/src/libraries/TickBitmap.sol)) | revert |
| `sqrtPriceLimitX96` within `(MIN_SQRT_RATIO, MAX_SQRT_RATIO)` and on correct side of current price | `Pool.swap` ([Pool.sol:260-266](../contracts/src/core/Pool.sol)) | `PriceLimitOutOfBounds` |
| `amount > 0` on mint | `Pool.mint` line 157 | `ZeroLiquidity` |
| `amountSpecified ≠ 0` on swap | `Pool.swap` line 257 | bare `require` |
| `liquidityGross ≤ maxLiquidityPerTick` | `Tick.update` ([Tick.sol:83](../contracts/src/libraries/Tick.sol)) | revert |
| Token pair non-zero, non-identical | `PoolFactory.createPool` ([PoolFactory.sol:61-62, 65](../contracts/src/core/PoolFactory.sol)) | revert |
| Fee tier registered | `PoolFactory.createPool` ([PoolFactory.sol:64-65](../contracts/src/core/PoolFactory.sol)) | `"FEE_NOT_ENABLED"` |
| No duplicate pool | `PoolFactory.createPool` ([PoolFactory.sol:66](../contracts/src/core/PoolFactory.sol)) | `"POOL_EXISTS"` |
| TickMath input range | `TickMath.getSqrtRatioAtTick` line 17, `getTickAtSqrtRatio` line 53 | bare `require` |

Invariants I7 ([Invariants.test.js:345-385](../contracts/test/fuzz/Invariants.test.js)) explicitly fuzzes out-of-range tick inputs, inverted tick ranges, and wrong-direction price limits to confirm they all revert.

---

## 12. Access Control Matrix

| Function | Caller | Check |
|---|---|---|
| `PoolFactory.createPool` | anyone | none (idempotent — duplicate reverts) |
| `PoolFactory.enableFeeAmount` | factory owner | `onlyOwner` modifier ([PoolFactory.sol:21-24](../contracts/src/core/PoolFactory.sol)) |
| `PoolFactory.setPoolProtocolFee` | factory owner | `onlyOwner` |
| `PoolFactory.collectPoolProtocol` | factory owner | `onlyOwner` |
| `Pool.initialize` | anyone | once-only (`AlreadyInitialized`) |
| `Pool.mint / burn / swap / collect` | anyone | business-level invariants only |
| `Pool.setProtocolFee` | factory contract OR factory owner | inline dual-path `require` |
| `Pool.collectProtocol` | factory contract OR factory owner | inline dual-path `require` |
| `Pool.increaseObservationCardinalityNext` | anyone | guarded by `lock` only |
| `PositionManager.increaseLiquidity` | NFT owner or approved | `isAuthorized(tokenId)` modifier → ERC-721 `_isAuthorized` ([PositionManager.sol:103-106](../contracts/src/periphery/PositionManager.sol)) |
| `PositionManager.decreaseLiquidity` | NFT owner or approved | `isAuthorized(tokenId)` |
| `PositionManager.collect` | NFT owner or approved | `isAuthorized(tokenId)` |

The only privileged role across the system is `PoolFactory.owner`. Its on-chain powers are limited to fee-tier enablement and protocol-fee configuration — it has no authority over pool reserves, position state, or LP fees beyond the capped protocol-fee redirect.

---

## 13. Known Limitations

These are explicit, deliberate, and documented — not bugs.

- **Fee-on-transfer and rebasing tokens unsupported.** `Pool.mint` and `Pool.swap` enforce `balanceAfter ≥ balanceBefore + amount`; tokens that deduct from the transferred amount silently will revert.
- **ERC-777 / callback-on-transfer tokens.** Theoretically allowed by `safeTransfer`, but the CEI ordering and `lock` modifier make these safe. Still, real-world use should whitelist standard ERC-20s only.
- **No emergency pause.** A critical bug found post-deployment has no on-chain remediation other than abandoning the deployment.
- **No timelock.** `factory.owner` changes to protocol fee take effect immediately.
- **ERC-721 LP positions lack `tokenURI` / on-chain SVG metadata.** Position IDs are simple integers; no visual representation.
- **Single curve only.** Concentrated liquidity in `1.0001^tick` price space; no Curve-style stableswap or hybrid curves.
- **No on-chain dynamic fee.** Dynamic-fee logic exists only as a UI recommendation in `SwapPanel.jsx` and `AnalyticsPanel.jsx`. Adapting fees on-chain would require reading the TWAP within `swap`, increasing gas and complicating fee accounting.
- **JIT defence is detection-only.** Front-end warns; pool does not redistribute fees away from JIT positions.
- **`MockERC20` has unrestricted public `mint`.** Suitable only for local Hardhat / testnet use. Production must replace it with a real ERC-20.
- **Single-signer factory owner.** Production should require multisig + timelock.
- **No external audit, no formal verification.** Property tests (Invariants I1–I7) cover key correctness claims but are not a substitute.
- **Legacy `ImprovedAMM.sol`.** This V2-style baseline contract ships in `contracts/src/ImprovedAMM.sol` for regression-testing the project's evolution. It is **not deployed** by the production `deploy.js` script and is outside the security perimeter of this document.

---

## 14. Future Hardening

In rough order of impact-per-effort:

1. **Multisig + 24h timelock on `PoolFactory.owner`.** Removes the single-EOA risk on `setPoolProtocolFee` and `collectPoolProtocol`.
2. **On-chain JIT defence.** Record `mintBlock` per position; on burn within `N` blocks, route the position's `feeGrowthInside` delta into a shared LP buffer rather than to the JIT LP.
3. **On-chain dynamic fee.** Read `getTWAP(300)` vs `getTWAP(1800)` within `swap`, multiplicatively adjust `feePips` based on volatility band. Cost: ~5k extra gas per swap.
4. **Pack `protocolFee` into `Slot0`.** Saves one `SLOAD` per swap when protocol fee is active.
5. **`Pausable` modifier on `Pool`.** Owner-triggered, auto-expiring after 7 days, scoped to `mint` and `swap` (never `burn` / `collect` — users must always be able to exit).
6. **Convert remaining revert strings to custom errors.** `setProtocolFee` / `collectProtocol`.
7. **Formal verification.** Run Certora or Halmos against the seven property invariants already encoded in `Invariants.test.js`.
8. **External audit.** Mandatory before any value-bearing deployment.
9. **ERC-721 metadata.** Add `tokenURI` with on-chain SVG showing tick range, in-range status, fees accrued.
10. **Multicall on PositionManager.** Let users `mint` + `increaseLiquidity` in one transaction; saves users gas and reduces stuck approvals.
