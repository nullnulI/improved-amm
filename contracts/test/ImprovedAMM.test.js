const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const parse = ethers.parseEther;

describe("ImprovedAMM", function () {
  async function deployFixture() {
    const [owner, trader, other] = await ethers.getSigners();

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

    return { owner, trader, other, tokenA, tokenB, amm };
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

  it("accepts proportional follow-up liquidity", async function () {
    const { owner, trader, amm } = await deployFixture();
    await amm.connect(owner).addLiquidity(parse("1000"), parse("1000"), 1, await deadline());

    await expect(amm.connect(trader).addLiquidity(parse("100"), parse("100"), 1, await deadline()))
      .to.emit(amm, "LiquidityAdded");

    expect(await amm.reserve0()).to.equal(parse("1100"));
    expect(await amm.reserve1()).to.equal(parse("1100"));
  });

  it("rejects imbalanced follow-up liquidity", async function () {
    const { owner, trader, amm } = await deployFixture();
    await amm.connect(owner).addLiquidity(parse("1000"), parse("1000"), 1, await deadline());

    await expect(
      amm.connect(trader).addLiquidity(parse("100"), parse("200"), 1, await deadline())
    ).to.be.revertedWithCustomError(amm, "ImbalancedLiquidity");
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

  it("returns quote details with fee and price impact", async function () {
    const { owner, tokenA, amm } = await deployFixture();
    await amm.connect(owner).addLiquidity(parse("1000"), parse("1000"), 1, await deadline());

    const [amountOut, feeBps, priceImpactBps] = await amm.quoteSwapDetails(tokenA.target, parse("10"));

    expect(amountOut).to.equal(await amm.quoteSwap(tokenA.target, parse("10")));
    expect(feeBps).to.equal(30);
    expect(priceImpactBps).to.be.gt(0);
  });

  it("quotes and executes a reverse swap from token B to token A", async function () {
    const { owner, trader, tokenA, tokenB, amm } = await deployFixture();
    await amm.connect(owner).addLiquidity(parse("1000"), parse("1000"), 1, await deadline());

    const amountIn = parse("10");
    const quotedOut = await amm.quoteSwap(tokenB.target, amountIn);
    const before = await tokenA.balanceOf(trader.address);

    await expect(amm.connect(trader).swapExactIn(tokenB.target, amountIn, quotedOut, await deadline()))
      .to.emit(amm, "Swap")
      .withArgs(trader.address, tokenB.target, amountIn, quotedOut, 30);

    expect(await tokenA.balanceOf(trader.address)).to.equal(before + quotedOut);
    expect(await amm.reserve1()).to.equal(parse("1010"));
    expect(await amm.reserve0()).to.equal(parse("1000") - quotedOut);
  });

  it("reverts when a dust-sized quote rounds down to zero output", async function () {
    const { owner, tokenA, amm } = await deployFixture();
    await amm.connect(owner).addLiquidity(parse("1000"), parse("1000"), 1, await deadline());

    await expect(amm.quoteSwap(tokenA.target, 1)).to.be.revertedWithCustomError(amm, "InsufficientOutput");
  });

  it("reverts when a dust-sized swap would return zero output", async function () {
    const { owner, trader, tokenA, amm } = await deployFixture();
    await amm.connect(owner).addLiquidity(parse("1000"), parse("1000"), 1, await deadline());

    await expect(
      amm.connect(trader).swapExactIn(tokenA.target, 1, 0, await deadline())
    ).to.be.revertedWithCustomError(amm, "InsufficientOutput");
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

  it("applies the higher dynamic fee to large trade output", async function () {
    const { owner, tokenA, amm } = await deployFixture();
    await amm.connect(owner).addLiquidity(parse("1000"), parse("1000"), 1, await deadline());

    const amountIn = parse("100");
    const [amountOut, feeBps] = await amm.quoteSwapDetails(tokenA.target, amountIn);
    const pricedReserveIn = parse("1100");
    const pricedReserveOut = parse("1100");
    const amountInAfterLargeFee = (amountIn * 9950n) / 10000n;
    const amountInAfterBaseFee = (amountIn * 9970n) / 10000n;
    const expectedWithLargeFee =
      (amountInAfterLargeFee * pricedReserveOut) / (pricedReserveIn + amountInAfterLargeFee);
    const hypotheticalBaseFeeOut =
      (amountInAfterBaseFee * pricedReserveOut) / (pricedReserveIn + amountInAfterBaseFee);

    expect(feeBps).to.equal(50);
    expect(amountOut).to.equal(expectedWithLargeFee);
    expect(amountOut).to.be.lt(hypotheticalBaseFeeOut);
  });

  it("allows the owner to update bounded virtual reserves", async function () {
    const { owner, amm } = await deployFixture();
    await amm.connect(owner).addLiquidity(parse("1000"), parse("1000"), 1, await deadline());

    await expect(amm.connect(owner).updateVirtualReserves(parse("5000"), parse("5000")))
      .to.emit(amm, "VirtualReservesUpdated")
      .withArgs(parse("5000"), parse("5000"));

    expect(await amm.virtualReserve0()).to.equal(parse("5000"));
    expect(await amm.virtualReserve1()).to.equal(parse("5000"));
  });

  it("rejects non-owner or excessive virtual reserve updates", async function () {
    const { owner, trader, amm } = await deployFixture();
    await amm.connect(owner).addLiquidity(parse("1000"), parse("1000"), 1, await deadline());

    await expect(
      amm.connect(trader).updateVirtualReserves(parse("100"), parse("100"))
    ).to.be.revertedWithCustomError(amm, "OwnableUnauthorizedAccount").withArgs(trader.address);

    await expect(
      amm.connect(owner).updateVirtualReserves(parse("5001"), parse("100"))
    ).to.be.revertedWithCustomError(amm, "VirtualReserveTooLarge");
  });

  it("virtual reserves improve quote output for same-ratio liquidity", async function () {
    const { owner, tokenA, amm } = await deployFixture();
    await amm.connect(owner).addLiquidity(parse("1000"), parse("1000"), 1, await deadline());

    const before = await amm.quoteSwap(tokenA.target, parse("10"));
    await amm.connect(owner).updateVirtualReserves(parse("5000"), parse("5000"));
    const after = await amm.quoteSwap(tokenA.target, parse("10"));

    expect(after).to.be.gt(before);
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

  it("returns the exact proportional token balances when removing liquidity", async function () {
    const { owner, tokenA, tokenB, amm } = await deployFixture();
    await amm.connect(owner).addLiquidity(parse("1000"), parse("1000"), 1, await deadline());

    const liquidity = (await amm.balanceOf(owner.address)) / 4n;
    const totalLp = await amm.totalSupply();
    const expected0 = (liquidity * (await amm.reserve0())) / totalLp;
    const expected1 = (liquidity * (await amm.reserve1())) / totalLp;
    const before0 = await tokenA.balanceOf(owner.address);
    const before1 = await tokenB.balanceOf(owner.address);

    await amm.connect(owner).removeLiquidity(liquidity, expected0, expected1, await deadline());

    expect(await tokenA.balanceOf(owner.address)).to.equal(before0 + expected0);
    expect(await tokenB.balanceOf(owner.address)).to.equal(before1 + expected1);
  });

  it("rejects invalid tokens, zero amounts, and empty-pool swaps", async function () {
    const { tokenA, tokenB, amm } = await deployFixture();

    await expect(amm.quoteSwap(tokenA.target, 0)).to.be.revertedWithCustomError(amm, "InvalidAmount");
    await expect(amm.quoteSwap(tokenB.target, parse("1"))).to.be.revertedWithCustomError(
      amm,
      "InsufficientLiquidity"
    );
    await expect(amm.quoteSwap(ethers.ZeroAddress, parse("1"))).to.be.revertedWithCustomError(amm, "InvalidToken");
  });
});
