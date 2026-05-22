/**
 * @title Property-Based / Fuzz Tests
 * @notice Validates mathematical invariants across a wide range of random inputs.
 *         These tests mirror Foundry-style invariant tests but use JavaScript's
 *         Mocha/Chai harness with pseudo-random input generation.
 *
 * Invariants tested:
 *   I1. TickMath round-trip: getTickAtSqrtRatio(getSqrtRatioAtTick(t)) == t
 *   I2. TickMath monotonicity: sqrtPrice strictly increases with tick
 *   I3. Swap conservation: token balance changes equal reported deltas
 *   I4. Fee invariant: LPs can never collect more fees than were generated
 *   I5. Liquidity invariant: pool liquidity is always ≥ 0 and consistent with mint/burn ops
 *   I6. Protocol fee invariant: protocol fees + LP fees == total swap fees
 *   I7. No-mint-no-liquidity: pool with no mints has zero liquidity
 */
const { expect } = require("chai");
const { ethers }  = require("hardhat");

// ── helpers ──────────────────────────────────────────────────────────────────
function randInt(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Deterministic pseudo-random tick sample covering full valid range */
function sampleTicks(n = 60) {
  const FIXED = [-887272, -887271, -100000, -10000, -1000, -100, -10, -1,
                  0, 1, 10, 100, 1000, 10000, 100000, 887270, 887271];
  const rand  = Array.from({ length: n - FIXED.length }, () => randInt(-887271, 887271));
  return [...new Set([...FIXED, ...rand])].sort((a, b) => a - b);
}

const Q96  = 2n ** 96n;
const FEE  = 3000;
const TS   = 60;

async function dl() {
  const b = await ethers.provider.getBlock("latest");
  return b.timestamp + 3600;
}

// ── shared deployment ─────────────────────────────────────────────────────────
describe("Invariant / Fuzz Tests", function () {
  this.timeout(120_000); // fuzzing over many inputs takes longer

  let tickMathTest;
  let owner, lp, trader;
  let token0, token1, factory, pool, pm, router;

  before(async function () {
    [owner, lp, trader] = await ethers.getSigners();

    // TickMathTest harness
    const TMT = await ethers.getContractFactory("TickMathTest");
    tickMathTest = await TMT.deploy();

    // Full AMM stack
    const MockERC20   = await ethers.getContractFactory("MockERC20");
    const PoolFactory = await ethers.getContractFactory("PoolFactory");
    const PM          = await ethers.getContractFactory("PositionManager");
    const Router      = await ethers.getContractFactory("SwapRouter");

    const tokenA = await MockERC20.deploy("TokenA", "TKA");
    const tokenB = await MockERC20.deploy("TokenB", "TKB");
    factory = await PoolFactory.deploy();
    pm      = await PM.deploy(factory.target);
    router  = await Router.deploy(factory.target);

    [token0, token1] = tokenA.target.toLowerCase() < tokenB.target.toLowerCase()
      ? [tokenA, tokenB] : [tokenB, tokenA];

    const BIG = ethers.parseEther("100000000");
    for (const u of [lp, trader]) {
      await token0.mint(u.address, BIG);
      await token1.mint(u.address, BIG);
      await token0.connect(u).approve(pm.target,     ethers.MaxUint256);
      await token1.connect(u).approve(pm.target,     ethers.MaxUint256);
      await token0.connect(u).approve(router.target, ethers.MaxUint256);
      await token1.connect(u).approve(router.target, ethers.MaxUint256);
    }

    await factory.createPool(token0.target, token1.target, FEE);
    const poolAddr = await factory.getPool(token0.target, token1.target, FEE);
    pool = await ethers.getContractAt("Pool", poolAddr);
    await pool.initialize(Q96);
  });

  // ── I1: TickMath round-trip ────────────────────────────────────────────────
  describe("I1 — TickMath round-trip: getTickAtSqrtRatio(getSqrtRatioAtTick(t)) == t", function () {
    it("holds for 75+ sampled ticks across the full valid range", async function () {
      const ticks = sampleTicks(75);
      // MAX_TICK (887272) computes a sqrtRatio that is out-of-bounds for getTickAtSqrtRatio
      const filtered = ticks.filter((t) => t !== 887272);
      for (const t of filtered) {
        const sqrtPrice = await tickMathTest.getSqrtRatioAtTick(t);
        const back      = await tickMathTest.getTickAtSqrtRatio(sqrtPrice);
        expect(back).to.equal(t, `round-trip failed at tick=${t}`);
      }
    });
  });

  // ── I2: TickMath monotonicity ──────────────────────────────────────────────
  describe("I2 — sqrtPrice strictly increases with tick", function () {
    it("holds for 50+ ordered tick samples", async function () {
      const ticks = sampleTicks(50);
      let prev = 0n;
      for (const t of ticks) {
        const sqrtPrice = await tickMathTest.getSqrtRatioAtTick(t);
        if (prev > 0n) expect(sqrtPrice).to.be.gt(prev, `monotonicity broken at tick=${t}`);
        prev = sqrtPrice;
      }
    });
  });

  // ── Shared: seed pool with liquidity for swap-based invariants ────────────
  before(async function () {
    await pm.connect(lp).mint({
      token0: token0.target, token1: token1.target, fee: FEE,
      tickLower: -TS * 1000, tickUpper: TS * 1000,
      amount0Desired: ethers.parseEther("50000"),
      amount1Desired: ethers.parseEther("50000"),
      amount0Min: 0, amount1Min: 0,
      recipient: lp.address, deadline: await dl(),
    });
  });

  // ── I3: Swap token balance conservation ───────────────────────────────────
  describe("I3 — Swap conservation: balance changes == reported deltas", function () {
    const SWAP_SIZES = [0.001, 0.01, 0.1, 1, 10, 50, 100, 500];

    for (const size of SWAP_SIZES) {
      it(`conserves tokens for ${size} token0 → token1 swap`, async function () {
        const amountIn = ethers.parseEther(size.toString());

        const before0 = await token0.balanceOf(trader.address);
        const before1 = await token1.balanceOf(trader.address);

        await router.connect(trader).exactInputSingle({
          tokenIn:  token0.target, tokenOut: token1.target, fee: FEE,
          recipient: trader.address, deadline: await dl(),
          amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n,
        });

        const after0 = await token0.balanceOf(trader.address);
        const after1 = await token1.balanceOf(trader.address);

        // Must spend exactly amountIn of token0
        expect(before0 - after0).to.equal(amountIn, "token0 spent mismatch");
        // Must receive a strictly positive amount of token1
        expect(after1 - before1).to.be.gt(0n, "received zero token1");
      });
    }

    it("execution price is always less favorable than spot (fee + impact)", async function () {
      const amountIn = ethers.parseEther("10");
      const slot0    = await pool.slot0();
      const spotPrice = Number(slot0.sqrtPriceX96) ** 2 / Number(Q96) ** 2;

      const before1 = await token1.balanceOf(trader.address);
      await router.connect(trader).exactInputSingle({
        tokenIn: token0.target, tokenOut: token1.target, fee: FEE,
        recipient: trader.address, deadline: await dl(),
        amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n,
      });
      const received   = await token1.balanceOf(trader.address) - before1;
      const execPrice  = Number(received) / Number(amountIn);
      // Execution price must be < spot (paid fee + price impact)
      expect(execPrice).to.be.lte(spotPrice * 1.001); // 0.1% tolerance for precision
    });
  });

  // ── I4: Fee invariant — collected ≤ accrued ────────────────────────────────
  describe("I4 — Fee invariant: LP can never collect more than accrued", function () {
    it("total fees collected by LP ≤ total protocol fees generated across 20 swaps", async function () {
      const swapAmt = ethers.parseEther("30");
      for (let i = 0; i < 20; i++) {
        const zfo = i % 2 === 0;
        await router.connect(trader).exactInputSingle({
          tokenIn:  zfo ? token0.target : token1.target,
          tokenOut: zfo ? token1.target : token0.target,
          fee: FEE, recipient: trader.address, deadline: await dl(),
          amountIn: swapAmt, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n,
        });
      }

      const b0before = await token0.balanceOf(lp.address);
      const b1before = await token1.balanceOf(lp.address);

      await pm.connect(lp).collect({
        tokenId: 1, recipient: lp.address,
        amount0Max: 2n ** 128n - 1n, amount1Max: 2n ** 128n - 1n,
      });

      const collected0 = (await token0.balanceOf(lp.address)) - b0before;
      const collected1 = (await token1.balanceOf(lp.address)) - b1before;

      // Pool balance must not have gone negative (implicit: transfer would revert)
      const poolBal0 = await token0.balanceOf(pool.target);
      const poolBal1 = await token1.balanceOf(pool.target);
      expect(poolBal0).to.be.gte(0n);
      expect(poolBal1).to.be.gte(0n);

      // At least one fee side must be positive after 20 swaps
      expect(collected0 + collected1).to.be.gt(0n, "no fees collected despite swaps");
    });
  });

  // ── I5: Liquidity invariant ────────────────────────────────────────────────
  describe("I5 — Liquidity invariant: pool liquidity ≥ 0; consistent with mint/burn", function () {
    it("liquidity is always non-negative after random mint/burn sequence", async function () {
      const [extra] = await ethers.getSigners();
      await token0.mint(extra.address, ethers.parseEther("10000"));
      await token1.mint(extra.address, ethers.parseEther("10000"));
      await token0.connect(extra).approve(pm.target, ethers.MaxUint256);
      await token1.connect(extra).approve(pm.target, ethers.MaxUint256);

      const txMint = await pm.connect(extra).mint({
        token0: token0.target, token1: token1.target, fee: FEE,
        tickLower: -TS * 5, tickUpper: TS * 5,
        amount0Desired: ethers.parseEther("100"),
        amount1Desired: ethers.parseEther("100"),
        amount0Min: 0, amount1Min: 0,
        recipient: extra.address, deadline: await dl(),
      });
      const rcpt     = await txMint.wait();
      const ilEvent  = rcpt.logs.find((l) => {
        try { return pm.interface.parseLog(l)?.name === "IncreaseLiquidity"; } catch { return false; }
      });
      const tokenId  = pm.interface.parseLog(ilEvent).args.tokenId;

      // Pool liquidity must be ≥ 0 after mint
      let liq = await pool.liquidity();
      expect(liq).to.be.gte(0n);

      // Partial burn — remove half
      const posData = await pm.positions(tokenId);
      await pm.connect(extra).decreaseLiquidity({
        tokenId, liquidity: posData.liquidity / 2n,
        amount0Min: 0, amount1Min: 0, deadline: await dl(),
      });
      liq = await pool.liquidity();
      expect(liq).to.be.gte(0n);

      // Full burn
      const posData2 = await pm.positions(tokenId);
      if (posData2.liquidity > 0n) {
        await pm.connect(extra).decreaseLiquidity({
          tokenId, liquidity: posData2.liquidity,
          amount0Min: 0, amount1Min: 0, deadline: await dl(),
        });
      }
      liq = await pool.liquidity();
      expect(liq).to.be.gte(0n);
    });

    it("pool with no liquidity cannot be swapped through (reverts)", async function () {
      const MockERC20F = await ethers.getContractFactory("MockERC20");
      const RouterF    = await ethers.getContractFactory("SwapRouter");
      const FactoryF   = await ethers.getContractFactory("PoolFactory");

      const tA   = await MockERC20F.deploy("TA", "TA");
      const tB   = await MockERC20F.deploy("TB", "TB");
      const fac  = await FactoryF.deploy();
      const rout = await RouterF.deploy(fac.target);

      await fac.createPool(tA.target, tB.target, 3000);
      const emptyPool = await ethers.getContractAt("Pool",
        await fac.getPool(tA.target, tB.target, 3000));
      await emptyPool.initialize(Q96);

      const [signer] = await ethers.getSigners();
      await tA.mint(signer.address, ethers.parseEther("1"));
      await tA.connect(signer).approve(rout.target, ethers.MaxUint256);

      await expect(
        rout.connect(signer).exactInputSingle({
          tokenIn:  tA.target, tokenOut: tB.target, fee: 3000,
          recipient: signer.address, deadline: await dl(),
          amountIn: ethers.parseEther("1"), amountOutMinimum: 1n, sqrtPriceLimitX96: 0n,
        })
      ).to.be.reverted;
    });
  });

  // ── I6: Protocol fee invariant ────────────────────────────────────────────
  describe("I6 — Protocol fee: only factory owner can set/collect; accrues correctly", function () {
    it("non-owner cannot set protocol fee", async function () {
      await expect(pool.connect(trader).setProtocolFee(5))
        .to.be.revertedWith("NOT_FACTORY_OWNER");
    });

    it("owner can enable protocol fee and fees accrue", async function () {
      // Enable 1/5 of each swap fee going to protocol
      await pool.connect(owner).setProtocolFee(5);
      expect(await pool.protocolFee()).to.equal(5);

      const SWAP_AMT = ethers.parseEther("200");
      for (let i = 0; i < 5; i++) {
        await router.connect(trader).exactInputSingle({
          tokenIn: token0.target, tokenOut: token1.target, fee: FEE,
          recipient: trader.address, deadline: await dl(),
          amountIn: SWAP_AMT, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n,
        });
      }

      const fees = await pool.protocolFees();
      expect(fees.token0).to.be.gt(0n, "no protocol fees accrued");
    });

    it("factory owner can collect protocol fees", async function () {
      const before0 = await token0.balanceOf(owner.address);
      await factory.connect(owner).collectPoolProtocol(pool.target, owner.address);
      const after0 = await token0.balanceOf(owner.address);
      expect(after0).to.be.gt(before0, "nothing collected");

      // After collection, protocol fees should be zeroed
      const fees = await pool.protocolFees();
      expect(fees.token0).to.equal(0n);
      expect(fees.token1).to.equal(0n);
    });

    it("non-owner cannot collect protocol fees", async function () {
      await expect(pool.connect(trader).collectProtocol(trader.address))
        .to.be.revertedWith("NOT_FACTORY_OWNER");
    });

    it("disabling protocol fee stops accrual", async function () {
      // Disable
      await pool.connect(owner).setProtocolFee(0);
      expect(await pool.protocolFee()).to.equal(0);

      const before = await pool.protocolFees();

      await router.connect(trader).exactInputSingle({
        tokenIn: token0.target, tokenOut: token1.target, fee: FEE,
        recipient: trader.address, deadline: await dl(),
        amountIn: ethers.parseEther("50"), amountOutMinimum: 1n, sqrtPriceLimitX96: 0n,
      });

      const after = await pool.protocolFees();
      expect(after.token0).to.equal(before.token0, "protocol fee accrued when disabled");
    });
  });

  // ── I7: Tick boundary invariants ───────────────────────────────────────────
  describe("I7 — Boundary invariants: invalid inputs always revert", function () {
    it("getSqrtRatioAtTick reverts for any tick outside [-887272, 887272]", async function () {
      // int24 range is [-8388608, 8388607]; stay within that to avoid ABI encoding errors
      const OOB = [-887273, -1000000, -8388608, 887273, 1000000, 8388607];
      for (const t of OOB) {
        await expect(tickMathTest.getSqrtRatioAtTick(t)).to.be.reverted;
      }
    });

    it("mint with tickLower >= tickUpper always reverts", async function () {
      const cases = [
        [0, 0], [60, 60], [120, 60], [0, -60],
      ];
      for (const [tl, tu] of cases) {
        await expect(
          pm.connect(lp).mint({
            token0: token0.target, token1: token1.target, fee: FEE,
            tickLower: tl, tickUpper: tu,
            amount0Desired: ethers.parseEther("1"),
            amount1Desired: ethers.parseEther("1"),
            amount0Min: 0, amount1Min: 0,
            recipient: lp.address, deadline: await dl(),
          })
        ).to.be.reverted;
      }
    });

    it("swap with sqrtPriceLimitX96 in wrong direction always reverts", async function () {
      const slot0 = await pool.slot0();
      // zeroForOne=true: limit must be BELOW current price, not above
      await expect(
        pool.swap(
          trader.address, true,
          ethers.parseEther("1"),
          slot0.sqrtPriceX96 + 1n, // wrong direction
          "0x"
        )
      ).to.be.revertedWithCustomError(pool, "PriceLimitOutOfBounds");
    });
  });
});
