import { useState } from 'react';
import { Contract, parseUnits, formatUnits } from 'ethers';
import {
  POSITION_MANAGER_ABI, FACTORY_ABI, ERC20_ABI,
  FEE_TIERS, SLIPPAGE_PRESETS,
  priceToTick, tickToPrice, nearestUsableTick, fmtPrice, deadline,
} from '../constants.js';

const MODES = [
  { id: 'range',      label: 'Range Liquidity',            hint: null },
  { id: 'sell-order', label: 'Sell Order ↑ (above price)', hint: null },
  { id: 'buy-order',  label: 'Buy Order ↓ (below price)',  hint: null },
];

export function LiquidityPanel({ addrs, poolState, getSigner, account, onStatus }) {
  const [feeTier, setFeeTier]   = useState(3000);
  const [mode, setMode]         = useState('range');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [amt0, setAmt0]         = useState('');
  const [amt1, setAmt1]         = useState('');
  const [slipBps, setSlipBps]   = useState(50);
  const [customSlip, setCustomSlip] = useState('');
  const [busy, setBusy]         = useState(false);
  const [lastResult, setResult] = useState(null);

  if (!poolState) return <div className="panel"><p className="muted">Load a pool first.</p></div>;

  const { token0, token1, symbol0, symbol1, price, tick: currentTick } = poolState;
  const tier = FEE_TIERS.find((t) => t.fee === feeTier);
  const effectiveBps = customSlip ? Math.round(parseFloat(customSlip) * 100) : slipBps;

  function setPreset(mult) {
    setPriceMin((price / mult).toPrecision(6));
    setPriceMax((price * mult).toPrecision(6));
  }

  function setFullRange() {
    setPriceMin(tickToPrice(-887220).toPrecision(6));
    setPriceMax(tickToPrice(887220).toPrecision(6));
  }

  function resolveRange() {
    const raw0 = parseFloat(priceMin) || price * 0.9;
    const raw1 = parseFloat(priceMax) || price * 1.1;
    if (mode === 'sell-order') {
      const lo = Math.max(raw0, price * 1.0005);
      const hi = Math.max(raw1, lo + Number.EPSILON);
      return { lo, hi };
    }
    if (mode === 'buy-order') {
      const hi = Math.min(raw1, price * 0.9995);
      const lo = Math.min(raw0, hi - Number.EPSILON);
      return { lo, hi };
    }
    return { lo: Math.min(raw0, raw1), hi: Math.max(raw0, raw1) };
  }

  async function addLiquidity() {
    setBusy(true);
    setResult(null);
    onStatus('Preparing mint...');
    try {
      const signer = await getSigner();
      const pm     = new Contract(addrs.POSITION_MANAGER, POSITION_MANAGER_ABI, signer);
      const t0     = new Contract(token0, ERC20_ABI, signer);
      const t1     = new Contract(token1, ERC20_ABI, signer);

      const { lo, hi } = resolveRange();
      const tl = nearestUsableTick(priceToTick(lo), tier.tickSpacing);
      const tu = nearestUsableTick(priceToTick(hi), tier.tickSpacing);
      if (tl >= tu) { onStatus('Invalid price range — lower must be < upper.'); setBusy(false); return; }

      const d0 = mode === 'buy-order'  ? 0n : parseUnits(amt0 || '0', 18);
      const d1 = mode === 'sell-order' ? 0n : parseUnits(amt1 || '0', 18);
      if (d0 === 0n && d1 === 0n) { onStatus('Enter at least one token amount.'); setBusy(false); return; }

      const minFrac = 10000n - BigInt(effectiveBps);
      const m0 = (d0 * minFrac) / 10000n;
      const m1 = (d1 * minFrac) / 10000n;

      // Approve if needed
      if (d0 > 0n) {
        const al0 = await t0.allowance(account, addrs.POSITION_MANAGER);
        if (al0 < d0) { onStatus('Approving token0...'); await (await t0.approve(addrs.POSITION_MANAGER, d0 * 10n)).wait(); }
      }
      if (d1 > 0n) {
        const al1 = await t1.allowance(account, addrs.POSITION_MANAGER);
        if (al1 < d1) { onStatus('Approving token1...'); await (await t1.approve(addrs.POSITION_MANAGER, d1 * 10n)).wait(); }
      }

      onStatus('Minting position...');
      const tx = await pm.mint({
        token0, token1, fee: feeTier,
        tickLower: tl, tickUpper: tu,
        amount0Desired: d0, amount1Desired: d1,
        amount0Min: m0, amount1Min: m1,
        recipient: account,
        deadline: deadline(),
      });
      const receipt = await tx.wait();

      // Decode IncreaseLiquidity event for actual amounts
      const iface = pm.interface;
      let actual0 = null, actual1 = null, tokenId = null;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed?.name === 'IncreaseLiquidity') {
            tokenId = parsed.args.tokenId;
            actual0 = parsed.args.amount0;
            actual1 = parsed.args.amount1;
          }
        } catch (_) {}
      }

      setResult({ tokenId, actual0, actual1 });
      setAmt0(''); setAmt1('');
      onStatus(`Position #${tokenId} minted ✓ — used ${formatUnits(actual0 ?? 0n, 18)} ${symbol0} + ${formatUnits(actual1 ?? 0n, 18)} ${symbol1}.`);
    } catch (e) {
      onStatus(e.shortMessage || e.reason || e.message || 'Mint failed.');
    } finally { setBusy(false); }
  }

  const { lo, hi } = resolveRange();
  const tl  = nearestUsableTick(priceToTick(lo), tier.tickSpacing);
  const tu  = nearestUsableTick(priceToTick(hi), tier.tickSpacing);
  const inRange = currentTick >= tl && currentTick < tu;

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
          <p className="hint info">
            <strong>Range Order — Sell {symbol0}:</strong> deposits only {symbol0} in a range above current price.
            As the price rises through your range, {symbol0} is progressively sold for {symbol1} — acts as a limit sell order.
          </p>
        )}
        {mode === 'buy-order' && (
          <p className="hint info">
            <strong>Range Order — Buy {symbol0}:</strong> deposits only {symbol1} in a range below current price.
            As the price falls through your range, {symbol1} is used to accumulate {symbol0} — acts as a limit buy order.
          </p>
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
          <span>Current Tick / Tick Spacing</span>
          <strong>{currentTick} / {tier.tickSpacing}</strong>
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
          {['±10%', '±25%', '±50%'].map((label, i) => {
            const mults = [1.1, 1.25, 1.5];
            return (
              <button key={label} className="tier-btn" onClick={() => setPreset(mults[i])}>{label}</button>
            );
          })}
          <button className="tier-btn" onClick={setFullRange}>Full Range</button>
        </div>
        <div className="tick-preview">
          <span>Tick Lower: <strong>{tl}</strong> ({fmtPrice(tickToPrice(tl))})</span>
          <span>Tick Upper: <strong>{tu}</strong> ({fmtPrice(tickToPrice(tu))})</span>
          <span className={inRange ? 'in-range' : 'out-range'}>
            {inRange ? '● In range — both tokens required' : mode !== 'range' ? '● Single-sided (range order)' : '○ Out of range — single-token deposit'}
          </span>
        </div>
      </div>

      {/* Amounts */}
      <div className="field-group">
        <label className="field-label">Deposit Amounts</label>
        <label>
          {symbol0} Amount
          <input
            type="number" min="0" placeholder="0.0"
            value={amt0}
            onChange={(e) => setAmt0(e.target.value)}
            disabled={mode === 'buy-order'}
          />
        </label>
        <label>
          {symbol1} Amount
          <input
            type="number" min="0" placeholder="0.0"
            value={amt1}
            onChange={(e) => setAmt1(e.target.value)}
            disabled={mode === 'sell-order'}
          />
        </label>
      </div>

      {/* Slippage */}
      <div className="field-group">
        <label className="field-label">Slippage Tolerance</label>
        <div className="btn-group">
          {SLIPPAGE_PRESETS.map((s) => (
            <button
              key={s.bps}
              className={`tier-btn ${slipBps === s.bps && !customSlip ? 'active' : ''}`}
              onClick={() => { setSlipBps(s.bps); setCustomSlip(''); }}
            >
              {s.label}
            </button>
          ))}
          <input
            type="number" min="0" max="50" step="0.1"
            placeholder="custom %"
            value={customSlip}
            onChange={(e) => setCustomSlip(e.target.value)}
            style={{ width: 90 }}
          />
        </div>
        <p className="hint">Min amounts: {symbol0} ≥ {amt0 ? ((parseFloat(amt0) * (1 - effectiveBps/10000)).toPrecision(5)) : '–'}, {symbol1} ≥ {amt1 ? ((parseFloat(amt1) * (1 - effectiveBps/10000)).toPrecision(5)) : '–'}</p>
      </div>

      {/* Last result */}
      {lastResult && (
        <div className="info-box">
          <div className="metric">
            <span>Position NFT ID</span>
            <strong>#{String(lastResult.tokenId)}</strong>
          </div>
          <div className="metric">
            <span>Actual {symbol0} used</span>
            <strong>{(+formatUnits(lastResult.actual0 ?? 0n, 18)).toPrecision(6)}</strong>
          </div>
          <div className="metric">
            <span>Actual {symbol1} used</span>
            <strong>{(+formatUnits(lastResult.actual1 ?? 0n, 18)).toPrecision(6)}</strong>
          </div>
        </div>
      )}

      <button onClick={addLiquidity} disabled={busy} className="btn-primary full-width">
        {busy ? 'Processing…' : 'Add Position'}
      </button>
    </div>
  );
}
