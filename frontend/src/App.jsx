import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserProvider, Contract, formatEther, parseEther } from "ethers";
import "./styles.css";

const erc20Abi = [
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
  "function symbol() view returns (string)"
];

const ammAbi = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function reserve0() view returns (uint256)",
  "function reserve1() view returns (uint256)",
  "function virtualReserve0() view returns (uint256)",
  "function virtualReserve1() view returns (uint256)",
  "function addLiquidity(uint256 amount0,uint256 amount1,uint256 minLiquidity,uint256 deadline) returns (uint256)",
  "function removeLiquidity(uint256 liquidity,uint256 minAmount0,uint256 minAmount1,uint256 deadline) returns (uint256,uint256)",
  "function quoteSwap(address tokenIn,uint256 amountIn) view returns (uint256)",
  "function quoteSwapDetails(address tokenIn,uint256 amountIn) view returns (uint256,uint256,uint256)",
  "function swapExactIn(address tokenIn,uint256 amountIn,uint256 minAmountOut,uint256 deadline) returns (uint256)",
  "function balanceOf(address account) view returns (uint256)"
];

const localDefaults = {
  amm: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  tokenA: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  tokenB: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
};

const requiredChainId = 31337n;

function App() {
  const [account, setAccount] = useState("");
  const [ammAddress, setAmmAddress] = useState("");
  const [tokenAAddress, setTokenAAddress] = useState("");
  const [tokenBAddress, setTokenBAddress] = useState("");
  const [status, setStatus] = useState("Connect a wallet and paste local deployment addresses.");
  const [pool, setPool] = useState(null);
  const [balances, setBalances] = useState(null);
  const [amountA, setAmountA] = useState("100");
  const [amountB, setAmountB] = useState("100");
  const [removeLp, setRemoveLp] = useState("");
  const [swapIn, setSwapIn] = useState("10");
  const [swapDirection, setSwapDirection] = useState("A_TO_B");
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);

  const provider = useMemo(() => {
    if (!window.ethereum) return null;
    return new BrowserProvider(window.ethereum);
  }, []);

  async function contracts() {
    if (!provider) throw new Error("No injected wallet found.");
    await assertLocalNetwork();
    const signer = await provider.getSigner();
    return {
      signer,
      amm: new Contract(ammAddress, ammAbi, signer),
      tokenA: new Contract(tokenAAddress, erc20Abi, signer),
      tokenB: new Contract(tokenBAddress, erc20Abi, signer)
    };
  }

  async function connectWallet() {
    try {
      if (!provider) {
        setStatus("Install MetaMask or another injected wallet.");
        return;
      }
      setBusy(true);
      await assertLocalNetwork();
      const signer = await provider.getSigner();
      setAccount(await signer.getAddress());
      setStatus("Wallet connected. Use localhost chain 31337 for the demo.");
    } catch (error) {
      setStatus(error.shortMessage || error.reason || error.message || "Wallet connection failed.");
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    await runAction("Refreshing pool state...", async () => {
      const { amm, tokenA, tokenB } = await contracts();
      const [reserve0, reserve1, virtualReserve0, virtualReserve1, lp, balA, balB] = await Promise.all([
        amm.reserve0(),
        amm.reserve1(),
        amm.virtualReserve0(),
        amm.virtualReserve1(),
        amm.balanceOf(account),
        tokenA.balanceOf(account),
        tokenB.balanceOf(account)
      ]);

      setPool({ reserve0, reserve1, virtualReserve0, virtualReserve1, lp });
      setBalances({ balA, balB });
      setStatus("Pool state refreshed.");
    });
  }

  async function approveDemo() {
    await runAction("Approving AMM to spend demo tokens...", async () => {
      const { tokenA, tokenB } = await contracts();
      await (await tokenA.approve(ammAddress, parseEther("100000"))).wait();
      await (await tokenB.approve(ammAddress, parseEther("100000"))).wait();
      setStatus("Approvals confirmed.");
    });
  }

  async function mintDemoTokens() {
    await runAction("Minting local demo tokens...", async () => {
      const { tokenA, tokenB, signer } = await contracts();
      const to = await signer.getAddress();
      await (await tokenA.mint(to, parseEther("1000"))).wait();
      await (await tokenB.mint(to, parseEther("1000"))).wait();
      await refreshState();
      setStatus("Demo tokens minted.");
    });
  }

  async function addLiquidity() {
    await runAction("Adding liquidity...", async () => {
      const { amm } = await contracts();
      await (await amm.addLiquidity(parseEther(amountA), parseEther(amountB), 1, deadline())).wait();
      await refreshState();
      setStatus("Liquidity added.");
    });
  }

  async function quoteSwap() {
    await runAction("Calculating quote...", async () => {
      const { amm } = await contracts();
      const [amountOut, feeBps, priceImpactBps] = await amm.quoteSwapDetails(tokenInAddress(), parseEther(swapIn));
      const minReceived = (amountOut * 995n) / 1000n;
      setQuote({ amountOut, feeBps, priceImpactBps, minReceived });
      setStatus("Quote calculated.");
    });
  }

  async function swap() {
    await runAction(`Swapping ${inputTokenLabel()} for ${outputTokenLabel()}...`, async () => {
      const { amm } = await contracts();
      const minOut = quote ? quote.minReceived : 1n;
      await (await amm.swapExactIn(tokenInAddress(), parseEther(swapIn), minOut, deadline())).wait();
      await refreshState();
      setStatus("Swap confirmed.");
    });
  }

  async function removeLiquidity() {
    await runAction("Removing liquidity...", async () => {
      const { amm } = await contracts();
      await (await amm.removeLiquidity(parseEther(removeLp), 1, 1, deadline())).wait();
      await refreshState();
      setStatus("Liquidity removed.");
    });
  }

  async function refreshState() {
    const { amm, tokenA, tokenB } = await contracts();
    const [reserve0, reserve1, virtualReserve0, virtualReserve1, lp, balA, balB] = await Promise.all([
      amm.reserve0(),
      amm.reserve1(),
      amm.virtualReserve0(),
      amm.virtualReserve1(),
      amm.balanceOf(account),
      tokenA.balanceOf(account),
      tokenB.balanceOf(account)
    ]);

    setPool({ reserve0, reserve1, virtualReserve0, virtualReserve1, lp });
    setBalances({ balA, balB });
  }

  async function runAction(label, action) {
    try {
      setBusy(true);
      setStatus(label);
      await action();
    } catch (error) {
      setStatus(error.shortMessage || error.reason || error.message || "Transaction failed.");
    } finally {
      setBusy(false);
    }
  }

  async function assertLocalNetwork() {
    const network = await provider.getNetwork();
    if (network.chainId !== requiredChainId) {
      throw new Error("Wrong network. Switch MetaMask to Hardhat Local, chain ID 31337.");
    }
  }

  function useLocalDefaults() {
    setAmmAddress(localDefaults.amm);
    setTokenAAddress(localDefaults.tokenA);
    setTokenBAddress(localDefaults.tokenB);
    setStatus("Local Hardhat default deployment addresses loaded.");
  }

  function tokenInAddress() {
    return swapDirection === "A_TO_B" ? tokenAAddress : tokenBAddress;
  }

  function inputTokenLabel() {
    return swapDirection === "A_TO_B" ? "Token A" : "Token B";
  }

  function outputTokenLabel() {
    return swapDirection === "A_TO_B" ? "Token B" : "Token A";
  }

  function switchDirection() {
    setSwapDirection((direction) => (direction === "A_TO_B" ? "B_TO_A" : "A_TO_B"));
    setQuote(null);
  }

  function deadline() {
    return Math.floor(Date.now() / 1000) + 3600;
  }

  return (
    <main className="shell">
      <section className="toolbar">
        <div>
          <p className="eyebrow">SC6107 Development Project</p>
          <h1>Improved AMM Demo</h1>
        </div>
        <button onClick={connectWallet}>{account ? short(account) : "Connect Wallet"}</button>
      </section>

      <section className="grid">
        <div className="panel">
          <h2>Deployment</h2>
          <label>
            AMM Address
            <input value={ammAddress} onChange={(event) => setAmmAddress(event.target.value)} />
          </label>
          <label>
            Token A
            <input value={tokenAAddress} onChange={(event) => setTokenAAddress(event.target.value)} />
          </label>
          <label>
            Token B
            <input value={tokenBAddress} onChange={(event) => setTokenBAddress(event.target.value)} />
          </label>
          <div className="actions">
            <button onClick={useLocalDefaults} disabled={busy}>Use Local Defaults</button>
            <button onClick={mintDemoTokens} disabled={busy}>Mint</button>
            <button onClick={approveDemo} disabled={busy}>Approve</button>
            <button onClick={refresh} disabled={busy}>Refresh</button>
          </div>
        </div>

        <div className="panel">
          <h2>Pool State</h2>
          <Metric label="Token A Reserve" value={pool && formatEther(pool.reserve0)} />
          <Metric label="Token B Reserve" value={pool && formatEther(pool.reserve1)} />
          <Metric label="Virtual A Reserve" value={pool && formatEther(pool.virtualReserve0)} />
          <Metric label="Virtual B Reserve" value={pool && formatEther(pool.virtualReserve1)} />
          <Metric label="Your LP Balance" value={pool && formatEther(pool.lp)} />
          <Metric label="Your Token A" value={balances && formatEther(balances.balA)} />
          <Metric label="Your Token B" value={balances && formatEther(balances.balB)} />
        </div>

        <div className="panel">
          <h2>Add Liquidity</h2>
          <label>
            Token A Amount
            <input value={amountA} onChange={(event) => setAmountA(event.target.value)} />
          </label>
          <label>
            Token B Amount
            <input value={amountB} onChange={(event) => setAmountB(event.target.value)} />
          </label>
          <button onClick={addLiquidity} disabled={busy}>Add Liquidity</button>
        </div>

        <div className="panel">
          <h2>Remove Liquidity</h2>
          <label>
            LP Amount
            <input value={removeLp} onChange={(event) => setRemoveLp(event.target.value)} />
          </label>
          <button onClick={removeLiquidity} disabled={busy || !removeLp}>Remove Liquidity</button>
        </div>

        <div className="panel">
          <h2>Swap</h2>
          <div className="direction">
            <strong>{inputTokenLabel()} {"->"} {outputTokenLabel()}</strong>
            <button onClick={switchDirection} disabled={busy}>Switch Direction</button>
          </div>
          <label>
            {inputTokenLabel()} In
            <input value={swapIn} onChange={(event) => {
              setSwapIn(event.target.value);
              setQuote(null);
            }} />
          </label>
          <Metric label={`Expected ${outputTokenLabel()} Out`} value={quote && formatEther(quote.amountOut)} />
          <Metric label="Fee" value={quote && `${quote.feeBps} bps`} />
          <Metric label="Price Impact" value={quote && `${quote.priceImpactBps} bps`} />
          <Metric label="Min Received" value={quote && formatEther(quote.minReceived)} />
          <div className="actions">
            <button onClick={quoteSwap} disabled={busy}>Quote</button>
            <button onClick={swap} disabled={busy}>Swap</button>
          </div>
        </div>
      </section>

      <p className="status">{status}</p>
    </main>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value ?? "-"}</strong>
    </div>
  );
}

function short(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

createRoot(document.getElementById("root")).render(<App />);
