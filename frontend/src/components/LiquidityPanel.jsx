import { useState } from 'react';
import { Contract, parseUnits, formatUnits } from 'ethers';
import {
  POSITION_MANAGER_ABI, ERC20_ABI, FEE_TIERS,
  priceToTick, tickToPrice, nearestUsableTick, fmtPrice, deadline,
} from '../constants.js';

const MODES = [
  { id: 'range',      label: 'Range Liquidity' },
  { id: 'sell-order', label: 'Sell Order (above price)' },
  { id: 'buy-order',  label: 'Buy Order (below price)' },
];

export function LiquidityPanel({ addrs, poolState, getSigner, account, onStatus }) {
  const [feeTier, setFeeTier]   = useState(3000);
  const [mode, setMode]         = useState('range');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [amt0, setAmt0]         = useState('');
  const [amt1, setAmt1]         = useState('');
  const [slipBps]               = useState(50);
  const [busy, setBusy]         = useState(false);

  if (!poolState) return <div className="panel"><p className="muted">Load a pool first.</p></div>;

  const { token0, token1, symbol0, symbol1, price, tick: currentTick } = poolState;
  const tier = FEE_TIERS.find((t) => t.fee === feeTier);

  function setPreset(mult) {
    const lo = price / mult;
    const hi = price * mult;
    setPriceMin(lo.toPrecision(6));
    setPriceMax(hi.toPrecision(6));
  }

  function setFullRange() {
    // Technically MIN/MAX ticks; use a broad range for display
    setPriceMin((tickToPrice(-887220)).toPrecision(6));
    setPriceMax((tickToPrice(887220)).toPrecision(6));
  }

  function applyMode() {
    // Constrain inputs for range orders
    if (mode === 'sell-order') {
      // Range above current price → only token0 needed
      const lo = Math.max(parseFloat(priceMin) || price, price * 1.001);
      const hi = parseFloat(priceMax) || price * 1.1;
      return { lo: Math.min(lo, hi - 1e-9), hi };
    }
    if (mode === 'buy-order') {
      // Range below current price → only token1 needed
      const hi = Math.min(parseFloat(priceMax) || price, price * 0.999);
      const lo = parseFloat(priceMin) || price * 0.9;
      return { lo, hi: Math.max(hi, lo + 1e-9) };
    }
    return {
      lo: parseFloat(priceMin) || price * 0.9,
      hi: parseFloat(priceMax) || price * 1.1,
    };
  }

  async function addLiquidity() {
    setBusy(true);
    onStatus('Adding liquidity...');
    try {
      const signer = await getSigner();
      const pm     = new Contract(addrs.POSITION_MANAGER, POSITION_MANAGER_ABI, signer);
      const t0     = new Contract(token0, ERC20_ABI, signer);
      const t1     = new Contract(token1, ERC20_ABI, signer);

      const { lo, hi } = applyMode();
      const tl = nearestUsableTick(priceToTick(lo), tier.tickSpacing);
      const tu = nearestUsableTick(priceToTick(hi), tier.tickSpacing);
      if (tl >= tu) { onStatus('Invalid price range.'); setBusy(false); return; }

      const d0 = mode === 'buy-order'  ? 0n : parseUnits(amt0 || '0', 18);
      const d1 = mode === 'sell-order' ? 0n : parseUnits(amt1 || '0', 18);

      if (d0 > 0n) {
        const al0 = await t0.allowance(account, addrs.POSITION_MANAGER);
        if (al0 < d0) await (await t0.approve(addrs.POSITION_MANAGER, d0 * 2n)).wait();
      }
      if (d1 > 0n) {
        const al1 = await t1.allowance(account, addrs.POSITION_MANAGER);
        if (al1 < d1) await (await t1.approve(addrs.POSITION_MANAGER, d1 * 2n)).wait();
      }

      const minPct = (10000n - 50n);
      const tx = await pm.mint({
        token0, token1, fee: feeTier,
        tickLower: tl, tickUpper: tu,
        amount0Desired: d0,
        amount1Desired: d1,
        amount0Min: d0 * minPct / 10000n,
        amount1Min: d1 * minPct / 10000n,
        recipient: account,
        deadline: deadline(),
      });
      const receipt = await tx.wait();
      onStatus(`Position minted! Tx: ${receipt.hash.slice(0, 10)}…`);
      setAmt0(''); setAmt1('');
    } catch (e) {
      onStatus(e.shortMessage || e.reason || e.message || 'Mint failed.');
    } finally { setBusy(false); }
  }

  const { lo, hi } = applyMode();
  const tl  = nearestUsableTick(priceToTick(lo || price * 0.9), tier.tickSpacing);
  const tu  = nearestUsableTick(priceToTick(hi || price * 1.1), tier.tickSpacing);
  const inRange0 = tl < currentTick && tu > currentTick;

  return (
    <div className="panel">
      <h2>Add Liquidity</h2>

      {/* Mode */}
      <div className="field-group">
        <label className="field-label">Mode</label>
        <div className="btn-group">
          {MODES.map((m) => (
            <button
              key={m.id}
              className={`tier-btn ${mode === m.id ? 'active' : ''}`}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        {mode === 'sell-order' && (
          <p className="hint info">Deposits only {symbol0}. Acts as a sell limit order — {symbol0} is sold for {symbol1} as price rises through your range.</p>
        )}
        {mode === 'buy-order' && (
          <p className="hint info">Deposits only {symbol1}. Acts as a buy limit order — {symbol1} is used to buy {symbol0} as price falls through your range.</p>
        )}
      </div>

      {/* Fee tier */}
      <div className="field-group">
        <label className="field-label">Fee Tier</label>
        <div className="btn-group">
          {FEE_TIERS.map((t) => (
            <button
              key={t.fee}
              className={`tier-btn ${feeTier === t.fee ? 'active' : ''}`}
              onClick={() => setFeeTier(t.fee)}
            >
              {t.label} <span className="muted-sm">{t.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Current price */}
      <div className="info-box tight">
        <div className="metric">
          <span>Current Price</span>
          <strong>{fmtPrice(price)} {symbol1}/{symbol0}</strong>
        </div>
        <div className="metric">
          <span>Current Tick</span>
          <strong>{currentTick}</strong>
        </div>
      </div>

      {/* Price range */}
      <div className="field-group">
        <label className="field-label">Price Range ({symbol1}/{symbol0})</label>
        <div className="range-inputs">
          <label>
            Min Price
            <input
              type="number"
              min="0"
              placeholder={fmtPrice(price * 0.9)}
              value={priceMin}
              onChange={(e) => setPriceMin(e.target.value)}
              disabled={mode === 'sell-order'}
            />
          </label>
          <label>
            Max Price
            <input
              type="number"
              min="0"
              placeholder={fmtPrice(price * 1.1)}
              value={priceMax}
              onChange={(e) => setPriceMax(e.target.value)}
              disabled={mode === 'buy-order'}
            />
          </label>
        </div>
        <div className="btn-group">
          <button className="tier-btn" onClick={() => setPreset(1.1)}>±10%</button>
          <button className="tier-btn" onClick={() => setPreset(1.25)}>±25%</button>
          <button className="tier-btn" onClick={() => setPreset(1.5)}>±50%</button>
          <button className="tier-btn" onClick={setFullRange}>Full Range</button>
        </div>
        <div className="tick-preview">
          <span>Tick Lower: <strong>{tl}</strong> = {fmtPrice(tickToPrice(tl))}</span>
          <span>Tick Upper: <strong>{tu}</strong> = {fmtPrice(tickToPrice(tu))}</span>
          <span className={inRange0 ? 'in-range' : 'out-range'}>
            {inRange0 ? '● In range' : '○ Out of range (single-sided deposit)'}
          </span>
        </div>
      </div>

      {/* Amounts */}
      <div className="field-group">
        <label className="field-label">Amounts</label>
        <label>
          {symbol0} Amount
          <input
            type="number"
            min="0"
            placeholder="0.0"
            value={amt0}
            onChange={(e) => setAmt0(e.target.value)}
            disabled={mode === 'buy-order'}
          />
        </label>
        <label>
          {symbol1} Amount
          <input
            type="number"
            min="0"
            placeholder="0.0"
            value={amt1}
            onChange={(e) => setAmt1(e.target.value)}
            disabled={mode === 'sell-order'}
          />
        </label>
      </div>

      <button onClick={addLiquidity} disabled={busy} className="btn-primary full-width">
        {busy ? 'Processing…' : 'Add Position'}
      </button>
    </div>
  );
}
