import { useMemo, useState } from "react";
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
  "function swapExactIn(address tokenIn,uint256 amountIn,uint256 minAmountOut,uint256 deadline) returns (uint256)",
  "function balanceOf(address account) view returns (uint256)"
];

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
  const [swapIn, setSwapIn] = useState("10");
  const [quote, setQuote] = useState("");

  const provider = useMemo(() => {
    if (!window.ethereum) return null;
    return new BrowserProvider(window.ethereum);
  }, []);

  async function contracts() {
    if (!provider) throw new Error("No injected wallet found.");
    const signer = await provider.getSigner();
    return {
      signer,
      amm: new Contract(ammAddress, ammAbi, signer),
      tokenA: new Contract(tokenAAddress, erc20Abi, signer),
      tokenB: new Contract(tokenBAddress, erc20Abi, signer)
    };
  }

  async function connectWallet() {
    if (!provider) {
      setStatus("Install MetaMask or another injected wallet.");
      return;
    }
    const signer = await provider.getSigner();
    setAccount(await signer.getAddress());
    setStatus("Wallet connected. Use localhost chain 31337 for the demo.");
  }

  async function refresh() {
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
  }

  async function approveDemo() {
    const { tokenA, tokenB } = await contracts();
    setStatus("Approving AMM to spend demo tokens...");
    await (await tokenA.approve(ammAddress, parseEther("100000"))).wait();
    await (await tokenB.approve(ammAddress, parseEther("100000"))).wait();
    setStatus("Approvals confirmed.");
  }

  async function mintDemoTokens() {
    const { tokenA, tokenB, signer } = await contracts();
    const to = await signer.getAddress();
    setStatus("Minting local demo tokens...");
    await (await tokenA.mint(to, parseEther("1000"))).wait();
    await (await tokenB.mint(to, parseEther("1000"))).wait();
    await refresh();
  }

  async function addLiquidity() {
    const { amm } = await contracts();
    setStatus("Adding liquidity...");
    await (await amm.addLiquidity(parseEther(amountA), parseEther(amountB), 1, deadline())).wait();
    await refresh();
  }

  async function quoteSwap() {
    const { amm } = await contracts();
    const output = await amm.quoteSwap(tokenAAddress, parseEther(swapIn));
    setQuote(formatEther(output));
    setStatus("Quote calculated.");
  }

  async function swap() {
    const { amm } = await contracts();
    const minOut = quote ? parseEther((Number(quote) * 0.995).toFixed(18)) : 1n;
    setStatus("Swapping token A for token B...");
    await (await amm.swapExactIn(tokenAAddress, parseEther(swapIn), minOut, deadline())).wait();
    await refresh();
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
            <button onClick={mintDemoTokens}>Mint</button>
            <button onClick={approveDemo}>Approve</button>
            <button onClick={refresh}>Refresh</button>
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
          <button onClick={addLiquidity}>Add Liquidity</button>
        </div>

        <div className="panel">
          <h2>Swap</h2>
          <label>
            Token A In
            <input value={swapIn} onChange={(event) => setSwapIn(event.target.value)} />
          </label>
          <Metric label="Expected Token B Out" value={quote || "-"} />
          <div className="actions">
            <button onClick={quoteSwap}>Quote</button>
            <button onClick={swap}>Swap</button>
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
