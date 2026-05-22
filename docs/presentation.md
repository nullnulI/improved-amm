# 5-Minute Presentation Script

**Title:** Concentrated Liquidity AMM with Novel Features
**Project:** SC6107 Option 5
**Total runtime:** 5:00 (≈ 4:30 talk + 0:30 buffer for transitions)

A practical demo script. Each section gives **what to say**, **what to show on screen**, and **key numbers** to mention. Adapt phrasing freely — the bullets are the spine, not a teleprompter.

---

## 1. Problem & Solution (0:00 – 0:50)

**Show:** the README's "Novel Features" table, or the title slide.

**Say:**

> Uniswap V2's `x · y = k` is elegant, but it forces liquidity providers to spread capital across all prices from zero to infinity. The result is that **>99% of LP capital sits at prices that never trade**. Fees are fixed regardless of market volatility. There's no native limit-order primitive. LPs eat impermanent loss on every price move without compensation.
>
> We built a **concentrated liquidity AMM** — Uniswap V3 style — that lets each LP pick the price range where their capital is active. Around that core, we layered four novel features: a protocol-owned-liquidity mechanism, a TWAP-based dynamic fee recommender, single-sided range orders, and just-in-time liquidity detection. Eighty-four passing tests, full React frontend, deployed locally on Hardhat.

**Key numbers to land:**

- V2 capital efficiency vs. concentrated: roughly **200× higher** for a ±1% range
- Four novel features beyond stock V3
- 84 tests across unit, integration, fuzz, and gas categories

---

## 2. Architecture (0:50 – 1:40)

**Show:** the system diagram in `docs/architecture.md` (or describe with the file tree visible).

**Say:**

> Three layers. **Core** has `PoolFactory` and `Pool`. The pool is the engine — tick math, fee accumulation, TWAP oracle, the swap loop. **Periphery** wraps the core with developer-friendly contracts: `PositionManager` turns each LP position into an ERC-721 NFT, `SwapRouter` handles single and multi-hop swaps, `Quoter` simulates swaps by reverting with the result so the front end gets quotes without spending gas.
>
> Math lives in **eleven libraries** — TickMath for `tick ↔ sqrtPrice` conversion, FullMath for 512-bit `mulDiv`, Oracle for the TWAP ring buffer, SwapMath for the per-step computation, and so on.
>
> The **React frontend** has four tabs — Swap, Liquidity, Positions, Analytics — talking to the contracts through ethers.js and a deployed `PoolFactory`.

**Point at:**

- `contracts/src/core/` — Pool.sol, PoolFactory.sol
- `contracts/src/periphery/` — PositionManager, SwapRouter, Quoter
- `contracts/src/libraries/` — the eleven `.sol` files
- `frontend/src/components/` — the four panels

---

## 3. Live Demo (1:40 – 3:10)

The most important segment. Move briskly; do not stop to explain each click. Narration runs **in parallel** with the actions.

### 3a. Swap tab (1:40 – 2:10)

**Do:**

1. Already-connected wallet; pool already loaded
2. Enter `100` in the input field
3. Click **Quote** — point at execution price, spot price, price impact
4. Highlight the **"rec." badge** on one of the three fee tiers
5. Click **Swap**, confirm in MetaMask

**Say:**

> Quote first — execution price, spot price, **price impact** computed live by the on-chain Quoter. Notice the **"rec." badge** on the 0.30% fee tier: that's our dynamic fee recommendation, classifying current TWAP divergence into Low/Medium/High volatility. Swap executes; minimum-received is enforced by both the router and the pool's sqrtPriceLimit.

### 3b. Liquidity tab (2:10 – 2:40)

**Do:**

1. Switch to **Liquidity** tab
2. Toggle through **Range / Sell Order / Buy Order** modes — show the hint text changing
3. Pick **Range**, click **±10%** preset
4. Show the tick preview updating with the rounded ticks
5. Enter amounts in both token boxes, click **Add Position**

**Say:**

> Three modes. **Range Liquidity** is the standard concentrated LP: deposit both tokens within a chosen price range, earn fees while in-range. **Sell Order** deposits only token0 *above* the current price — as the price climbs through the range, token0 is sold off for token1. That's a passive **limit sell**, built on concentrated liquidity, with no new contract code. **Buy Order** is the symmetric case below the price.

### 3c. Positions tab (2:40 – 2:55)

**Do:**

1. Switch to **Positions** tab
2. Point at the freshly minted NFT card
3. Show the **● In Range** badge
4. Show **Claimable** rows turning green (if any swaps have run)
5. Briefly mention the **JIT Liquidity** warning that appears if mint and swap fall in the same block

**Say:**

> Each LP position is an ERC-721 NFT — transferable, composable. Green check-marks for in-range positions, claimable fees in green when non-zero, **orange JIT warning** if the position was minted in the same block as a swap, which is the on-chain signature of just-in-time liquidity behavior.

### 3d. Analytics tab (2:55 – 3:10)

**Do:**

1. Switch to **Analytics** tab
2. Sweep across the page: TWAP cards → volatility banner → price+volume chart → depth chart → IL calculator → POL panel
3. Pause on the **IL calculator** — show concentrated vs. full-range comparison

**Say:**

> Three TWAP cards: spot, 5-minute, 30-minute. The colored banner classifies volatility. Combined price-and-volume chart from live `Swap` events. Liquidity-depth bar chart with the **active tick bucket highlighted orange**. The **IL calculator** computes impermanent loss for a V3 concentrated position using the proper sqrt-price formulas, and shows it side-by-side with the V2 full-range equivalent. The **POL panel** at the bottom lets the factory owner set the protocol fee denominator and collect accrued fees — fully on-chain.

---

## 4. Math & Novel Features (3:10 – 4:25)

**Show:** open `Pool.sol` or `docs/architecture.md` briefly. Or just stay on the slide.

### 4a. The math, in 30 seconds (3:10 – 3:40)

**Say:**

> Price is stored as `sqrtPriceX96` — `sqrt(price) × 2^96`, Q64.96 fixed-point. Ticks are integer logarithmic prices: each tick is one basis point of price movement, with `price(tick) = 1.0001^tick`. A position with liquidity `L` over `[√Pa, √Pb]` follows
>
> ```
> Δx = L · (√Pb − √P) / (√P · √Pb)
> Δy = L · (√P − √Pa)
> ```
>
> All swap math, fee tracking, and position accounting reduces to compositions of these. We use **`FullMath.mulDiv`** with a 512-bit intermediate to prevent overflow, and we round in the direction that always favors the pool over the caller.

### 4b. Four novel features (3:40 – 4:25)

**Say (≈ 10 seconds each):**

1. **Protocol-Owned Liquidity (POL)** — factory owner sets a per-pool denominator. `denominator = 5` means 1/5 of each swap fee accrues to the protocol treasury; LP fee tracking is unaffected. Denominator is bounded ≥ 4, so the protocol captures **at most 25%**. Fully on-chain; tested end-to-end in Invariants I6.

2. **TWAP-based dynamic fee recommendation** — the front end reads `getTWAP(300)` and `getTWAP(1800)` and computes `|TWAP_5m − TWAP_30m| / TWAP_30m`. Low / Medium / High volatility maps to **0.05% / 0.30% / 1.00%** recommendations. The "rec." badge in the Swap tab guides users; LPs in the Liquidity tab see the same signal. Currently a UI hint; on-chain enforcement is in the roadmap.

3. **Range orders as limit orders** — a single-sided concentrated position above the current price *is* a limit sell. Below the price, a limit buy. We expose this as first-class UI modes in the Liquidity tab. **Zero new contract code** — it's just a clever use of the V3 primitive.

4. **JIT liquidity detection** — `PositionsPanel.jsx` cross-references each position's `IncreaseLiquidity` event block against the pool's `Swap` events; if any swap shares a block with a mint, the position card surfaces an orange warning. Detection-only today; on-chain fee redistribution is in our future-hardening list.

---

## 5. Tests, Security, Close (4:25 – 5:00)

**Show:** `npm test` output, or open `contracts/test/fuzz/Invariants.test.js`.

**Say:**

> **Eighty-four tests, all passing.** Four categories: unit tests for libraries (`TickMath` round-trips, monotonicity over 75+ ticks), integration tests through the full factory → pool → router → quoter chain, **fuzz/invariant tests** for seven properties including swap token conservation across eight swap sizes and full protocol-fee lifecycle, and gas-regression tests with upper-bound assertions.
>
> **Gas:** 136k for a single swap, 201k for a 2-pool multi-hop, 445k for a wide-range mint — competitive with Uniswap V3 mainnet.
>
> **Security:** reentrancy guard packed into `Slot0`'s last byte, callback authentication against `factory.getPool`, strict checks-effects-interactions, custom errors throughout, `FullMath` 512-bit precision with disciplined rounding, two-layer slippage protection via `amountOutMinimum` and `sqrtPriceLimitX96`. Honest disclosures: no on-chain MEV defense beyond slippage, no timelock on the factory owner, no support for fee-on-transfer tokens. All documented in `docs/security-analysis.md`.
>
> That's the project. Happy to take questions.

**Key numbers to land:**

- 84 tests passing
- 7 property invariants in the fuzz suite
- 136k gas / single swap, 201k / multi-hop
- 25% upper bound on protocol fee capture (denominator ≥ 4)
- 200× capital efficiency vs. V2 for a ±1% range

---

## Q&A Prep (audience expected to ask)

| Likely question | Concise answer |
|---|---|
| "Why concentrated liquidity over a custom curve?" | Concentrated liquidity solves the capital efficiency problem with proven math; a custom curve would need its own correctness proof. We invested complexity in features around the curve, not in the curve itself. |
| "How is this different from just deploying Uniswap V3?" | Math is V3-ported (MIT-licensed, attributed). Novel work is in the **four feature layers**: POL, dynamic fee recommendation, range-order UX, JIT detection — plus the full React frontend and 84-test harness. |
| "Why is dynamic fee only a UI hint?" | On-chain dynamic fees add gas to every swap and complicate fee accounting. We documented the on-chain path as future work and shipped the highest-impact version (a UI recommender) that already informs both swappers and LPs. |
| "What protects LPs from JIT attacks today?" | Detection-only today. Roadmap is to record `mintBlock` per position and redirect `feeGrowthInside` into a shared LP buffer if the position is burned within N blocks. |
| "Is the math original?" | TickMath magic ratios and the 512-bit FullMath algorithm are ported from Uniswap V3 Core with MIT attribution in the README. Pool logic, periphery contracts, novel features, tests, and frontend are independent work. |
| "Why no timelock on the factory owner?" | Course MVP. The owner's powers are bounded — at worst it sets protocol fee to its 25% cap and drains `protocolFees`. Production must add multisig + timelock; this is documented in security-analysis.md §14. |
| "What about MEV / sandwiches?" | Two-layer defense — `amountOutMinimum` at the router, `sqrtPriceLimitX96` at the pool. A sandwich is unprofitable if the user's slippage tolerance is below `2 × (fee + gas)`. Front-end default is 0.5%, which is on the edge for the 0.30% tier. Honest disclosure in security-analysis.md §10. |
| "Why ERC-721 positions instead of fungible LP tokens?" | Each concentrated position is uniquely defined by `(pool, tickLower, tickUpper, owner)` — non-fungible by construction. NFTs let positions be transferred, used as collateral elsewhere, and visualised individually. |

---

## Speaker Checklist (run through before the demo)

- [ ] `npm run node` running in terminal 1
- [ ] `npm run deploy` already executed; addresses copied to the frontend
- [ ] `npm run dev` running, browser open at `http://localhost:5173`
- [ ] Wallet connected to Hardhat Local (chain 31337)
- [ ] At least one position already minted (so the Positions tab isn't empty)
- [ ] At least 3–5 swaps executed (so Analytics charts show data)
- [ ] Protocol fee already enabled (`setPoolProtocolFee(pool, 5)` from the factory owner) so the POL panel shows non-zero accruals
- [ ] Two browser tabs ready: localhost:5173 (frontend) and the GitHub repo (for code references during Q&A)

---

## Timing Recovery

If a section runs long, cut from:

1. **First:** the math derivation in §4a — most audiences don't need the equations
2. **Second:** Q&A — defer to "happy to dig in after"
3. **Last:** the live demo — this is what makes the project tangible

If a section runs short, expand:

1. **Add depth in §4b** — pick one novel feature and explain end-to-end
2. **Add an invariant walkthrough in §5** — open `Invariants.test.js` and read I3 or I6
3. **Show the IL chart in §3d** — vary the entry / range inputs to demonstrate IL sensitivity
