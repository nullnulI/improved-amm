const { expect } = require("chai");
const { ethers } = require("hardhat");

// Helper: deploy a thin wrapper that exposes TickMath library functions
// We test via Pool which uses TickMath internally.
describe("TickMath", function () {
  const MIN_TICK = -887272;
  const MAX_TICK = 887272;
  const MIN_SQRT_RATIO = 4295128739n;
  const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

  // Deploy a minimal contract just to call TickMath via Hardhat artifacts
  let tickMathTest;

  before(async function () {
    // We create a simple test harness inline
    const TickMathTest = await ethers.getContractFactory("TickMathTest");
    tickMathTest = await TickMathTest.deploy();
  });

  describe("getSqrtRatioAtTick", function () {
    it("returns MIN_SQRT_RATIO at MIN_TICK", async function () {
      const result = await tickMathTest.getSqrtRatioAtTick(MIN_TICK);
      expect(result).to.equal(MIN_SQRT_RATIO);
    });

    it("returns at most MAX_SQRT_RATIO at MAX_TICK", async function () {
      const result = await tickMathTest.getSqrtRatioAtTick(MAX_TICK);
      expect(result).to.be.lte(MAX_SQRT_RATIO);
    });

    it("returns 2^96 (price = 1) at tick 0", async function () {
      const result = await tickMathTest.getSqrtRatioAtTick(0);
      const Q96 = 2n ** 96n;
      expect(result).to.be.closeTo(Q96, Q96 / 10000n);
    });

    it("reverts for tick above MAX_TICK", async function () {
      await expect(tickMathTest.getSqrtRatioAtTick(MAX_TICK + 1)).to.be.reverted;
    });

    it("reverts for tick below MIN_TICK", async function () {
      await expect(tickMathTest.getSqrtRatioAtTick(MIN_TICK - 1)).to.be.reverted;
    });

    it("price increases monotonically with tick", async function () {
      const ticks = [-100, -10, 0, 10, 100, 1000];
      let prev = 0n;
      for (const t of ticks) {
        const sqrtPrice = await tickMathTest.getSqrtRatioAtTick(t);
        expect(sqrtPrice).to.be.gt(prev);
        prev = sqrtPrice;
      }
    });
  });

  describe("getTickAtSqrtRatio", function () {
    it("returns 0 for sqrt(1) price", async function () {
      const Q96 = 2n ** 96n;
      const tick = await tickMathTest.getTickAtSqrtRatio(Q96);
      expect(tick).to.equal(0);
    });

    it("round-trips: getTickAtSqrtRatio(getSqrtRatioAtTick(t)) == t", async function () {
      // MAX_TICK (887272) rounds up to MAX_SQRT_RATIO which is out-of-range for getTickAtSqrtRatio
      for (const t of [-887272, -1000, -1, 0, 1, 1000, 887271]) {
        const sqrtPrice = await tickMathTest.getSqrtRatioAtTick(t);
        const backTick = await tickMathTest.getTickAtSqrtRatio(sqrtPrice);
        expect(backTick).to.equal(t);
      }
    });

    it("reverts below MIN_SQRT_RATIO", async function () {
      await expect(tickMathTest.getTickAtSqrtRatio(MIN_SQRT_RATIO - 1n)).to.be.reverted;
    });

    it("reverts at MAX_SQRT_RATIO", async function () {
      await expect(tickMathTest.getTickAtSqrtRatio(MAX_SQRT_RATIO)).to.be.reverted;
    });
  });
});
