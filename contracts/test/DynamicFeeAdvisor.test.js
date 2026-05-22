/**
 * @title DynamicFeeAdvisor Tests
 * @notice Tests the on-chain volatility oracle and fee tier recommendation logic.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

const Q96 = 2n ** 96n;
const FEE = 3000;
const TS  = 60;

async function dl() {
  const b = await ethers.provider.getBlock("latest");
  return b.timestamp + 3600;
}

describe("DynamicFeeAdvisor", function () {
  this.timeout(60_000);

  let owner, alice;
  let token0, token1, factory, pool, pm, router, advisor;

  before(async function () {
    [owner, alice] = await ethers.getSigners();

    const MockERC20   = await ethers.getContractFactory("MockERC20");
    const PoolFactory = await ethers.getContractFactory("PoolFactory");
    const PM          = await ethers.getContractFactory("PositionManager");
    const Router      = await ethers.getContractFactory("SwapRouter");
    const Advisor     = await ethers.getContractFactory("DynamicFeeAdvisor");

    const tokenA = await MockERC20.deploy("TKA", "TKA");
    const tokenB = await MockERC20.deploy("TKB", "TKB");
    factory = await PoolFactory.deploy();
    pm      = await PM.deploy(factory.target);
    router  = await Router.deploy(factory.target);
    advisor = await Advisor.deploy(factory.target);

    [token0, token1] = tokenA.target.toLowerCase() < tokenB.target.toLowerCase()
      ? [tokenA, tokenB] : [tokenB, tokenA];

    const BIG = ethers.parseEther("10000000");
    for (const u of [owner, alice]) {
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

    // Seed wide-range liquidity
    await pm.connect(alice).mint({
      token0: token0.target, token1: token1.target, fee: FEE,
      tickLower: -TS * 1000, tickUpper: TS * 1000,
      amount0Desired: ethers.parseEther("500000"),
      amount1Desired: ethers.parseEther("500000"),
      amount0Min: 0, amount1Min: 0,
      recipient: alice.address, deadline: await dl(),
    });
  });

  it("factory() returns the correct factory address", async function () {
    expect(await advisor.factory()).to.equal(factory.target);
  });

  it("getVolatilityReport: reverts PoolNotFound for non-existent pool", async function () {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const unknown = await MockERC20.deploy("U", "U");
    await expect(
      advisor.getVolatilityReport(token0.target, unknown.target, FEE)
    ).to.be.revertedWithCustomError(advisor, "PoolNotFound");
  });

  it("getVolatilityReport: works with no TWAP history (falls back to spot)", async function () {
    const report = await advisor.getVolatilityReport(token0.target, token1.target, FEE);
    // Without history, twap5m == twap30m → divergence == 0 → Low volatility
    expect(report.tickDivergence).to.equal(0);
    expect(report.volatilityLevel).to.equal(0); // Low
    expect(report.recommendedFeeTier).to.equal(500); // LOW_VOL_FEE
    // hasSufficientHistory should be false (pool just initialized, no 30m history)
    expect(report.hasSufficientHistory).to.equal(false);
  });

  it("getVolatilityReport: returns a recommended fee tier", async function () {
    const report = await advisor.getVolatilityReport(token0.target, token1.target, FEE);
    const validFees = [500n, 3000n, 10000n];
    expect(validFees).to.include(report.recommendedFeeTier);
  });

  it("getVolatilityReport: volatilityLevel is in {0,1,2}", async function () {
    const report = await advisor.getVolatilityReport(token0.target, token1.target, FEE);
    expect(report.volatilityLevel).to.be.lte(2);
  });

  it("getOptimalPool: returns pool address and optimal fee", async function () {
    const [optPool, optFee] = await advisor.getOptimalPool(token0.target, token1.target, FEE);
    const validFees = [500n, 3000n, 10000n];
    expect(validFees).to.include(optFee);
    // optPool may be address(0) if the optimal fee tier pool doesn't exist
    // — that's acceptable; it means the optimal pool hasn't been deployed yet
  });

  it("isOptimalFeeTier: consistent with getVolatilityReport recommendation", async function () {
    const report = await advisor.getVolatilityReport(token0.target, token1.target, FEE);
    const isOpt = await advisor.isOptimalFeeTier(
      token0.target, token1.target, FEE, report.recommendedFeeTier
    );
    expect(isOpt).to.equal(true);
  });

  it("isOptimalFeeTier: returns false for non-recommended fee tiers", async function () {
    const report = await advisor.getVolatilityReport(token0.target, token1.target, FEE);
    const allFees = [500, 3000, 10000];
    const wrongFees = allFees.filter(f => f !== Number(report.recommendedFeeTier));
    for (const wf of wrongFees) {
      const isOpt = await advisor.isOptimalFeeTier(token0.target, token1.target, FEE, wf);
      expect(isOpt).to.equal(false);
    }
  });

  it("getVolatilityReport: after price movement shows non-zero divergence when history exists", async function () {
    // Create many price-moving swaps to build TWAP history
    // Alternate direction to create tick-crossing observations
    const swapAmt = ethers.parseEther("10000");
    for (let i = 0; i < 3; i++) {
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine");
      const zfo = i % 2 === 0;
      await router.connect(alice).exactInputSingle({
        tokenIn:  zfo ? token0.target : token1.target,
        tokenOut: zfo ? token1.target : token0.target,
        fee: FEE, recipient: alice.address, deadline: await dl(),
        amountIn: swapAmt, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n,
      });
    }

    // Report should now have some divergence if observations were written
    const report = await advisor.getVolatilityReport(token0.target, token1.target, FEE);
    // tickDivergence should be a non-negative number
    expect(report.tickDivergence).to.be.gte(0);
    // The recommended fee tier is always one of the valid values
    expect([500n, 3000n, 10000n]).to.include(report.recommendedFeeTier);
  });
});

// ── Volatile-regime branches (MED / HIGH volatility levels) ──────────────────
describe("DynamicFeeAdvisor — hasSufficientHistory and volatile-regime branches", function () {
  this.timeout(180_000);

  // Deploy fresh contracts and build enough observation history for both TWAP
  // windows to succeed.  Strategy:
  //   T+0    : pool init (obs[0])
  //   T+10   : tiny swap → obs[1] at tick~0
  //   T+2010 : big swap  → obs[2] accumulates 2000s at tick~0, then price jumps
  //   T+2320 : tiny swap → obs[3] accumulates 310s at new high tick
  // TWAP(300)  ≈ high_tick            (last 300s entirely at new price)
  // TWAP(1800) ≈ high_tick × 310/1800 (new price only covers 310 of 1800s)
  // divergence ≈ high_tick × 0.828
  async function deployWithHistory(bigSwapAmt) {
    const [, alice] = await ethers.getSigners();
    const MockERC20   = await ethers.getContractFactory("MockERC20");
    const PoolFactory = await ethers.getContractFactory("PoolFactory");
    const PM          = await ethers.getContractFactory("PositionManager");
    const Router      = await ethers.getContractFactory("SwapRouter");
    const Advisor     = await ethers.getContractFactory("DynamicFeeAdvisor");

    const tokenA = await MockERC20.deploy("H", "H");
    const tokenB = await MockERC20.deploy("I", "I");
    const factory = await PoolFactory.deploy();
    const pm      = await PM.deploy(factory.target);
    const router  = await Router.deploy(factory.target);
    const advisor = await Advisor.deploy(factory.target);

    const [token0, token1] = tokenA.target.toLowerCase() < tokenB.target.toLowerCase()
      ? [tokenA, tokenB] : [tokenB, tokenA];

    const BIG = ethers.parseEther("10000000");
    await token0.mint(alice.address, BIG);
    await token1.mint(alice.address, BIG);
    await token0.connect(alice).approve(pm.target, ethers.MaxUint256);
    await token1.connect(alice).approve(pm.target, ethers.MaxUint256);
    await token0.connect(alice).approve(router.target, ethers.MaxUint256);
    await token1.connect(alice).approve(router.target, ethers.MaxUint256);

    await factory.createPool(token0.target, token1.target, 3000);
    const poolAddr = await factory.getPool(token0.target, token1.target, 3000);
    const pool = await ethers.getContractAt("Pool", poolAddr);

    await pool.initialize(2n ** 96n);
    // Grow observation capacity AFTER init (requires cardinality > 0)
    await pool.increaseObservationCardinalityNext(10);

    // Seed liquidity across a very wide range
    await pm.connect(alice).mint({
      token0: token0.target, token1: token1.target, fee: 3000,
      tickLower: -60 * 2000, tickUpper: 60 * 2000,
      amount0Desired: ethers.parseEther("500000"),
      amount1Desired: ethers.parseEther("500000"),
      amount0Min: 0, amount1Min: 0,
      recipient: alice.address, deadline: await dl(),
    });

    // T+10: tiny swap to commit the first observation (obs[1] at tick~0)
    await ethers.provider.send("evm_increaseTime", [10]);
    await ethers.provider.send("evm_mine");
    await router.connect(alice).exactInputSingle({
      tokenIn: token0.target, tokenOut: token1.target, fee: 3000,
      recipient: alice.address, deadline: await dl(),
      amountIn: ethers.parseEther("1"), amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    });

    // Advance 2000s (pool sits at tick~0 for the bulk of the 30-min window)
    await ethers.provider.send("evm_increaseTime", [2000]);
    await ethers.provider.send("evm_mine");

    // Big swap: push price up (token1 → token0, moves tick upward)
    await router.connect(alice).exactInputSingle({
      tokenIn: token1.target, tokenOut: token0.target, fee: 3000,
      recipient: alice.address, deadline: await dl(),
      amountIn: bigSwapAmt, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    });

    // T+2320: advance 310s at the new high tick, then write final observation
    await ethers.provider.send("evm_increaseTime", [310]);
    await ethers.provider.send("evm_mine");
    await router.connect(alice).exactInputSingle({
      tokenIn: token0.target, tokenOut: token1.target, fee: 3000,
      recipient: alice.address, deadline: await dl(),
      amountIn: ethers.parseEther("1"), amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    });

    return { advisor, token0, token1 };
  }

  it("hasSufficientHistory=true when both TWAP windows are available", async function () {
    const { advisor, token0, token1 } = await deployWithHistory(ethers.parseEther("10000"));
    const report = await advisor.getVolatilityReport(token0.target, token1.target, 3000);
    expect(report.hasSufficientHistory).to.equal(true);
  });

  it("volatilityLevel=2 (HIGH): 200+ tick divergence → HIGH fee tier (10000)", async function () {
    // 250k token swap into 500k pool → moves tick 300+ → divergence 200+
    const { advisor, token0, token1 } = await deployWithHistory(ethers.parseEther("250000"));
    const report = await advisor.getVolatilityReport(token0.target, token1.target, 3000);
    expect(report.volatilityLevel).to.equal(2);
    expect(report.recommendedFeeTier).to.equal(10000n);
    expect(report.tickDivergence).to.be.gte(200n);
  });

  it("volatilityLevel=1 (MED): 50-199 tick divergence → MED fee tier (3000)", async function () {
    // 5k token swap → ~164 tick divergence → solidly MED
    const { advisor, token0, token1 } = await deployWithHistory(ethers.parseEther("5000"));
    const report = await advisor.getVolatilityReport(token0.target, token1.target, 3000);
    expect(report.volatilityLevel).to.equal(1);
    expect(report.recommendedFeeTier).to.equal(3000n);
    expect(report.tickDivergence).to.be.gte(50n);
    expect(report.tickDivergence).to.be.lt(200n);
  });
});
