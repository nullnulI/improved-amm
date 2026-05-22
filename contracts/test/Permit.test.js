const { expect } = require("chai");
const { ethers } = require("hardhat");

/// @notice EIP-2612 permit on MockERC20 + SelfPermit/Multicall on the periphery.
///         Demonstrates signature-based approvals and atomic approve+act in one tx.
describe("EIP-2612 Permit + SelfPermit (Multicall)", function () {
  let owner, alice;
  let token0, token1, factory, pool, pm, router;

  const FEE = 3000;
  const TS  = 60;
  const Q96 = 2n ** 96n;

  async function dl() {
    return (await ethers.provider.getBlock("latest")).timestamp + 3600;
  }

  // Build and sign an EIP-2612 permit. OZ's ERC20Permit uses EIP-712 domain version "1".
  async function signPermit(token, signer, spender, value, deadline) {
    const [name, nonce, network] = await Promise.all([
      token.name(),
      token.nonces(signer.address),
      ethers.provider.getNetwork(),
    ]);
    const domain = {
      name,
      version: "1",
      chainId: network.chainId,
      verifyingContract: token.target,
    };
    const types = {
      Permit: [
        { name: "owner",    type: "address" },
        { name: "spender",  type: "address" },
        { name: "value",    type: "uint256" },
        { name: "nonce",    type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const message = { owner: signer.address, spender, value, nonce, deadline };
    const sig = await signer.signTypedData(domain, types, message);
    return ethers.Signature.from(sig);
  }

  beforeEach(async function () {
    [owner, alice] = await ethers.getSigners();

    const MockERC20   = await ethers.getContractFactory("MockERC20");
    const PoolFactory = await ethers.getContractFactory("PoolFactory");
    const PM          = await ethers.getContractFactory("PositionManager");
    const Router      = await ethers.getContractFactory("SwapRouter");

    const ta = await MockERC20.deploy("TokenA", "TKA");
    const tb = await MockERC20.deploy("TokenB", "TKB");
    factory  = await PoolFactory.deploy();
    pm       = await PM.deploy(factory.target);
    router   = await Router.deploy(factory.target);

    [token0, token1] = ta.target.toLowerCase() < tb.target.toLowerCase() ? [ta, tb] : [tb, ta];

    // Seed deep liquidity from owner (uses normal approve — unrelated to permit path under test)
    const BIG = ethers.parseEther("100000000");
    await token0.mint(owner.address, BIG);
    await token1.mint(owner.address, BIG);
    await token0.approve(pm.target, ethers.MaxUint256);
    await token1.approve(pm.target, ethers.MaxUint256);

    await factory.createPool(token0.target, token1.target, FEE);
    pool = await ethers.getContractAt("Pool", await factory.getPool(token0.target, token1.target, FEE));
    await pool.initialize(Q96); // price = 1
    await pm.mint({
      token0: token0.target, token1: token1.target, fee: FEE,
      tickLower: -TS * 500, tickUpper: TS * 500,
      amount0Desired: ethers.parseEther("1000000"),
      amount1Desired: ethers.parseEther("1000000"),
      amount0Min: 0, amount1Min: 0,
      recipient: owner.address, deadline: await dl(),
    });
  });

  it("permit() grants allowance from a signature and bumps the nonce", async function () {
    const value = ethers.parseEther("500");
    const deadline = await dl();
    const sig = await signPermit(token0, alice, router.target, value, deadline);

    expect(await token0.allowance(alice.address, router.target)).to.equal(0n);
    expect(await token0.nonces(alice.address)).to.equal(0n);

    await token0.permit(alice.address, router.target, value, deadline, sig.v, sig.r, sig.s);

    expect(await token0.allowance(alice.address, router.target)).to.equal(value);
    expect(await token0.nonces(alice.address)).to.equal(1n);
  });

  it("permit() reverts on an expired deadline", async function () {
    const value = ethers.parseEther("500");
    const past  = (await ethers.provider.getBlock("latest")).timestamp - 1;
    const sig = await signPermit(token0, alice, router.target, value, past);

    await expect(
      token0.permit(alice.address, router.target, value, past, sig.v, sig.r, sig.s)
    ).to.be.revertedWithCustomError(token0, "ERC2612ExpiredSignature");
  });

  it("permit() reverts when the signed terms are tampered with", async function () {
    const value = ethers.parseEther("500");
    const deadline = await dl();
    const sig = await signPermit(token0, alice, router.target, value, deadline);

    // Submit a different value than was signed -> recovered signer mismatches.
    await expect(
      token0.permit(alice.address, router.target, value + 1n, deadline, sig.v, sig.r, sig.s)
    ).to.be.revertedWithCustomError(token0, "ERC2612InvalidSigner");
  });

  it("selfPermit + exactInputSingle execute in ONE multicall with no prior approve", async function () {
    await token0.mint(alice.address, ethers.parseEther("1000"));
    const amountIn = ethers.parseEther("100");
    const deadline = await dl();
    const sig = await signPermit(token0, alice, router.target, amountIn, deadline);

    const permitData = router.interface.encodeFunctionData("selfPermit", [
      token0.target, amountIn, deadline, sig.v, sig.r, sig.s,
    ]);
    const swapData = router.interface.encodeFunctionData("exactInputSingle", [{
      tokenIn: token0.target, tokenOut: token1.target, fee: FEE,
      recipient: alice.address, deadline,
      amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n,
    }]);

    expect(await token0.allowance(alice.address, router.target)).to.equal(0n);
    const before = await token1.balanceOf(alice.address);

    await router.connect(alice).multicall([permitData, swapData]);

    expect((await token1.balanceOf(alice.address)) - before).to.be.gt(0n);
    // Allowance was set to amountIn then fully consumed by the swap's transferFrom.
    expect(await token0.allowance(alice.address, router.target)).to.equal(0n);
  });

  it("selfPermitIfNecessary is a no-op when allowance already covers the value", async function () {
    const value = ethers.parseEther("100");
    const deadline = await dl();
    await token0.connect(alice).approve(router.target, value); // pre-existing allowance

    const sig = await signPermit(token0, alice, router.target, value, deadline);
    await router.connect(alice).selfPermitIfNecessary(
      token0.target, value, deadline, sig.v, sig.r, sig.s
    );

    // Permit was skipped, so the nonce is untouched and the signature remains usable.
    expect(await token0.nonces(alice.address)).to.equal(0n);
  });

  it("selfPermit (x2) + mint execute in ONE multicall with no prior approve", async function () {
    await token0.mint(alice.address, ethers.parseEther("10000"));
    await token1.mint(alice.address, ethers.parseEther("10000"));
    const amt = ethers.parseEther("1000");
    const deadline = await dl();

    const sig0 = await signPermit(token0, alice, pm.target, amt, deadline);
    const sig1 = await signPermit(token1, alice, pm.target, amt, deadline);

    const p0 = pm.interface.encodeFunctionData("selfPermit", [token0.target, amt, deadline, sig0.v, sig0.r, sig0.s]);
    const p1 = pm.interface.encodeFunctionData("selfPermit", [token1.target, amt, deadline, sig1.v, sig1.r, sig1.s]);
    const mintData = pm.interface.encodeFunctionData("mint", [{
      token0: token0.target, token1: token1.target, fee: FEE,
      tickLower: -TS * 10, tickUpper: TS * 10,
      amount0Desired: amt, amount1Desired: amt,
      amount0Min: 0, amount1Min: 0,
      recipient: alice.address, deadline,
    }]);

    expect(await token0.allowance(alice.address, pm.target)).to.equal(0n);
    await pm.connect(alice).multicall([p0, p1, mintData]);

    expect(await pm.balanceOf(alice.address)).to.equal(1n);
  });
});
