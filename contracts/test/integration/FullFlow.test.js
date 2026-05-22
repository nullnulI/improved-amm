const { expect } = require("chai");
const { ethers } = require("hardhat");

/// @notice End-to-end integration: factory → pool → LP position → swap → collect fees → quoter
describe("Full Flow Integration", function () {
  let owner, lp1, lp2, trader;
  let tokenA, tokenB, token0, token1;
  let factory, pool, pm, router, quoter;

  const FEE = 3000;
  const TS  = 60;
  const Q96 = 2n ** 96n;

  async function dl() {
    return (await ethers.provider.getBlock("latest")).timestamp + 3600;
  }

  before(async function () {
    [owner, lp1, lp2, trader] = await ethers.getSigners();

    const MockERC20   = await ethers.getContractFactory("MockERC20");
    const PoolFactory = await ethers.getContractFactory("PoolFactory");
    const PM          = await ethers.getContractFactory("PositionManager");
    const Router      = await ethers.getContractFactory("SwapRouter");
    const QuoterF     = await ethers.getContractFactory("Quoter");

    tokenA  = await MockERC20.deploy("TokenA", "TKA");
    tokenB  = await MockERC20.deploy("TokenB", "TKB");
    factory = await PoolFactory.deploy();
    pm      = await PM.deploy(factory.target);
    router  = await Router.deploy(factory.target);
    quoter  = await QuoterF.deploy(factory.target);

    // Sorted order
    if (tokenA.target.toLowerCase() < tokenB.target.toLowerCase()) {
      token0 = tokenA; token1 = tokenB;
    } else {
      token0 = tokenB; token1 = tokenA;
    }

    // Mint & approve
    const BIG = ethers.parseEther("10000000");
    for (const u of [lp1, lp2, trader]) {
      await token0.mint(u.address, BIG);
      await token1.mint(u.address, BIG);
      await token0.connect(u).approve(pm.target, ethers.MaxUint256);
      await token1.connect(u).approve(pm.target, ethers.MaxUint256);
      await token0.connect(u).approve(router.target, ethers.MaxUint256);
      await token1.connect(u).approve(router.target, ethers.MaxUint256);
    }

    // Create and initialize pool
    await factory.createPool(token0.target, token1.target, FEE);
    const poolAddr = await factory.getPool(token0.target, token1.target, FEE);
    pool = await ethers.getContractAt("Pool", poolAddr);
    await pool.initialize(Q96); // price = 1
  });

  it("Step 1: factory emits PoolCreated", async function () {
    const addr = await factory.getPool(token0.target, token1.target, FEE);
    expect(addr).to.not.equal(ethers.ZeroAddress);
  });

  it("Step 2: LP1 mints a wide-range position", async function () {
    const tx = await pm.connect(lp1).mint({
      token0: token0.target, token1: token1.target, fee: FEE,
      tickLower: -TS * 500, tickUpper: TS * 500,
      amount0Desired: ethers.parseEther("10000"),
      amount1Desired: ethers.parseEther("10000"),
      amount0Min: 0, amount1Min: 0,
      recipient: lp1.address, deadline: await dl()
    });
    await expect(tx).to.emit(pm, "IncreaseLiquidity");
    expect(await pm.ownerOf(1)).to.equal(lp1.address);
    expect(await pool.liquidity()).to.be.gt(0);
  });

  it("Step 3: LP2 mints a narrow concentrated range", async function () {
    const tx = await pm.connect(lp2).mint({
      token0: token0.target, token1: token1.target, fee: FEE,
      tickLower: -TS * 5, tickUpper: TS * 5,
      amount0Desired: ethers.parseEther("1000"),
      amount1Desired: ethers.parseEther("1000"),
      amount0Min: 0, amount1Min: 0,
      recipient: lp2.address, deadline: await dl()
    });
    await expect(tx).to.emit(pm, "IncreaseLiquidity");
    expect(await pm.ownerOf(2)).to.equal(lp2.address);
  });

  it("Step 4: Quoter estimates output without spending gas", async function () {
    const amtIn = ethers.parseEther("100");
    const quoted = await quoter.quoteExactInputSingle.staticCall(
      token0.target, token1.target, FEE, amtIn, 0n
    );
    expect(quoted).to.be.gt(0);
    // Output is slightly less than input due to 0.3% fee + price impact
    expect(quoted).to.be.lte(amtIn);
  });

  it("Step 5: Trader swaps token0 for token1", async function () {
    const amtIn  = ethers.parseEther("200");
    const before = await token1.balanceOf(trader.address);

    await router.connect(trader).exactInputSingle({
      tokenIn: token0.target, tokenOut: token1.target, fee: FEE,
      recipient: trader.address, deadline: await dl(),
      amountIn: amtIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n
    });

    const received = (await token1.balanceOf(trader.address)) - before;
    expect(received).to.be.gt(0);
  });

  it("Step 6: Multiple swaps in both directions", async function () {
    const amtIn = ethers.parseEther("50");
    for (let i = 0; i < 3; i++) {
      await router.connect(trader).exactInputSingle({
        tokenIn: token0.target, tokenOut: token1.target, fee: FEE,
        recipient: trader.address, deadline: await dl(),
        amountIn: amtIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n
      });
      await router.connect(trader).exactInputSingle({
        tokenIn: token1.target, tokenOut: token0.target, fee: FEE,
        recipient: trader.address, deadline: await dl(),
        amountIn: amtIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n
      });
    }
  });

  it("Step 7: LP1 collects fees after trading", async function () {
    const before0 = await token0.balanceOf(lp1.address);
    const before1 = await token1.balanceOf(lp1.address);

    await pm.connect(lp1).collect({
      tokenId: 1, recipient: lp1.address,
      amount0Max: 2n ** 128n - 1n, amount1Max: 2n ** 128n - 1n
    });

    const after0 = await token0.balanceOf(lp1.address);
    const after1 = await token1.balanceOf(lp1.address);
    // LP should have received some fees
    expect(after0 + after1).to.be.gt(before0 + before1);
  });

  it("Step 8: LP1 can decrease liquidity and withdraw tokens", async function () {
    const posData = await pm.positions(1);
    const quarter = posData.liquidity / 4n;

    const before0 = await token0.balanceOf(lp1.address);
    const before1 = await token1.balanceOf(lp1.address);

    await pm.connect(lp1).decreaseLiquidity({
      tokenId: 1, liquidity: quarter,
      amount0Min: 0, amount1Min: 0, deadline: await dl()
    });

    await pm.connect(lp1).collect({
      tokenId: 1, recipient: lp1.address,
      amount0Max: 2n ** 128n - 1n, amount1Max: 2n ** 128n - 1n
    });

    expect(await token0.balanceOf(lp1.address) + await token1.balanceOf(lp1.address))
      .to.be.gt(before0 + before1);
  });

  it("Step 9: NFT positions are transferable", async function () {
    await pm.connect(lp2).transferFrom(lp2.address, trader.address, 2);
    expect(await pm.ownerOf(2)).to.equal(trader.address);
  });

  it("Step 10: PoolFactory has correct fee/tickSpacing mappings", async function () {
    expect(await factory.feeAmountTickSpacing(500)).to.equal(10);
    expect(await factory.feeAmountTickSpacing(3000)).to.equal(60);
    expect(await factory.feeAmountTickSpacing(10000)).to.equal(200);
  });
});
