# User Guide — Concentrated Liquidity AMM

This guide walks through every interaction available in the frontend, from connecting a wallet to managing positions and reading analytics.

---

## Prerequisites

- MetaMask (or any EIP-1193 wallet) installed in your browser
- Hardhat node running locally (`npm run node`)
- Contracts deployed (`npm run deploy`)
- Frontend dev server running (`npm run dev`) — opens at `http://localhost:5173`

---

## 1. Connect Your Wallet

1. Open the app at `http://localhost:5173`.
2. Click **Connect Wallet** in the top-right corner.
3. MetaMask prompts you to switch to `Hardhat Local (chainId 31337)`. Accept.
4. Your abbreviated address appears in the header.

> The app enforces chain ID 31337 — it will refuse to connect on other networks.

---

## 2. Load Contract Addresses

After running `npm run deploy`, the script prints a JSON block:

```json
{
  "FACTORY": "0x...",
  "POSITION_MANAGER": "0x...",
  "SWAP_ROUTER": "0x...",
  "QUOTER": "0x...",
  "TOKEN_A": "0x...",
  "TOKEN_B": "0x..."
}
```

1. Copy the entire JSON block.
2. Paste it into the **Deployment** text area at the top of the app.
3. Click **Load**.
4. The dark pool bar appears, showing spot price, tick, liquidity, and TWAP.

---

## 3. Mint Demo Tokens

The deploy script mints an initial supply, but for testing you can mint more:

1. With addresses loaded, click **Mint Demo Tokens**.
2. 1,000 of each token is minted to your wallet.
3. Balances in the header update automatically (every 8 seconds).

---

## 4. Swap Tokens

Navigate to the **Swap** tab.

### Single-Hop Swap

1. Ensure **Single Hop** mode is selected.
2. Choose a **Fee Tier** (0.05%, 0.30%, 1.00%). The "rec." badge shows the volatility-based recommendation.
3. Enter an amount in the **pay** box.
4. Optionally click **MAX** to fill your full balance.
5. Click **Quote** to see execution price, price impact, and minimum received.
6. If price impact > 1%, the value is highlighted red.
7. If a token approval is needed, click **Approve** first.
8. Click **Swap** to execute.

### Multi-Hop Swap

1. Select **Multi-hop** mode.
2. Enter the **intermediate token address** (must be a token with a pool against both your tokenIn and tokenOut).
3. Choose a fee tier for **Hop 1** and **Hop 2** separately.
4. Enter amount, get quote (simulates each hop via the Quoter), then swap.
5. The route is shown as: `TokenIn → Intermediate → TokenOut`.

### Slippage Tolerance

- Presets: 0.1%, 0.5%, 1.0%
- Or enter a custom percentage in the text box.
- Minimum received = quoted output × (1 − slippage).

---

## 5. Add Liquidity

Navigate to the **Liquidity** tab.

### Modes

| Mode | What it does |
|---|---|
| **Range Liquidity** | Standard concentrated LP: deposits both tokens within your chosen range |
| **Sell Order ↑** | Deposits only token0 above the current price — acts as a limit sell |
| **Buy Order ↓** | Deposits only token1 below the current price — acts as a limit buy |

### Step-by-step

1. Select a **Mode** and **Fee Tier**.
2. Set a **Price Range** using the inputs or quick presets (±10%, ±25%, ±50%, Full Range).
3. The tick preview shows the computed tick boundaries and whether the range is in-range.
4. Enter **Deposit Amounts** (the in-range mode requires both; single-sided modes accept one).
5. Set **Slippage Tolerance**.
6. Click **Add Position**.
7. The result shows the NFT token ID and actual amounts used.

---

## 6. Manage Positions

Navigate to the **Positions** tab.

### What you see

Each card shows:
- Position NFT ID and pair
- Fee tier and in-range / out-of-range status
- Price range (lower – upper)
- Current liquidity
- Claimable token0 and token1 (highlighted green when positive)

### JIT Warning

If a position was minted in the same block as a swap event, a **⚠ JIT Liquidity** warning appears with an orange border. This indicates potential just-in-time LP behavior.

### Actions

| Button | Effect |
|---|---|
| **Collect Fees** | Harvests accrued fees to your wallet |
| **+ Add** | Opens an inline form to add more liquidity to this position |
| **Remove All** | Burns all liquidity and collects all tokens in two transactions |

---

## 7. Analytics

Navigate to the **Analytics** tab.

### Price Oracle (TWAP)

- **Spot Price**: current sqrtPriceX96 decoded to token1/token0
- **TWAP 5m / 30m**: time-weighted average over 5 and 30 minutes
- **TWAP Divergence**: percentage difference between the two TWAPs

### Dynamic Fee Recommendation

Based on the 5m-vs-30m TWAP divergence:
- **Low** (<0.5%): recommend 0.05% tier — maximise volume flow
- **Medium** (0.5%–2%): recommend 0.30% — balanced
- **High** (>2%): recommend 1.00% — LPs need higher fees to compensate for IL risk

### Price History & Volume Chart

Plots swap prices (blue line) and per-swap volumes (light blue bars) on a dual-axis chart. Populated after swaps are executed.

### Liquidity Depth Chart

Shows net liquidity (mints minus burns) per price bucket around the current price. The **orange** bucket is the currently active price range.

### Fee Accumulation

Shows `feeGrowthGlobal0X128` and `feeGrowthGlobal1X128` as Q128 fixed-point accumulators. When non-zero, fees are actively accruing.

### Protocol Fee (POL)

Shows the current protocol fee denominator and accrued amounts. Factory owners can:
- Set a protocol fee denominator (0 = off, ≥4 = active; e.g. 5 = 1/5 of swap fees)
- Collect accrued protocol fees to their wallet

### Impermanent Loss Calculator

Enter **Entry Price**, **Range Lower**, and **Range Upper** to compute IL for a concentrated position vs simply holding. A side-by-side card compares concentrated IL against a full-range (Uni V2-style) position. The IL curve chart shows IL across a price range with your range boundaries marked.

---

## 8. Tips

- **Pool not found?** Make sure you clicked Load with the correct JSON, and that the deploy script created a pool (it does by default).
- **Transactions fail?** Check that you have enough token balance and that slippage isn't too tight.
- **No TWAP data?** The TWAP requires at least one block of time to pass after a swap. Swap, wait, swap again.
- **Fees not accruing?** Fees only accumulate while swaps happen within your position's tick range.
