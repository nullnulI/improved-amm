# SC6107 Improved AMM

This project implements **Option 5: Automated Market Maker with Novel Features** for the SC6107 Blockchain Development Fundamentals project.

The MVP is a Uniswap V2-inspired constant-product AMM with:

- ERC-20 mock tokens for local testing.
- LP token minting and burning for liquidity providers.
- Add liquidity, remove liquidity, quote, and exact-input swap flows.
- Slippage protection through `minAmountOut`.
- Deadline protection for stale transactions.
- Virtual reserves as the course-project "novel" pricing feature.
- Dynamic fees: 0.3% for normal trades and 0.5% for large trades.
- A React/Vite demo for wallet-based interaction.

## Why This Project

Standard `x * y = k` AMMs are simple and composable, but they expose traders to price impact and LPs to market risk. This project starts from the Uniswap V2 CPAMM model and adds virtual reserves plus dynamic fees to show how protocol parameters can change trading behavior.

## Quick Start

```bash
npm install
npm run compile
npm test
```

Run the local chain:

```bash
npm run node
```

In another terminal, deploy contracts:

```bash
npm run deploy
```

Copy the printed Token A, Token B, and Improved AMM addresses into the frontend:

```bash
npm run dev
```

Open the Vite URL, connect MetaMask to `localhost:8545` / chain ID `31337`, then run:

1. Mint demo tokens.
2. Approve the AMM.
3. Add liquidity.
4. Quote a swap.
5. Swap Token A for Token B.

## Project Structure

```text
improved-amm/
  README.md
contracts/
  src/
    ImprovedAMM.sol
    MockERC20.sol
  test/
    ImprovedAMM.test.js
frontend/
  index.html
  src/
    App.jsx
    styles.css
docs/
  architecture.md
  security-analysis.md
  gas-optimization.md
  presentation.md
scripts/
  deploy.js
hardhat.config.js
package.json
package-lock.json
```

## Five-Sentence Presentation Story

1. We build on Uniswap V2's constant-product AMM model.
2. The pool uses token reserves to determine price.
3. Each swap changes reserves, so large trades create price impact and slippage.
4. We add `minAmountOut` and `deadline` to reduce stale execution and slippage risk.
5. We introduce virtual reserves and dynamic fees as our novel AMM features.

## Known Limitations

- This is an educational AMM, not a production-ready protocol.
- It does not use an external oracle.
- Virtual reserve updates are intentionally simple for demo purposes.
- The frontend targets local demo flow, not a full production DEX UX.
