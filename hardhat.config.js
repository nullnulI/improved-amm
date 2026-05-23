require("@nomicfoundation/hardhat-toolbox");

const networks = {
  hardhat: {
    chainId: 31337
  },
  localhost: {
    url: "http://127.0.0.1:8545",
    chainId: 31337
  }
};

if (process.env.SEPOLIA_RPC_URL && process.env.PRIVATE_KEY) {
  const privateKey = process.env.PRIVATE_KEY.startsWith("0x")
    ? process.env.PRIVATE_KEY
    : `0x${process.env.PRIVATE_KEY}`;

  networks.sepolia = {
    url: process.env.SEPOLIA_RPC_URL,
    accounts: [privateKey]
  };
}

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      },
      evmVersion: "cancun",
      viaIR: true
    }
  },
  paths: {
    sources: "contracts/src",
    tests: "contracts/test"
  },
  networks
};
