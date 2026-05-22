const { expect } = require("chai");
const { ethers } = require("hardhat");

const Q96 = 2n ** 96n;
const FEE  = 3000;          // 0.3%
const TICK_SPACING = 60;

// sqrt(1) * Q96 → tick 0 initial price (token0 : token1 = 1 : 1)
const INITIAL_SQRT_PRICE = Q96;

async function deadline() {
  const b = await ethers.provider.getBlock("latest");
  return b.timestamp + 3600;
}

describe("Pool (Concentrated Liquidity)", function () {
  let owner, alice, bob;
  let tokenA, tokenB, factory, pool;
  let token0, token1; // sorted order

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    tokenA = await MockERC20.deploy("Token A", "TKA");
    tokenB = await MockERC20.deploy("Token B", "TKB");

    const PoolFactory = await ethers.getContractFactory("PoolFactory");
    factory = await PoolFactory.deploy();

    await factory.createPool(tokenA.target, tokenB.target, FEE);
    const poolAddr = await factory.getPool(tokenA.target, tokenB.target, FEE);
    pool = await ethers.getContractAt("Pool", poolAddr);

    // Determine sorted token order
    if (tokenA.target.toLowerCase() < tokenB.target.toLowerCase()) {
      token0 = tokenA; token1 = tokenB;
    } else {
      token0 = tokenB; token1 = tokenA;
    }

    // Mint tokens to users
    const SUPPLY = ethers.parseEther("1000000");
    for (const user of [owner, alice, bob]) {
      await token0.mint(user.address, SUPPLY);
      await token1.mint(user.address, SUPPLY);
    }

    await pool.initialize(INITIAL_SQRT_PRICE);
  });

  describe("initialize", function () {
    it("sets sqrtPriceX96 and tick", async function () {
      const s = await pool.slot0();
      expect(s.sqrtPriceX96).to.equal(INITIAL_SQRT_PRICE);
      expect(s.tick).to.equal(0);
    });

    it("reverts on double-initialize", async function () {
      await expect(pool.initialize(INITIAL_SQRT_PRICE)).to.be.revertedWithCustomError(pool, "AlreadyInitialized");
    });
  });

  describe("mint via PositionManager", function () {
    let pm;

    beforeEach(async function () {
      const PM = await ethers.getContractFactory("PositionManager");
      pm = await PM.deploy(factory.target);

      // Approve PM for both tokens
      const MAX = ethers.MaxUint256;
      for (const user of [alice, bob]) {
        await token0.connect(user).approve(pm.target, MAX);
        await token1.connect(user).approve(pm.target, MAX);
      }
    });

    it("mints a position NFT and adds liquidity", async function () {
      const amount = ethers.parseEther("100");
      const dl = await deadline();

      const tx = await pm.connect(alice).mint({
        token0: token0.target,
        token1: token1.target,
        fee: FEE,
        tickLower: -TICK_SPACING * 10,
        tickUpper:  TICK_SPACING * 10,
        amount0Desired: amount,
        amount1Desired: amount,
        amount0Min: 0,
        amount1Min: 0,
        recipient: alice.address,
        deadline: dl
      });

      await expect(tx).to.emit(pm, "IncreaseLiquidity");
      expect(await pm.balanceOf(alice.address)).to.equal(1);
      expect(await pm.ownerOf(1)).to.equal(alice.address);
    });

    it("pool has non-zero liquidity after mint", async function () {
      const amount = ethers.parseEther("1000");
      await pm.connect(alice).mint({
        token0: token0.target, token1: token1.target, fee: FEE,
        tickLower: -TICK_SPACING * 100, tickUpper: TICK_SPACING * 100,
        amount0Desired: amount, amount1Desired: amount,
        amount0Min: 0, amount1Min: 0,
        recipient: alice.address, deadline: await deadline()
      });
      expect(await pool.liquidity()).to.be.gt(0);
    });

    it("two LPs can hold separate ranges", async function () {
      const amount = ethers.parseEther("500");
      const dl = await deadline();

      await pm.connect(alice).mint({
        token0: token0.target, token1: token1.target, fee: FEE,
        tickLower: -TICK_SPACING * 50, tickUpper: TICK_SPACING * 50,
        amount0Desired: amount, amount1Desired: amount,
        amount0Min: 0, amount1Min: 0,
        recipient: alice.address, deadline: dl
      });
      // Range entirely below current price (tick 0) → only token1 needed
      await pm.connect(bob).mint({
        token0: token0.target, token1: token1.target, fee: FEE,
        tickLower: -TICK_SPACING * 100, tickUpper: -TICK_SPACING * 51,
        amount0Desired: 0, amount1Desired: amount,
        amount0Min: 0, amount1Min: 0,
        recipient: bob.address, deadline: dl
      });

      expect(await pm.balanceOf(alice.address)).to.equal(1);
      expect(await pm.balanceOf(bob.address)).to.equal(1);
    });
  });

  describe("swap via SwapRouter", function () {
    let pm, router;

    beforeEach(async function () {
      const PM     = await ethers.getContractFactory("PositionManager");
      const Router = await ethers.getContractFactory("SwapRouter");
      pm     = await PM.deploy(factory.target);
      router = await Router.deploy(factory.target);

      const MAX = ethers.MaxUint256;
      for (const user of [alice, bob]) {
        await token0.connect(user).approve(pm.target, MAX);
        await token1.connect(user).approve(pm.target, MAX);
        await token0.connect(user).approve(router.target, MAX);
        await token1.connect(user).approve(router.target, MAX);
      }

      // Seed pool with liquidity
      await pm.connect(alice).mint({
        token0: token0.target, token1: token1.target, fee: FEE,
        tickLower: -TICK_SPACING * 200, tickUpper: TICK_SPACING * 200,
        amount0Desired: ethers.parseEther("5000"),
        amount1Desired: ethers.parseEther("5000"),
        amount0Min: 0, amount1Min: 0,
        recipient: alice.address, deadline: await deadline()
      });
    });

    it("exact input single: token0 → token1", async function () {
      const amountIn = ethers.parseEther("10");
      const before = await token1.balanceOf(bob.address);

      await router.connect(bob).exactInputSingle({
        tokenIn:           token0.target,
        tokenOut:          token1.target,
        fee:               FEE,
        recipient:         bob.address,
        deadline:          await deadline(),
        amountIn:          amountIn,
        amountOutMinimum:  1n,
        sqrtPriceLimitX96: 0n
      });

      const after = await token1.balanceOf(bob.address);
      expect(after - before).to.be.gt(0);
    });

    it("exact input single: token1 → token0", async function () {
      const amountIn = ethers.parseEther("10");
      const before = await token0.balanceOf(bob.address);

      await router.connect(bob).exactInputSingle({
        tokenIn:           token1.target,
        tokenOut:          token0.target,
        fee:               FEE,
        recipient:         bob.address,
        deadline:          await deadline(),
        amountIn:          amountIn,
        amountOutMinimum:  1n,
        sqrtPriceLimitX96: 0n
      });

      expect(await token0.balanceOf(bob.address) - before).to.be.gt(0);
    });

    it("reverts when amountOutMinimum not met", async function () {
      await expect(
        router.connect(bob).exactInputSingle({
          tokenIn: token0.target, tokenOut: token1.target, fee: FEE,
          recipient: bob.address, deadline: await deadline(),
          amountIn: ethers.parseEther("1"),
          amountOutMinimum: ethers.parseEther("100000"),
          sqrtPriceLimitX96: 0n
        })
      ).to.be.revertedWithCustomError(router, "TooLittleReceived");
    });

    it("swapping changes pool price", async function () {
      const s0 = await pool.slot0();
      await router.connect(bob).exactInputSingle({
        tokenIn: token0.target, tokenOut: token1.target, fee: FEE,
        recipient: bob.address, deadline: await deadline(),
        amountIn: ethers.parseEther("500"),
        amountOutMinimum: 1n, sqrtPriceLimitX96: 0n
      });
      const s1 = await pool.slot0();
      expect(s1.sqrtPriceX96).to.not.equal(s0.sqrtPriceX96);
    });
  });

  describe("burn and collect fees", function () {
    let pm, router;

    beforeEach(async function () {
      const PM     = await ethers.getContractFactory("PositionManager");
      const Router = await ethers.getContractFactory("SwapRouter");
      pm     = await PM.deploy(factory.target);
      router = await Router.deploy(factory.target);

      const MAX = ethers.MaxUint256;
      for (const user of [alice, bob]) {
        await token0.connect(user).approve(pm.target, MAX);
        await token1.connect(user).approve(pm.target, MAX);
        await token0.connect(user).approve(router.target, MAX);
        await token1.connect(user).approve(router.target, MAX);
      }

      await pm.connect(alice).mint({
        token0: token0.target, token1: token1.target, fee: FEE,
        tickLower: -TICK_SPACING * 100, tickUpper: TICK_SPACING * 100,
        amount0Desired: ethers.parseEther("2000"),
        amount1Desired: ethers.parseEther("2000"),
        amount0Min: 0, amount1Min: 0,
        recipient: alice.address, deadline: await deadline()
      });
    });

    it("LP can decrease liquidity and collect tokens", async function () {
      const posData = await pm.positions(1);
      const half = posData.liquidity / 2n;

      await pm.connect(alice).decreaseLiquidity({
        tokenId: 1, liquidity: half,
        amount0Min: 0, amount1Min: 0, deadline: await deadline()
      });

      const before0 = await token0.balanceOf(alice.address);
      const before1 = await token1.balanceOf(alice.address);

      await pm.connect(alice).collect({
        tokenId: 1, recipient: alice.address,
        amount0Max: ethers.MaxUint256 >> 128n,
        amount1Max: ethers.MaxUint256 >> 128n
      });

      expect(await token0.balanceOf(alice.address)).to.be.gte(before0);
      expect(await token1.balanceOf(alice.address)).to.be.gte(before1);
    });

    it("generates fees after swaps", async function () {
      // Do several swaps to generate fees
      for (let i = 0; i < 5; i++) {
        await router.connect(bob).exactInputSingle({
          tokenIn: token0.target, tokenOut: token1.target, fee: FEE,
          recipient: bob.address, deadline: await deadline(),
          amountIn: ethers.parseEther("50"),
          amountOutMinimum: 1n, sqrtPriceLimitX96: 0n
        });
      }

      const before0 = await token0.balanceOf(alice.address);
      const before1 = await token1.balanceOf(alice.address);

      await pm.connect(alice).collect({
        tokenId: 1, recipient: alice.address,
        amount0Max: ethers.MaxUint256 >> 128n,
        amount1Max: ethers.MaxUint256 >> 128n
      });

      const after0 = await token0.balanceOf(alice.address);
      const after1 = await token1.balanceOf(alice.address);

      // At least one side should have fee income
      expect(after0 + after1).to.be.gt(before0 + before1);
    });
  });

  describe("TWAP oracle", function () {
    let pm, router;

    beforeEach(async function () {
      const PM     = await ethers.getContractFactory("PositionManager");
      const Router = await ethers.getContractFactory("SwapRouter");
      pm     = await PM.deploy(factory.target);
      router = await Router.deploy(factory.target);

      const MAX = ethers.MaxUint256;
      for (const user of [alice]) {
        await token0.connect(user).approve(pm.target, MAX);
        await token1.connect(user).approve(pm.target, MAX);
        await token0.connect(user).approve(router.target, MAX);
        await token1.connect(user).approve(router.target, MAX);
      }

      await pm.connect(alice).mint({
        token0: token0.target, token1: token1.target, fee: FEE,
        tickLower: -TICK_SPACING * 100, tickUpper: TICK_SPACING * 100,
        amount0Desired: ethers.parseEther("1000"),
        amount1Desired: ethers.parseEther("1000"),
        amount0Min: 0, amount1Min: 0,
        recipient: alice.address, deadline: await deadline()
      });
    });

    it("getTWAP returns a tick after time elapses", async function () {
      // Move time forward
      await ethers.provider.send("evm_increaseTime", [300]);
      await ethers.provider.send("evm_mine");

      // Do a swap to update oracle
      await router.connect(alice).exactInputSingle({
        tokenIn: token0.target, tokenOut: token1.target, fee: FEE,
        recipient: alice.address, deadline: await deadline(),
        amountIn: ethers.parseEther("10"),
        amountOutMinimum: 1n, sqrtPriceLimitX96: 0n
      });

      await ethers.provider.send("evm_increaseTime", [300]);
      await ethers.provider.send("evm_mine");

      const twapTick = await pool.getTWAP(300);
      expect(twapTick).to.be.a("bigint");
    });
  });
});
