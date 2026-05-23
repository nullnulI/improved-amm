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
  "DYNAMIC_FEE_ADVISOR": "0x...",
  "TOKEN_A": "0x...",
  "TOKEN_B": "0x...",
  "POOL": "0x..."
}
```

### 5. Run tests

```bash
npm test
# or: npx hardhat test
```

Expected: **173 passing** across unit, integration, fuzz/invariant, gas, edge-case, permit, and library tests.

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

## Sepolia Deployment

> The contracts are not audited. Do not deploy with real funds.

1. Export deployment credentials:

```bash
SEPOLIA_RPC_URL=<your_rpc_url>
PRIVATE_KEY=<your_deployer_private_key>
```

2. Deploy:

```bash
npm run deploy:sepolia
# or: npx hardhat run scripts/deploy.js --network sepolia
```

3. Paste the printed JSON into the frontend Deployment panel while MetaMask is connected to Sepolia.

4. Verify on Etherscan (optional):

```bash
npx hardhat verify --network sepolia <contract_address> <constructor_args>
```

### Current Recorded Sepolia Addresses

Update this table if the project is redeployed.

| Contract | Address |
|---|---|
| `PoolFactory` | `0x80fEbDCd94639Ff5F3D21B2E6F772bA782B97c74` |
| `PositionManager` | `0x518b4D94840F1b44AEC53f9E4C5286fE59CA899c` |
| `SwapRouter` | `0x6f7471B49BC51551d6D0AF6d4C19FaE949CA47Cb` |
| `Quoter` | `0x7e730073cFc13827F435ca2Eb220444497fBC267` |
| `DynamicFeeAdvisor` | `0xF4372ac6BEf5D56B197E69Af69dd873d26C8De21` |
| `Token A` | `0xEd53256bCC1447Bc5b0954DB14481B14a3016322` |
| `Token B` | `0x9DC22e741752A67FACDC0c35D852846ab99bbA22` |
| `Pool` | `0x94E1A4F63f9D2522900AAD444F80C2a433637d91` |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Error: cannot find module '@nomicfoundation/hardhat-toolbox'` | Run `npm install` |
| `Error: POOL_EXISTS` | The pool for this pair and fee already exists; use `factory.getPool()` to retrieve the address |
| `Error: NOT_INITIALIZED` | Call `pool.initialize(sqrtPriceX96)` before minting or swapping |
| MetaMask "wrong network" | Switch to Hardhat Local (chain ID 31337) for local demo, or Sepolia for testnet demo |
| Frontend shows no pool bar | Paste correct JSON and click Load; pool address is resolved from the factory |
