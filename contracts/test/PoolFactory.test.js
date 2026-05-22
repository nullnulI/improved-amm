const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PoolFactory", function () {
  let alice;
  let tokenA, tokenB, factory;

  beforeEach(async function () {
    [, alice] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    tokenA = await MockERC20.deploy("Token A", "TKA");
    tokenB = await MockERC20.deploy("Token B", "TKB");

    const PoolFactory = await ethers.getContractFactory("PoolFactory");
    factory = await PoolFactory.deploy();
  });

  it("registers the default fee tiers on deployment", async function () {
    // These are the standard tiers pre-enabled by the constructor.
    expect(await factory.feeAmountTickSpacing(500)).to.equal(10);
    expect(await factory.feeAmountTickSpacing(3000)).to.equal(60);
    expect(await factory.feeAmountTickSpacing(10000)).to.equal(200);
  });

  it("lets the owner enable a new fee tier", async function () {
    await expect(factory.enableFeeAmount(2500, 50))
      .to.emit(factory, "FeeAmountEnabled")
      .withArgs(2500, 50);

    expect(await factory.feeAmountTickSpacing(2500)).to.equal(50);
  });

  it("rejects fee-tier updates from non-owners", async function () {
    await expect(factory.connect(alice).enableFeeAmount(2500, 50))
      .to.be.revertedWith("NOT_OWNER");
  });

  it("stores the same pool address for both token orderings", async function () {
    await factory.createPool(tokenA.target, tokenB.target, 3000);

    const poolAB = await factory.getPool(tokenA.target, tokenB.target, 3000);
    const poolBA = await factory.getPool(tokenB.target, tokenA.target, 3000);

    expect(poolAB).to.equal(poolBA);
    expect(poolAB).to.not.equal(ethers.ZeroAddress);
  });
});
