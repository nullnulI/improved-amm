# Deployment Guide

## Local Development (Hardhat)

### Prerequisites

```bash
node >= 18
npm >= 9
```

### 1. Install dependencies

```bash
cd improved-amm
npm install
```

### 2. Compile contracts

```bash
npm run compile
# or: npx hardhat compile
```

Expected output: `Compiled N Solidity files successfully`.

### 3. Start the local Hardhat node

In a dedicated terminal:

```bash
npm run node
# or: npx hardhat node
```

This starts a JSON-RPC server at `http://127.0.0.1:8545` with chain ID 31337 and pre-funded accounts.

### 4. Deploy contracts

In a second terminal:

```bash
npm run deploy
# or: npx hardhat run scripts/deploy.js --network localhost
```

The script:
1. Deploys `MockERC20` × 2 (TOKEN_A, TOKEN_B)
2. Deploys `PoolFactory`
3. Deploys `PositionManager`, `SwapRouter`, `Quoter`
4. Creates a 0.30% pool for TOKEN_A / TOKEN_B
5. Initializes the pool at price 1:1 (sqrtPriceX96 = 2^96)
6. Mints an initial supply to the deployer

At the end it prints:

```
===== COPY THIS INTO THE FRONTEND CONFIG PANEL =====
{
  "FACTORY": "0x...",
  "POSITION_MANAGER": "0x...",
  "SWAP_ROUTER": "0x...",
  "QUOTER": "0x...",
  "TOKEN_A": "0x...",
  "TOKEN_B": "0x..."
}
```

### 5. Run tests

```bash
npm test
# or: npx hardhat test
```

Expected: **84 passing** across unit, integration, fuzz/invariant, and gas report tests.

### 6. Start the frontend

```bash
npm run dev
# or: npx vite frontend --host 0.0.0.0
```

Opens at `http://localhost:5173`. Follow the [User Guide](./user-guide.md) to interact.

---

## Contract Addresses Reference

| Contract | Role |
|---|---|
| `PoolFactory` | Deploys pools; manages fee tiers and protocol fees |
| `Pool` | Core concentrated liquidity pool (one per token-pair + fee) |
| `PositionManager` | ERC-721 NFT wrapper for LP positions |
| `SwapRouter` | Stateless router for single and multi-hop swaps |
| `Quoter` | Gas-free swap simulation via revert-and-catch |

---

## Re-deploying

If you restart the Hardhat node, all state is lost. Simply run `npm run deploy` again and paste the new addresses into the frontend.

---

## Production Deployment (Testnet / Mainnet)

> The contracts are not audited. Do not deploy with real funds.

1. Configure a network in `hardhat.config.js`:

```js
networks: {
  sepolia: {
    url: process.env.SEPOLIA_RPC_URL,
    accounts: [process.env.PRIVATE_KEY],
  }
}
```

2. Deploy:

```bash
npx hardhat run scripts/deploy.js --network sepolia
```

3. Verify on Etherscan (optional):

```bash
npx hardhat verify --network sepolia <contract_address> <constructor_args>
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Error: cannot find module '@nomicfoundation/hardhat-toolbox'` | Run `npm install` |
| `Error: POOL_EXISTS` | The pool for this pair and fee already exists; use `factory.getPool()` to retrieve the address |
| `Error: NOT_INITIALIZED` | Call `pool.initialize(sqrtPriceX96)` before minting or swapping |
| MetaMask "wrong network" | Switch to Hardhat Local (chain ID 31337) |
| Frontend shows no pool bar | Paste correct JSON and click Load; pool address is resolved from the factory |
