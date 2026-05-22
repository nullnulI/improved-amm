import { useState } from 'react';
import { Contract, parseUnits, formatUnits } from 'ethers';
import {
  SWAP_ROUTER_ABI, QUOTER_ABI, ERC20_ABI,
  FEE_TIERS, SLIPPAGE_PRESETS,
  sqrtPriceX96ToPrice, fmtPrice, deadline,
} from '../constants.js';

export function SwapPanel({ addrs, poolState, getSigner, account, onStatus }) {
  const [feeTier, setFeeTier]       = useState(3000);
  const [zeroForOne, setDir]        = useState(true);  // true = token0→token1
  const [amountIn, setAmountIn]     = useState('');
  const [slippageBps, setSlipBps]   = useState(50);
  const [customSlip, setCustomSlip] = useState('');
  const [quote, setQuote]           = useState(null);
  const [busy, setBusy]             = useState(false);

  if (!poolState) return <div className="panel"><p className="muted">Load a pool first.</p></div>;

  const { token0, token1, symbol0, symbol1, price, sqrtPriceX96 } = poolState;
  const tokenIn  = zeroForOne ? token0 : token1;
  const tokenOut = zeroForOne ? token1 : token0;
  const symIn    = zeroForOne ? symbol0 : symbol1;
  const symOut   = zeroForOne ? symbol1 : symbol0;
  const effectiveBps = customSlip ? Math.round(parseFloat(customSlip) * 100) : slippageBps;

  async function getQuote() {
    if (!amountIn || isNaN(+amountIn) || +amountIn <= 0) return;
    setBusy(true);
    onStatus('Fetching quote...');
    try {
      const signer  = await getSigner();
      const quoter  = new Contract(addrs.QUOTER, QUOTER_ABI, signer);
      const parsed  = parseUnits(amountIn, 18);
      const amtOut  = await quoter.quoteExactInputSingle.staticCall(tokenIn, tokenOut, feeTier, parsed, 0n);
      // execPrice = tokenOut received per tokenIn spent (same units as spotP)
      const execPrice = Number(amtOut) / Number(parsed);
      const spotP = zeroForOne ? price : 1 / price;
      const impact = Math.max(0, (spotP - execPrice) / spotP) * 100;
      const minOut = (amtOut * (10000n - BigInt(effectiveBps))) / 10000n;
      setQuote({ amtOut, execPrice, impact, minOut });
      onStatus('Quote ready.');
    } catch (e) {
      onStatus(e.shortMessage || e.reason || e.message || 'Quote failed.');
    } finally { setBusy(false); }
  }

  async function swap() {
    if (!amountIn) return;
    setBusy(true);
    onStatus('Approving and swapping...');
    try {
      const signer = await getSigner();
      const token  = new Contract(tokenIn, ERC20_ABI, signer);
      const router = new Contract(addrs.SWAP_ROUTER, SWAP_ROUTER_ABI, signer);
      const parsed = parseUnits(amountIn, 18);

      const allowance = await token.allowance(account, addrs.SWAP_ROUTER);
      if (allowance < parsed) {
        const tx = await token.approve(addrs.SWAP_ROUTER, parsed * 2n);
        await tx.wait();
      }

      const minOut = quote ? quote.minOut : 1n;
      const tx = await router.exactInputSingle({
        tokenIn, tokenOut, fee: feeTier,
        recipient: account,
        deadline: deadline(),
        amountIn: parsed,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      });
      await tx.wait();
      setQuote(null);
      setAmountIn('');
      onStatus(`Swap confirmed. Received ≥${formatUnits(minOut, 18)} ${symOut}.`);
    } catch (e) {
      onStatus(e.shortMessage || e.reason || e.message || 'Swap failed.');
    } finally { setBusy(false); }
  }

  // Volatility-based fee recommendation
  const recommended = (() => {
    if (!poolState.twap5m || !poolState.twap30m) return null;
    const vol = Math.abs(poolState.twap5m - poolState.twap30m) / poolState.twap30m;
    if (vol > 0.02)  return 10000;
    if (vol > 0.005) return 3000;
    return 500;
  })();

  return (
    <div className="panel">
      <h2>Swap</h2>

      {/* Fee tier */}
      <div className="field-group">
        <label className="field-label">Fee Tier</label>
        <div className="btn-group">
          {FEE_TIERS.map((t) => (
            <button
              key={t.fee}
              className={`tier-btn ${feeTier === t.fee ? 'active' : ''} ${recommended === t.fee ? 'recommended' : ''}`}
              onClick={() => { setFeeTier(t.fee); setQuote(null); }}
            >
              {t.label}
              {recommended === t.fee && <span className="rec-badge">rec.</span>}
            </button>
          ))}
        </div>
        {recommended && (
          <p className="hint">
            Dynamic recommendation based on TWAP volatility: {FEE_TIERS.find(f => f.fee === recommended)?.desc}.
          </p>
        )}
      </div>

      {/* You pay */}
      <div className="token-box">
        <div className="token-row">
          <span className="token-label">{symIn}</span>
          <input
            type="number"
            min="0"
            placeholder="0.0"
            value={amountIn}
            onChange={(e) => { setAmountIn(e.target.value); setQuote(null); }}
            className="token-input"
          />
        </div>
      </div>

      {/* Switch direction */}
      <div style={{ textAlign: 'center' }}>
        <button
          className="icon-btn"
          onClick={() => { setDir((d) => !d); setQuote(null); setAmountIn(''); }}
          disabled={busy}
          title="Switch direction"
        >
          ⇅
        </button>
      </div>

      {/* You receive */}
      <div className="token-box out">
        <div className="token-row">
          <span className="token-label">{symOut}</span>
          <span className="token-amount">
            {quote ? formatUnits(quote.amtOut, 18) : '–'}
          </span>
        </div>
      </div>

      {/* Slippage */}
      <div className="field-group">
        <label className="field-label">Slippage Tolerance</label>
        <div className="btn-group">
          {SLIPPAGE_PRESETS.map((s) => (
            <button
              key={s.bps}
              className={`tier-btn ${slippageBps === s.bps && !customSlip ? 'active' : ''}`}
              onClick={() => { setSlipBps(s.bps); setCustomSlip(''); }}
            >
              {s.label}
            </button>
          ))}
          <input
            type="number"
            min="0"
            max="50"
            step="0.1"
            placeholder="custom %"
            value={customSlip}
            onChange={(e) => setCustomSlip(e.target.value)}
            style={{ width: 90, marginLeft: 4 }}
          />
        </div>
      </div>

      {/* Quote info */}
      {quote && (
        <div className="info-box">
          <InfoRow label="Execution Price"  value={`${fmtPrice(quote.execPrice)} ${symOut}/${symIn}`} />
          <InfoRow label="Spot Price"       value={`${fmtPrice(zeroForOne ? price : 1/price)} ${symOut}/${symIn}`} />
          <InfoRow label="Price Impact"     value={`${quote.impact.toFixed(3)}%`} warn={quote.impact > 1} />
          <InfoRow label="Min Received"     value={`${formatUnits(quote.minOut, 18)} ${symOut}`} />
          <InfoRow label="Fee Tier"         value={`${(feeTier / 10000).toFixed(2)}%`} />
        </div>
      )}

      <div className="actions">
        <button onClick={getQuote} disabled={busy || !amountIn}>Quote</button>
        <button onClick={swap}     disabled={busy || !amountIn} className="btn-primary">Swap</button>
      </div>
    </div>
  );
}

function InfoRow({ label, value, warn }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong style={warn ? { color: '#ef4444' } : {}}>{value}</strong>
    </div>
  );
}
