const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  // ── Core ────────────────────────────────────────────────────────────────────
  const PoolFactory = await ethers.getContractFactory("PoolFactory");
  const factory = await PoolFactory.deploy();
  await factory.waitForDeployment();
  console.log("PoolFactory:      ", factory.target);

  // ── Periphery ───────────────────────────────────────────────────────────────
  const PM = await ethers.getContractFactory("PositionManager");
  const pm = await PM.deploy(factory.target);
  await pm.waitForDeployment();
  console.log("PositionManager:  ", pm.target);

  const Router = await ethers.getContractFactory("SwapRouter");
  const router = await Router.deploy(factory.target);
  await router.waitForDeployment();
  console.log("SwapRouter:       ", router.target);

  const QuoterF = await ethers.getContractFactory("Quoter");
  const quoter = await QuoterF.deploy(factory.target);
  await quoter.waitForDeployment();
  console.log("Quoter:           ", quoter.target);

  const AdvisorF = await ethers.getContractFactory("DynamicFeeAdvisor");
  const advisor = await AdvisorF.deploy(factory.target);
  await advisor.waitForDeployment();
  console.log("DynamicFeeAdvisor:", advisor.target);

  // ── Mock tokens ─────────────────────────────────────────────────────────────
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const tokenA = await MockERC20.deploy("Demo Token A", "DTA");
  const tokenB = await MockERC20.deploy("Demo Token B", "DTB");
  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();
  console.log("Token A:          ", tokenA.target);
  console.log("Token B:          ", tokenB.target);

  // ── Create 0.3% pool ────────────────────────────────────────────────────────
  const FEE = 3000;
  await factory.createPool(tokenA.target, tokenB.target, FEE);
  const poolAddr = await factory.getPool(tokenA.target, tokenB.target, FEE);
  const pool = await ethers.getContractAt("Pool", poolAddr);
  console.log("Pool (0.3%):      ", poolAddr);

  const t0 = tokenA.target.toLowerCase() < tokenB.target.toLowerCase() ? tokenA.target : tokenB.target;
  const t1 = tokenA.target.toLowerCase() < tokenB.target.toLowerCase() ? tokenB.target : tokenA.target;
  const token0 = await ethers.getContractAt("MockERC20", t0);
  const token1 = await ethers.getContractAt("MockERC20", t1);

  // Initialize pool at price 1:1
  const Q96 = 2n ** 96n;
  await pool.initialize(Q96);

  // Seed initial liquidity
  const SEED = ethers.parseEther("100000");
  await token0.mint(deployer.address, SEED);
  await token1.mint(deployer.address, SEED);
  await token0.approve(pm.target, SEED);
  await token1.approve(pm.target, SEED);

  await pm.mint({
    token0: t0, token1: t1, fee: FEE,
    tickLower: -60 * 500, tickUpper: 60 * 500,
    amount0Desired: ethers.parseEther("50000"),
    amount1Desired: ethers.parseEther("50000"),
    amount0Min: 0, amount1Min: 0,
    recipient: deployer.address,
    deadline: Math.floor(Date.now() / 1000) + 3600
  });
  console.log("Seeded liquidity — NFT position #1 minted");

  console.log("\n=== Paste this JSON into the frontend Config panel ===");
  console.log(JSON.stringify({
    FACTORY:              factory.target,
    POSITION_MANAGER:     pm.target,
    SWAP_ROUTER:          router.target,
    QUOTER:               quoter.target,
    DYNAMIC_FEE_ADVISOR:  advisor.target,
    TOKEN_A:              tokenA.target,
    TOKEN_B:              tokenB.target,
    POOL:                 poolAddr
  }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
