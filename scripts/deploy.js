const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const parse = hre.ethers.parseEther;

  const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
  const tokenA = await MockERC20.deploy("Course Token A", "CTA");
  const tokenB = await MockERC20.deploy("Course Token B", "CTB");

  const ImprovedAMM = await hre.ethers.getContractFactory("ImprovedAMM");
  const amm = await ImprovedAMM.deploy(tokenA.target, tokenB.target, parse("100"), parse("100"));

  await tokenA.mint(deployer.address, parse("10000"));
  await tokenB.mint(deployer.address, parse("10000"));
  await tokenA.approve(amm.target, parse("10000"));
  await tokenB.approve(amm.target, parse("10000"));

  console.log("Token A:", tokenA.target);
  console.log("Token B:", tokenB.target);
  console.log("Improved AMM:", amm.target);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
