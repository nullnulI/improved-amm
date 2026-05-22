/**
 * @title Permit Batching Gas Comparison
 * @notice Documents the gas cost of the EIP-2612 permit + Multicall feature against the
 *         classic approve-then-act flow. Maps to the "batch operations" and
 *         "document gas costs" requirements.
 *
 *   Swap : approve + exactInputSingle (2 tx)  vs  multicall(selfPermit, swap)        (1 tx)
 *   Mint : approve x2 + mint        (3 tx)     vs  multicall(selfPermit x2, mint)     (1 tx)
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

const Q96 = 2n ** 96n;
const FEE = 3000;
const TS  = 60;

async function dl() {
  return (await ethers.provider.getBlock("latest")).timestamp + 3600;
}

async function signPermit(token, signer, spender, value, deadline) {
  const [name, nonce, net] = await Promise.all([
    token.name(), token.nonces(signer.address), ethers.provider.getNetwork(),
  ]);
  const domain = { name, version: "1", chainId: net.chainId, verifyingContract: token.target };
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
  return ethers.Signature.from(await signer.signTypedData(domain, types, message));
}

describe("Gas: permit batching vs classic approve flow", function () {
  this.timeout(120_000);

  let owner, swapClassic, swapPermit, mintClassic, mintPermit;
  let token0, token1, factory, pool, pm, router;

  before(async function () {
    [owner, swapClassic, swapPermit, mintClassic, mintPermit] = await ethers.getSigners();

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

    await token0.mint(owner.address, ethers.parseEther("100000000"));
    await token1.mint(owner.address, ethers.parseEther("100000000"));
    await token0.approve(pm.target, ethers.MaxUint256);
    await token1.approve(pm.target, ethers.MaxUint256);
    await factory.createPool(token0.target, token1.target, FEE);
    pool = await ethers.getContractAt("Pool", await factory.getPool(token0.target, token1.target, FEE));
    await pool.initialize(Q96);
    await pm.mint({
      token0: token0.target, token1: token1.target, fee: FEE,
      tickLower: -TS * 500, tickUpper: TS * 500,
      amount0Desired: ethers.parseEther("1000000"),
      amount1Desired: ethers.parseEther("1000000"),
      amount0Min: 0, amount1Min: 0, recipient: owner.address, deadline: await dl(),
    });

    // Pre-initialize the [-10,10] ticks used by the mint comparison so BOTH the classic
    // and permit mints below only "add to existing ticks". Otherwise whichever mint runs
    // first pays a one-time tick-initialization cost, biasing the comparison.
    await pm.mint({
      token0: token0.target, token1: token1.target, fee: FEE,
      tickLower: -TS * 10, tickUpper: TS * 10,
      amount0Desired: ethers.parseEther("100"),
      amount1Desired: ethers.parseEther("100"),
      amount0Min: 0, amount1Min: 0, recipient: owner.address, deadline: await dl(),
    });

    for (const u of [swapClassic, swapPermit, mintClassic, mintPermit]) {
      await token0.mint(u.address, ethers.parseEther("100000"));
      await token1.mint(u.address, ethers.parseEther("100000"));
    }
  });

  it("swap: approve + swap (2 tx) vs multicall permit swap (1 tx)", async function () {
    const amountIn = ethers.parseEther("100");

    // Classic: exact-amount approve, then swap.
    const apGas = (await (await token0.connect(swapClassic).approve(router.target, amountIn)).wait()).gasUsed;
    const swGas = (await (await router.connect(swapClassic).exactInputSingle({
      tokenIn: token0.target, tokenOut: token1.target, fee: FEE,
      recipient: swapClassic.address, deadline: await dl(),
      amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n,
    })).wait()).gasUsed;
    const classicTotal = apGas + swGas;

    // Permit: one multicall(selfPermit, swap).
    const deadline = await dl();
    const sig = await signPermit(token0, swapPermit, router.target, amountIn, deadline);
    const permitData = router.interface.encodeFunctionData("selfPermit", [token0.target, amountIn, deadline, sig.v, sig.r, sig.s]);
    const swapData   = router.interface.encodeFunctionData("exactInputSingle", [{
      tokenIn: token0.target, tokenOut: token1.target, fee: FEE,
      recipient: swapPermit.address, deadline, amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n,
    }]);
    const permitTotal = (await (await router.connect(swapPermit).multicall([permitData, swapData])).wait()).gasUsed;

    console.log("\n  ── SWAP: classic (2 tx) vs permit multicall (1 tx) ──");
    console.log(`    approve tx                 : ${apGas}`);
    console.log(`    swap tx                    : ${swGas}`);
    console.log(`    classic total (2 tx)       : ${classicTotal}`);
    console.log(`    permit multicall (1 tx)    : ${permitTotal}`);
    console.log(`    delta (classic - permit)   : ${classicTotal - permitTotal} gas`);

    // Batching into one tx must cost less total gas than the 2-tx classic flow.
    expect(permitTotal).to.be.lt(classicTotal);
  });

  it("mint: approve x2 + mint (3 tx) vs multicall permit mint (1 tx)", async function () {
    const amt = ethers.parseEther("1000");

    // Classic: two exact-amount approvals, then mint.
    const ap0 = (await (await token0.connect(mintClassic).approve(pm.target, amt)).wait()).gasUsed;
    const ap1 = (await (await token1.connect(mintClassic).approve(pm.target, amt)).wait()).gasUsed;
    const mn  = (await (await pm.connect(mintClassic).mint({
      token0: token0.target, token1: token1.target, fee: FEE,
      tickLower: -TS * 10, tickUpper: TS * 10,
      amount0Desired: amt, amount1Desired: amt, amount0Min: 0, amount1Min: 0,
      recipient: mintClassic.address, deadline: await dl(),
    })).wait()).gasUsed;
    const classicTotal = ap0 + ap1 + mn;

    // Permit: one multicall(selfPermit token0, selfPermit token1, mint).
    const deadline = await dl();
    const s0 = await signPermit(token0, mintPermit, pm.target, amt, deadline);
    const s1 = await signPermit(token1, mintPermit, pm.target, amt, deadline);
    const p0 = pm.interface.encodeFunctionData("selfPermit", [token0.target, amt, deadline, s0.v, s0.r, s0.s]);
    const p1 = pm.interface.encodeFunctionData("selfPermit", [token1.target, amt, deadline, s1.v, s1.r, s1.s]);
    const md = pm.interface.encodeFunctionData("mint", [{
      token0: token0.target, token1: token1.target, fee: FEE,
      tickLower: -TS * 10, tickUpper: TS * 10,
      amount0Desired: amt, amount1Desired: amt, amount0Min: 0, amount1Min: 0,
      recipient: mintPermit.address, deadline,
    }]);
    const permitTotal = (await (await pm.connect(mintPermit).multicall([p0, p1, md])).wait()).gasUsed;

    console.log("\n  ── MINT: classic (3 tx) vs permit multicall (1 tx) ──");
    console.log(`    approve token0 tx          : ${ap0}`);
    console.log(`    approve token1 tx          : ${ap1}`);
    console.log(`    mint tx                    : ${mn}`);
    console.log(`    classic total (3 tx)       : ${classicTotal}`);
    console.log(`    permit multicall (1 tx)    : ${permitTotal}`);
    console.log(`    delta (classic - permit)   : ${classicTotal - permitTotal} gas\n`);

    // Batching into one tx must cost less total gas than the 3-tx classic flow.
    expect(permitTotal).to.be.lt(classicTotal);
  });
});
