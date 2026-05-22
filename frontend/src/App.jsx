import React, { useState, useCallback, useEffect } from 'react';
import { Contract, formatUnits } from 'ethers';
import { createRoot } from 'react-dom/client';
import { useWallet } from './hooks/useWallet.js';
import { usePool }   from './hooks/usePool.js';
import { SwapPanel }      from './components/SwapPanel.jsx';
import { LiquidityPanel } from './components/LiquidityPanel.jsx';
import { PositionsPanel } from './components/PositionsPanel.jsx';
import { AnalyticsPanel } from './components/AnalyticsPanel.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { FACTORY_ABI, ERC20_ABI, fmt } from './constants.js';
import './styles.css';

const TABS = ['Swap', 'Liquidity', 'Positions', 'Analytics'];

const EMPTY_ADDRS = { FACTORY: '', POSITION_MANAGER: '', SWAP_ROUTER: '', QUOTER: '', TOKEN_A: '', TOKEN_B: '' };

function App() {
  const { account, provider, getSigner, connect, walletError } = useWallet();
  const [tab, setTab]     = useState('Swap');
  const [addrs, setAddrs] = useState(EMPTY_ADDRS);
  const [draftJson, setDraftJson] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [status, setStatus] = useState('Connect wallet and paste deployment addresses.');
  const [poolAddr, setPoolAddr] = useState('');
  const [balances, setBalances] = useState(null);

  const { poolState, swapHistory, mintHistory } = usePool(poolAddr, provider);

  // Resolve pool address when factory + tokens are available
  useEffect(() => {
    if (!addrs.FACTORY || !addrs.TOKEN_A || !addrs.TOKEN_B || !provider) return;
    async function resolve() {
      try {
        const factory = new Contract(addrs.FACTORY, FACTORY_ABI, provider);
        // Try 0.3% pool first, then others
        for (const fee of [3000, 500, 10000]) {
          const addr = await factory.getPool(addrs.TOKEN_A, addrs.TOKEN_B, fee);
          if (addr && addr !== '0x0000000000000000000000000000000000000000') {
            setPoolAddr(addr);
            return;
          }
        }
      } catch (e) { /* addresses not valid yet */ }
    }
    resolve();
  }, [addrs.FACTORY, addrs.TOKEN_A, addrs.TOKEN_B, provider]);

  // Wallet token balances
  useEffect(() => {
    if (!account || !addrs.TOKEN_A || !addrs.TOKEN_B || !provider) { setBalances(null); return; }
    let cancelled = false;
    async function load() {
      try {
        const ta = new Contract(addrs.TOKEN_A, ERC20_ABI, provider);
        const tb = new Contract(addrs.TOKEN_B, ERC20_ABI, provider);
        const [ba, bb, sa, sb] = await Promise.all([
          ta.balanceOf(account), tb.balanceOf(account),
          ta.symbol(), tb.symbol(),
        ]);
        if (!cancelled) setBalances({ ba, bb, sa, sb });
      } catch (_) {}
    }
    load();
    const id = setInterval(load, 8000);
    return () => { cancelled = true; clearInterval(id); };
  }, [account, addrs.TOKEN_A, addrs.TOKEN_B, provider, status]);

  function loadJson() {
    setJsonError('');
    try {
      const parsed = JSON.parse(draftJson);
      const keys = ['FACTORY', 'POSITION_MANAGER', 'SWAP_ROUTER', 'QUOTER', 'TOKEN_A', 'TOKEN_B'];
      const next = { ...EMPTY_ADDRS };
      keys.forEach((k) => { if (parsed[k]) next[k] = parsed[k]; });
      setAddrs(next);
      setPoolAddr('');
      setStatus('Addresses loaded.');
    } catch (e) {
      setJsonError('Invalid JSON — paste the full output block from the deploy script.');
    }
  }

  async function mintDemo() {
    if (!account || !addrs.TOKEN_A || !addrs.TOKEN_B) return;
    setStatus('Minting demo tokens…');
    try {
      const signer = await getSigner();
      const ta = new Contract(addrs.TOKEN_A, ERC20_ABI, signer);
      const tb = new Contract(addrs.TOKEN_B, ERC20_ABI, signer);
      const amt = BigInt('1000000000000000000000'); // 1000 tokens
      await (await ta.mint(account, amt)).wait();
      await (await tb.mint(account, amt)).wait();
      setStatus('Minted 1000 of each demo token.');
    } catch (e) {
      setStatus(e.shortMessage || e.reason || e.message || 'Mint failed.');
    }
  }

  const allAddrs = { ...addrs, POOL: poolAddr };

  return (
    <div className="app">
      {/* ── Header ── */}
      <header className="header">
        <div className="header-left">
          <span className="eyebrow">SC6107 Development Project</span>
          <h1>Concentrated Liquidity AMM</h1>
        </div>
        <div className="header-right">
          {account && balances && (
            <div className="balances">
              <span>{fmt(balances.ba)} {balances.sa}</span>
              <span>{fmt(balances.bb)} {balances.sb}</span>
            </div>
          )}
          <button className="btn-connect" onClick={connect}>
            {account ? `${account.slice(0, 6)}…${account.slice(-4)}` : 'Connect Wallet'}
          </button>
        </div>
      </header>

      {/* ── Pool info bar ── */}
      {poolState && (
        <div className="pool-bar">
          <PoolStat label="Pool"    value={`${poolState.symbol0}/${poolState.symbol1}`} />
          <PoolStat label="Fee"     value={`${(poolState.fee / 10000).toFixed(2)}%`} />
          <PoolStat label="Price"   value={`${poolState.price.toPrecision(6)} ${poolState.symbol1}/${poolState.symbol0}`} />
          <PoolStat label="Tick"    value={poolState.tick} />
          <PoolStat label="Liq"     value={poolState.liquidity.toLocaleString()} />
          {poolState.twap5m && <PoolStat label="TWAP 5m" value={poolState.twap5m.toPrecision(6)} />}
        </div>
      )}

      <main className="main">
        {/* ── Config panel ── */}
        <section className="config-panel">
          <div className="config-top">
            <h3>Deployment</h3>
            {walletError && <p className="error">{walletError}</p>}
          </div>
          <div className="config-row">
            <textarea
              className="json-input"
              placeholder={'Paste JSON from deploy script:\n{\n  "FACTORY": "0x...",\n  "POSITION_MANAGER": "0x...",\n  "SWAP_ROUTER": "0x...",\n  "QUOTER": "0x...",\n  "TOKEN_A": "0x...",\n  "TOKEN_B": "0x..."\n}'}
              value={draftJson}
              onChange={(e) => setDraftJson(e.target.value)}
              rows={4}
            />
            <div className="config-actions">
              <button onClick={loadJson}>Load</button>
              {account && addrs.TOKEN_A && (
                <button onClick={mintDemo}>Mint Demo Tokens</button>
              )}
            </div>
          </div>
          {jsonError && <p className="error">{jsonError}</p>}
          {poolAddr && (
            <p className="pool-addr">
              Pool: <code>{poolAddr.slice(0, 10)}…{poolAddr.slice(-6)}</code>
            </p>
          )}
        </section>

        {/* ── Tabs ── */}
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t}
              className={`tab-btn ${tab === t ? 'active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>

        {/* ── Tab content ── */}
        <div className="tab-content">
          {tab === 'Swap' && (
            <SwapPanel
              addrs={allAddrs}
              poolState={poolState}
              getSigner={getSigner}
              account={account}
              onStatus={setStatus}
            />
          )}
          {tab === 'Liquidity' && (
            <LiquidityPanel
              addrs={allAddrs}
              poolState={poolState}
              getSigner={getSigner}
              account={account}
              onStatus={setStatus}
            />
          )}
          {tab === 'Positions' && (
            <PositionsPanel
              addrs={allAddrs}
              poolState={poolState}
              getSigner={getSigner}
              provider={provider}
              account={account}
              onStatus={setStatus}
            />
          )}
          {tab === 'Analytics' && (
            <AnalyticsPanel
              poolState={poolState}
              swapHistory={swapHistory}
              mintHistory={mintHistory}
              addrs={allAddrs}
              getSigner={getSigner}
              account={account}
              onStatus={setStatus}
            />
          )}
        </div>

        <p className="status-bar">{status}</p>
      </main>
    </div>
  );
}

function PoolStat({ label, value }) {
  return (
    <div className="pool-stat">
      <span className="pool-stat-label">{label}</span>
      <strong className="pool-stat-value">{value}</strong>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
