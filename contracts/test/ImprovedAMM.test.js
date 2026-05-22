const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const parse = ethers.parseEther;

describe("ImprovedAMM", function () {
  async function deployFixture() {
    const [owner, trader] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const tokenA = await MockERC20.deploy("Course Token A", "CTA");
    const tokenB = await MockERC20.deploy("Course Token B", "CTB");

    const ImprovedAMM = await ethers.getContractFactory("ImprovedAMM");
    const amm = await ImprovedAMM.deploy(tokenA.target, tokenB.target, parse("100"), parse("100"));

    for (const account of [owner, trader]) {
      await tokenA.mint(account.address, parse("10000"));
      await tokenB.mint(account.address, parse("10000"));
      await tokenA.connect(account).approve(amm.target, parse("10000"));
      await tokenB.connect(account).approve(amm.target, parse("10000"));
    }

    return { owner, trader, tokenA, tokenB, amm };
  }

  async function deadline() {
    const block = await ethers.provider.getBlock("latest");
    return block.timestamp + 3600;
  }

  it("mints ERC20 tokens and supports transferFrom via approval", async function () {
    const { owner, trader, tokenA } = await deployFixture();

    await tokenA.connect(owner).approve(trader.address, parse("1"));
    await tokenA.connect(trader).transferFrom(owner.address, trader.address, parse("1"));

    expect(await tokenA.balanceOf(trader.address)).to.equal(parse("10001"));
  });

  it("adds initial liquidity and updates reserves", async function () {
    const { owner, amm } = await deployFixture();

    await expect(amm.connect(owner).addLiquidity(parse("1000"), parse("1000"), 1, await deadline()))
      .to.emit(amm, "LiquidityAdded");

    expect(await amm.reserve0()).to.equal(parse("1000"));
    expect(await amm.reserve1()).to.equal(parse("1000"));
    expect(await amm.balanceOf(owner.address)).to.be.gt(0);
  });

  it("quotes and executes a swap with slippage protection", async function () {
    const { owner, trader, tokenA, tokenB, amm } = await deployFixture();
    await amm.connect(owner).addLiquidity(parse("1000"), parse("1000"), 1, await deadline());

    const amountIn = parse("10");
    const quotedOut = await amm.quoteSwap(tokenA.target, amountIn);
    const before = await tokenB.balanceOf(trader.address);

    await expect(amm.connect(trader).swapExactIn(tokenA.target, amountIn, quotedOut, await deadline()))
      .to.emit(amm, "Swap")
      .withArgs(trader.address, tokenA.target, amountIn, quotedOut, 30);

    expect(await tokenB.balanceOf(trader.address)).to.equal(before + quotedOut);
    expect(await amm.reserve0()).to.equal(parse("1010"));
    expect(await amm.reserve1()).to.equal(parse("1000") - quotedOut);
  });

  it("reverts when minAmountOut is too high", async function () {
    const { owner, trader, tokenA, amm } = await deployFixture();
    await amm.connect(owner).addLiquidity(parse("1000"), parse("1000"), 1, await deadline());

    const quotedOut = await amm.quoteSwap(tokenA.target, parse("10"));

    await expect(
      amm.connect(trader).swapExactIn(tokenA.target, parse("10"), quotedOut + 1n, await deadline())
    ).to.be.revertedWithCustomError(amm, "InsufficientOutput");
  });

  it("reverts when deadline has passed", async function () {
    const { owner, amm } = await deployFixture();
    const oldDeadline = (await ethers.provider.getBlock("latest")).timestamp - 1;

    await expect(
      amm.connect(owner).addLiquidity(parse("1000"), parse("1000"), 1, oldDeadline)
    ).to.be.revertedWithCustomError(amm, "Expired");
  });

  it("charges a higher fee for large trades", async function () {
    const { owner, tokenA, amm } = await deployFixture();
    await amm.connect(owner).addLiquidity(parse("1000"), parse("1000"), 1, await deadline());

    expect(await amm.currentFeeBps(tokenA.target, parse("99"))).to.equal(30);
    expect(await amm.currentFeeBps(tokenA.target, parse("100"))).to.equal(50);
  });

  it("removes liquidity proportionally", async function () {
    const { owner, amm } = await deployFixture();
    await amm.connect(owner).addLiquidity(parse("1000"), parse("1000"), 1, await deadline());

    const liquidity = (await amm.balanceOf(owner.address)) / 2n;
    await expect(amm.connect(owner).removeLiquidity(liquidity, 1, 1, await deadline()))
      .to.emit(amm, "LiquidityRemoved");

    expect(await amm.balanceOf(owner.address)).to.be.gt(0);
    expect(await amm.reserve0()).to.be.lt(parse("1000"));
    expect(await amm.reserve1()).to.be.lt(parse("1000"));
  });
});
