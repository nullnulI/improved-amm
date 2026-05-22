import React, { useState, useEffect } from 'react';
import { Contract, parseUnits, formatUnits, solidityPacked } from 'ethers';
import {
  SWAP_ROUTER_ABI, QUOTER_ABI, ERC20_ABI,
  FEE_TIERS, SLIPPAGE_PRESETS,
  fmtPrice, deadline,
} from '../constants.js';

const MODES = [
  { id: 'single', label: 'Single Hop' },
  { id: 'multi',  label: 'Multi-hop'  },
];

export function SwapPanel({ addrs, poolState, getSigner, account, onStatus }) {
  const [mode, setMode]             = useState('single');
  const [feeTier, setFeeTier]       = useState(3000);
  const [feeTier2, setFeeTier2]     = useState(3000);
  const [midToken, setMidToken]     = useState('');
  const [zeroForOne, setDir]        = useState(true);
  const [amountIn, setAmountIn]     = useState('');
  const [slippageBps, setSlipBps]   = useState(50);
  const [customSlip, setCustomSlip] = useState('');
  const [quote, setQuote]           = useState(null);
  const [busy, setBusy]             = useState(false);
  const [balanceIn, setBalIn]       = useState(null);
  const [approved, setApproved]     = useState(false);

  // Null-safe derivations so the effect below runs on every render, keeping hook
  // order stable (Rules of Hooks). The early return must come after all hooks.
  const { token0, token1, symbol0, symbol1, price } = poolState || {};
  const tokenIn  = zeroForOne ? token0 : token1;
  const tokenOut = zeroForOne ? token1 : token0;
  const symIn    = zeroForOne ? symbol0 : symbol1;
  const symOut   = zeroForOne ? symbol1 : symbol0;
  const effectiveBps = customSlip ? Math.round(parseFloat(customSlip) * 100) : slippageBps;

  // Load input token balance + approval status
  useEffect(() => {
    if (!account || !tokenIn || !addrs.SWAP_ROUTER) return;
    let cancelled = false;
    async function load() {
      try {
        const signer = await getSigner();
        const tok = new Contract(tokenIn, ERC20_ABI, signer);
        const [bal, allow] = await Promise.all([
          tok.balanceOf(account),
          tok.allowance(account, addrs.SWAP_ROUTER),
        ]);
        if (cancelled) return;
        setBalIn(bal);
        const parsed = amountIn ? parseUnits(amountIn, 18) : 0n;
        setApproved(allow >= parsed && parsed > 0n);
      } catch (_) {}
    }
    load();
    return () => { cancelled = true; };
  }, [account, tokenIn, addrs.SWAP_ROUTER, amountIn, zeroForOne]);

  if (!poolState) return <div className="panel"><p className="muted">Load a pool first.</p></div>;

  async function getQuote() {
    if (!amountIn || isNaN(+amountIn) || +amountIn <= 0) return;
    setBusy(true);
    onStatus('Fetching quote...');
    try {
      const signer = await getSigner();
      const parsed = parseUnits(amountIn, 18);

      if (mode === 'single') {
        const quoter = new Contract(addrs.QUOTER, QUOTER_ABI, signer);
        const amtOut = await quoter.quoteExactInputSingle.staticCall(tokenIn, tokenOut, feeTier, parsed, 0n);
        const spotP     = zeroForOne ? price : 1 / price;
        const execPrice = amtOut > 0n ? Number(amtOut) / Number(parsed) : 0;
        const impact    = (spotP > 0 && execPrice > 0 && isFinite(execPrice))
          ? Math.max(0, (spotP - execPrice) / spotP) * 100 : 0;
        const minOut = (amtOut * (10000n - BigInt(effectiveBps))) / 10000n;
        setQuote({ amtOut, execPrice, impact, minOut, multi: false });
      } else {
        // Multi-hop: tokenIn → midToken → tokenOut
        if (!midToken || !midToken.startsWith('0x')) {
          onStatus('Enter a valid intermediate token address.');
          setBusy(false);
          return;
        }
        // Build path and use exactInputSingle for each hop via quoter simulation
        const quoter = new Contract(addrs.QUOTER, QUOTER_ABI, signer);
        // Hop 1: tokenIn → midToken
        const hop1Out = await quoter.quoteExactInputSingle.staticCall(tokenIn, midToken, feeTier, parsed, 0n);
        // Hop 2: midToken → tokenOut
        const amtOut  = await quoter.quoteExactInputSingle.staticCall(midToken, tokenOut, feeTier2, hop1Out, 0n);
        const minOut  = (amtOut * (10000n - BigInt(effectiveBps))) / 10000n;
        setQuote({ amtOut, hop1Out, minOut, multi: true });
      }
      onStatus('Quote ready.');
    } catch (e) {
      onStatus(e.shortMessage || e.reason || e.message || 'Quote failed.');
    } finally { setBusy(false); }
  }

  async function approveToken() {
    setBusy(true);
    onStatus('Approving token...');
    try {
      const signer = await getSigner();
      const token  = new Contract(tokenIn, ERC20_ABI, signer);
      const parsed = parseUnits(amountIn || '0', 18);
      await (await token.approve(addrs.SWAP_ROUTER, parsed * 10n)).wait();
      setApproved(true);
      onStatus('Approval confirmed.');
    } catch (e) {
      onStatus(e.shortMessage || e.reason || e.message || 'Approval failed.');
    } finally { setBusy(false); }
  }

  async function swap() {
    if (!amountIn) return;
    setBusy(true);
    onStatus('Executing swap...');
    try {
      const signer  = await getSigner();
      const token   = new Contract(tokenIn, ERC20_ABI, signer);
      const router  = new Contract(addrs.SWAP_ROUTER, SWAP_ROUTER_ABI, signer);
      const parsed  = parseUnits(amountIn, 18);

      const allowance = await token.allowance(account, addrs.SWAP_ROUTER);
      if (allowance < parsed) {
        await (await token.approve(addrs.SWAP_ROUTER, parsed * 10n)).wait();
      }

      const minOut = quote ? quote.minOut : 1n;
      let receipt;

      if (mode === 'single') {
        const tx = await router.exactInputSingle({
          tokenIn, tokenOut, fee: feeTier,
          recipient: account,
          deadline: deadline(),
          amountIn: parsed,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
        });
        receipt = await tx.wait();
      } else {
        if (!midToken || !midToken.startsWith('0x')) {
          onStatus('Enter a valid intermediate token address.');
          setBusy(false);
          return;
        }
        const path = solidityPacked(
          ['address', 'uint24', 'address', 'uint24', 'address'],
          [tokenIn, feeTier, midToken, feeTier2, tokenOut]
        );
        const tx = await router.exactInput({
          path,
          recipient: account,
          deadline: deadline(),
          amountIn: parsed,
          amountOutMinimum: minOut,
        });
        receipt = await tx.wait();
      }

      setQuote(null);
      setAmountIn('');
      onStatus(`Swap confirmed ✓ — received ≥${formatUnits(minOut, 18)} ${symOut}. Tx: ${receipt.hash.slice(0, 10)}…`);
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

  const balFmt = balanceIn !== null ? (+formatUnits(balanceIn, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 }) : null;
  const needsApproval = amountIn && !approved;

  return (
    <div className="panel">
      <h2>Swap</h2>

      {/* Mode */}
      <div className="field-group">
        <label className="field-label">Swap Mode</label>
        <div className="btn-group">
          {MODES.map((m) => (
            <button
              key={m.id}
              className={`tier-btn ${mode === m.id ? 'active' : ''}`}
              onClick={() => { setMode(m.id); setQuote(null); }}
            >
              {m.label}
            </button>
          ))}
        </div>
        {mode === 'multi' && (
          <p className="hint info">
            <strong>Multi-hop:</strong> routes through two pools via an intermediate token.
            Path: {symIn} → intermediate → {symOut}.
            Enter the intermediate token address and choose a fee tier for each hop.
          </p>
        )}
      </div>

      {/* Fee tier — hop 1 */}
      <div className="field-group">
        <label className="field-label">{mode === 'multi' ? 'Hop 1 Fee Tier' : 'Fee Tier'}</label>
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
        {recommended && mode === 'single' && (
          <p className="hint">
            Dynamic recommendation based on TWAP/spot divergence — {FEE_TIERS.find((f) => f.fee === recommended)?.desc}.
          </p>
        )}
      </div>

      {/* Multi-hop: intermediate token + hop-2 fee */}
      {mode === 'multi' && (
        <div className="field-group">
          <label className="field-label">Intermediate Token Address</label>
          <input
            type="text"
            placeholder="0x..."
            value={midToken}
            onChange={(e) => { setMidToken(e.target.value); setQuote(null); }}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
          />
          <label className="field-label" style={{ marginTop: 8 }}>Hop 2 Fee Tier</label>
          <div className="btn-group">
            {FEE_TIERS.map((t) => (
              <button
                key={t.fee}
                className={`tier-btn ${feeTier2 === t.fee ? 'active' : ''}`}
                onClick={() => { setFeeTier2(t.fee); setQuote(null); }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

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
        {balFmt !== null && (
          <div className="balance-row">
            <span className="muted">Balance: {balFmt} {symIn}</span>
            <button
              className="max-btn"
              onClick={() => { setAmountIn(formatUnits(balanceIn, 18)); setQuote(null); }}
              disabled={!balanceIn || balanceIn === 0n}
            >
              MAX
            </button>
          </div>
        )}
      </div>

      {/* Switch direction (single-hop only) */}
      {mode === 'single' && (
        <div style={{ textAlign: 'center' }}>
          <button
            className="icon-btn"
            onClick={() => { setDir((d) => !d); setQuote(null); setAmountIn(''); setBalIn(null); }}
            disabled={busy}
            title="Switch direction"
          >
            ⇅
          </button>
        </div>
      )}

      {/* You receive */}
      <div className="token-box out">
        <div className="token-row">
          <span className="token-label out-label">{symOut}</span>
          <span className="token-amount">
            {quote ? (+formatUnits(quote.amtOut, 18)).toPrecision(7) : '–'}
          </span>
        </div>
        {mode === 'multi' && quote?.hop1Out && (
          <div className="balance-row">
            <span className="muted">After hop 1: {(+formatUnits(quote.hop1Out, 18)).toPrecision(6)} intermediate tokens</span>
          </div>
        )}
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
            style={{ width: 90 }}
          />
        </div>
      </div>

      {/* Quote info */}
      {quote && (
        <div className="info-box">
          {!quote.multi && (
            <>
              <InfoRow label="Execution Price"  value={`${fmtPrice(quote.execPrice)} ${symOut}/${symIn}`} />
              <InfoRow label="Spot Price"       value={`${fmtPrice(zeroForOne ? price : 1/price)} ${symOut}/${symIn}`} />
              <InfoRow label="Price Impact"     value={`${quote.impact.toFixed(3)}%`} warn={quote.impact > 1} />
            </>
          )}
          {quote.multi && (
            <InfoRow label="Route" value={`${symIn} → intermediate → ${symOut}`} />
          )}
          <InfoRow label="Min Received" value={`${(+formatUnits(quote.minOut, 18)).toPrecision(6)} ${symOut}`} />
          <InfoRow label="Fee Tier(s)"  value={
            mode === 'multi'
              ? `${(feeTier / 10000).toFixed(2)}% + ${(feeTier2 / 10000).toFixed(2)}%`
              : `${(feeTier / 10000).toFixed(2)}%`
          } />
        </div>
      )}

      {/* Action buttons */}
      <div className="actions">
        <button onClick={getQuote} disabled={busy || !amountIn}>Quote</button>
        {needsApproval && (
          <button onClick={approveToken} disabled={busy} className="btn-approve">
            Approve {symIn}
          </button>
        )}
        <button onClick={swap} disabled={busy || !amountIn} className="btn-primary">
          {busy ? 'Processing…' : 'Swap'}
        </button>
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
