/**
 * @title Gas Measurement Tests
 * @notice Measures and validates gas usage for all major AMM operations.
 *         Results are printed in a table and checked against upper bounds
 *         to catch regressions from Solidity changes.
 *
 * Operations measured:
 *   1. createPool          — factory deploy + pool creation
 *   2. initialize          — first sqrtPrice set
 *   3. mint (wide range)   — first LP position across 2000 ticks
 *   4. mint (narrow range) — concentrated position (10 ticks wide)
 *   5. swap exactInput     — small swap (1 token)
 *   6. swap exactInput     — large swap (500 tokens), crosses ticks
 *   7. swap exactOutput    — single-hop
 *   8. increaseLiquidity   — add to existing position
 *   9. decreaseLiquidity   — partial burn
 *  10. collect             — harvest fees after several swaps
 *  11. quoter.staticCall   — simulated only, no gas cost
 *  12. multi-hop swap      — two pools chained
 */
const { expect } = require("chai");
const { ethers }  = require("hardhat");

const Q96 = 2n ** 96n;
const FEE = 3000;
const TS  = 60;

async function dl() {
  const b = await ethers.provider.getBlock("latest");
  return b.timestamp + 3600;
}

/** Human-readable gas table */
function printTable(rows) {
  const COL_W = [32, 12, 12, 10];
  const header = ["Operation", "Gas Used", "Upper Bound", "Status"];
  const sep = COL_W.map((w) => "-".repeat(w)).join("-+-");

  console.log("\n" + sep);
  console.log(header.map((h, i) => h.padEnd(COL_W[i])).join(" | "));
  console.log(sep);

  for (const [name, used, bound] of rows) {
    const ok     = used <= bound;
    const status = ok ? "  OK  " : " OVER ";
    console.log([
      name.padEnd(COL_W[0]),
      String(used).padEnd(COL_W[1]),
      String(bound).padEnd(COL_W[2]),
      status,
    ].join(" | "));
  }
  console.log(sep + "\n");
}

describe("Gas Measurement Report", function () {
  this.timeout(120_000);

  let owner, lp1, lp2, trader;
  let token0, token1, tokenC;
  let factory, pool, pool2, pm, router, quoter;
  const gasRows = [];

  before(async function () {
    [owner, lp1, lp2, trader] = await ethers.getSigners();

    const MockERC20   = await ethers.getContractFactory("MockERC20");
    const PoolFactory = await ethers.getContractFactory("PoolFactory");
    const PM          = await ethers.getContractFactory("PositionManager");
    const Router      = await ethers.getContractFactory("SwapRouter");
    const QuoterF     = await ethers.getContractFactory("Quoter");

    const tokenA = await MockERC20.deploy("TokenA", "TKA");
    const tokenB = await MockERC20.deploy("TokenB", "TKB");
    tokenC       = await MockERC20.deploy("TokenC", "TKC");

    factory = await PoolFactory.deploy();
    pm      = await PM.deploy(factory.target);
    router  = await Router.deploy(factory.target);
    quoter  = await QuoterF.deploy(factory.target);

    [token0, token1] = tokenA.target.toLowerCase() < tokenB.target.toLowerCase()
      ? [tokenA, tokenB] : [tokenB, tokenA];

    const BIG = ethers.parseEther("100000000");
    for (const u of [lp1, lp2, trader]) {
      await token0.mint(u.address, BIG);
      await token1.mint(u.address, BIG);
      await tokenC.mint(u.address, BIG);
      await token0.connect(u).approve(pm.target,     ethers.MaxUint256);
      await token1.connect(u).approve(pm.target,     ethers.MaxUint256);
      await token0.connect(u).approve(router.target, ethers.MaxUint256);
      await token1.connect(u).approve(router.target, ethers.MaxUint256);
      await tokenC.connect(u).approve(router.target, ethers.MaxUint256);
    }
  });

  // ── 1. createPool ───────────────────────────────────────────────────────────
  it("1. createPool gas", async function () {
    const tx = await factory.createPool(token0.target, token1.target, FEE);
    const { gasUsed } = await tx.wait();
    const poolAddr = await factory.getPool(token0.target, token1.target, FEE);
    pool = await ethers.getContractAt("Pool", poolAddr);
    gasRows.push(["createPool", Number(gasUsed), 4_500_000]);
    expect(gasUsed).to.be.lte(4_500_000, "createPool exceeded bound");
  });

  // ── 2. initialize ──────────────────────────────────────────────────────────
  it("2. initialize gas", async function () {
    const tx = await pool.initialize(Q96);
    const { gasUsed } = await tx.wait();
    gasRows.push(["initialize", Number(gasUsed), 120_000]);
    expect(gasUsed).to.be.lte(120_000, "initialize exceeded bound");
  });

  // ── 3. mint wide range ─────────────────────────────────────────────────────
  it("3. mint (wide range, -1200 to +1200 ticks) gas", async function () {
    const tx = await pm.connect(lp1).mint({
      token0: token0.target, token1: token1.target, fee: FEE,
      tickLower: -TS * 200, tickUpper: TS * 200,
      amount0Desired: ethers.parseEther("10000"),
      amount1Desired: ethers.parseEther("10000"),
      amount0Min: 0, amount1Min: 0,
      recipient: lp1.address, deadline: await dl(),
    });
    const { gasUsed } = await tx.wait();
    gasRows.push(["mint (wide range)", Number(gasUsed), 600_000]);
    expect(gasUsed).to.be.lte(600_000, "mint wide exceeded bound");
  });

  // ── 4. mint narrow range ───────────────────────────────────────────────────
  it("4. mint (narrow range, ±1 tick spacing) gas", async function () {
    const tx = await pm.connect(lp2).mint({
      token0: token0.target, token1: token1.target, fee: FEE,
      tickLower: -TS, tickUpper: TS,
      amount0Desired: ethers.parseEther("1000"),
      amount1Desired: ethers.parseEther("1000"),
      amount0Min: 0, amount1Min: 0,
      recipient: lp2.address, deadline: await dl(),
    });
    const { gasUsed } = await tx.wait();
    gasRows.push(["mint (narrow range)", Number(gasUsed), 600_000]);
    expect(gasUsed).to.be.lte(600_000, "mint narrow exceeded bound");
  });

  // ── 5. swap small ──────────────────────────────────────────────────────────
  it("5. exactInputSingle (small, 1 token) gas", async function () {
    const tx = await router.connect(trader).exactInputSingle({
      tokenIn: token0.target, tokenOut: token1.target, fee: FEE,
      recipient: trader.address, deadline: await dl(),
      amountIn: ethers.parseEther("1"), amountOutMinimum: 1n, sqrtPriceLimitX96: 0n,
    });
    const { gasUsed } = await tx.wait();
    gasRows.push(["exactInputSingle (1 token)", Number(gasUsed), 200_000]);
    expect(gasUsed).to.be.lte(200_000, "small swap exceeded bound");
  });

  // ── 6. swap large (crosses tick boundary) ─────────────────────────────────
  it("6. exactInputSingle (large, 500 tokens, may cross ticks) gas", async function () {
    const tx = await router.connect(trader).exactInputSingle({
      tokenIn: token0.target, tokenOut: token1.target, fee: FEE,
      recipient: trader.address, deadline: await dl(),
      amountIn: ethers.parseEther("500"), amountOutMinimum: 1n, sqrtPriceLimitX96: 0n,
    });
    const { gasUsed } = await tx.wait();
    gasRows.push(["exactInputSingle (500 tokens)", Number(gasUsed), 400_000]);
    expect(gasUsed).to.be.lte(400_000, "large swap exceeded bound");
  });

  // ── 7. exactOutputSingle ───────────────────────────────────────────────────
  it("7. exactOutputSingle (10 token1 out) gas", async function () {
    const tx = await router.connect(trader).exactOutputSingle({
      tokenIn: token0.target, tokenOut: token1.target, fee: FEE,
      recipient: trader.address, deadline: await dl(),
      amountOut: ethers.parseEther("10"),
      amountInMaximum: ethers.parseEther("100"),
      sqrtPriceLimitX96: 0n,
    });
    const { gasUsed } = await tx.wait();
    gasRows.push(["exactOutputSingle", Number(gasUsed), 250_000]);
    expect(gasUsed).to.be.lte(250_000, "exactOutputSingle exceeded bound");
  });

  // ── 8. increaseLiquidity ───────────────────────────────────────────────────
  it("8. increaseLiquidity on position #1 gas", async function () {
    const tx = await pm.connect(lp1).increaseLiquidity({
      tokenId: 1,
      amount0Desired: ethers.parseEther("500"),
      amount1Desired: ethers.parseEther("500"),
      amount0Min: 0, amount1Min: 0,
      deadline: await dl(),
    });
    const { gasUsed } = await tx.wait();
    gasRows.push(["increaseLiquidity", Number(gasUsed), 350_000]);
    expect(gasUsed).to.be.lte(350_000, "increaseLiquidity exceeded bound");
  });

  // ── 9. decreaseLiquidity ──────────────────────────────────────────────────
  it("9. decreaseLiquidity (half of position #2) gas", async function () {
    const pos = await pm.positions(2);
    const tx = await pm.connect(lp2).decreaseLiquidity({
      tokenId: 2,
      liquidity: pos.liquidity / 2n,
      amount0Min: 0, amount1Min: 0,
      deadline: await dl(),
    });
    const { gasUsed } = await tx.wait();
    gasRows.push(["decreaseLiquidity (50%)", Number(gasUsed), 300_000]);
    expect(gasUsed).to.be.lte(300_000, "decreaseLiquidity exceeded bound");
  });

  // ── 10. collect ────────────────────────────────────────────────────────────
  it("10. collect fees on position #1 gas", async function () {
    // Trigger a few swaps to generate fees
    for (let i = 0; i < 3; i++) {
      await router.connect(trader).exactInputSingle({
        tokenIn: token0.target, tokenOut: token1.target, fee: FEE,
        recipient: trader.address, deadline: await dl(),
        amountIn: ethers.parseEther("20"), amountOutMinimum: 1n, sqrtPriceLimitX96: 0n,
      });
    }
    const tx = await pm.connect(lp1).collect({
      tokenId: 1, recipient: lp1.address,
      amount0Max: 2n ** 128n - 1n, amount1Max: 2n ** 128n - 1n,
    });
    const { gasUsed } = await tx.wait();
    gasRows.push(["collect fees", Number(gasUsed), 250_000]);
    expect(gasUsed).to.be.lte(250_000, "collect exceeded bound");
  });

  // ── 11. multi-hop swap ─────────────────────────────────────────────────────
  it("11. exactInput (multi-hop: token0 → token1 → tokenC) gas", async function () {
    // Setup second pool: token1 ↔ tokenC
    const [t1, tC] = token1.target.toLowerCase() < tokenC.target.toLowerCase()
      ? [token1, tokenC] : [tokenC, token1];

    await factory.createPool(t1.target, tC.target, FEE);
    const pool2Addr = await factory.getPool(t1.target, tC.target, FEE);
    pool2 = await ethers.getContractAt("Pool", pool2Addr);
    await pool2.initialize(Q96);

    // Seed pool2 with liquidity
    await token1.connect(lp1).approve(pm.target, ethers.MaxUint256);
    await tokenC.connect(lp1).approve(pm.target, ethers.MaxUint256);
    await pm.connect(lp1).mint({
      token0: t1.target, token1: tC.target, fee: FEE,
      tickLower: -TS * 200, tickUpper: TS * 200,
      amount0Desired: ethers.parseEther("5000"),
      amount1Desired: ethers.parseEther("5000"),
      amount0Min: 0, amount1Min: 0,
      recipient: lp1.address, deadline: await dl(),
    });

    // Multi-hop: token0 → token1 → tokenC
    const path = ethers.solidityPacked(
      ["address", "uint24", "address", "uint24", "address"],
      [token0.target, FEE, token1.target, FEE, tokenC.target]
    );

    const tx = await router.connect(trader).exactInput({
      path, recipient: trader.address, deadline: await dl(),
      amountIn: ethers.parseEther("10"),
      amountOutMinimum: 1n,
    });
    const { gasUsed } = await tx.wait();
    gasRows.push(["exactInput (multi-hop 2 pools)", Number(gasUsed), 500_000]);
    expect(gasUsed).to.be.lte(500_000, "multi-hop exceeded bound");
  });

  // ── Print table ─────────────────────────────────────────────────────────────
  after(function () {
    printTable(gasRows);

    // Summary statistics
    const total = gasRows.reduce((s, [, g]) => s + g, 0);
    const max   = Math.max(...gasRows.map(([, g]) => g));
    const min   = Math.min(...gasRows.map(([, g]) => g));
    console.log(`  Total gas across all ops : ${total.toLocaleString()}`);
    console.log(`  Max single operation     : ${max.toLocaleString()}`);
    console.log(`  Min single operation     : ${min.toLocaleString()}\n`);
  });
});
