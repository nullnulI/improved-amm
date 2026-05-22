import React, { useState, useMemo, useEffect } from 'react';
import { Contract, formatUnits } from 'ethers';
import {
  LineChart, Line, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, ComposedChart, Area,
} from 'recharts';
import { computeIL, tickToPrice, fmtPrice, fmt, FEE_TIERS, FACTORY_ABI, POOL_ABI, DYNAMIC_FEE_ADVISOR_ABI } from '../constants.js';

export function AnalyticsPanel({ poolState, swapHistory, mintHistory, addrs, getSigner, account, onStatus }) {
  const [ilEntry, setIlEntry] = useState('');
  const [ilLower, setIlLower] = useState('');
  const [ilUpper, setIlUpper] = useState('');
  const [protocolFeeInput, setProtocolFeeInput] = useState('');
  const [pfBusy, setPfBusy]   = useState(false);
  const [onChainFeeReport, setOnChainFeeReport] = useState(null);

  // Null-safe destructure so the useMemo hooks below run on every render (Rules of
  // Hooks). The early return is placed after all hooks, before non-hook derivations.
  const { price, symbol0, symbol1, twap5m, twap30m, tick: currentTick, fee,
          feeGrowthGlobal0X128, feeGrowthGlobal1X128,
          protocolFeeDenominator, protocolFeeToken0, protocolFeeToken1,
          token0, token1 } = poolState || {};

  // ── On-chain DynamicFeeAdvisor query ─────────────────────────────────────
  useEffect(() => {
    if (!addrs?.DYNAMIC_FEE_ADVISOR || !token0 || !token1 || !fee) return;
    let cancelled = false;
    async function queryAdvisor() {
      try {
        const signer = await getSigner();
        const advisor = new Contract(addrs.DYNAMIC_FEE_ADVISOR, DYNAMIC_FEE_ADVISOR_ABI, signer);
        const report = await advisor.getVolatilityReport(token0, token1, fee);
        if (!cancelled) setOnChainFeeReport(report);
      } catch (_) { /* advisor not deployed or no pool */ }
    }
    queryAdvisor();
    return () => { cancelled = true; };
  }, [addrs?.DYNAMIC_FEE_ADVISOR, token0, token1, fee]);

  async function setProtocolFee() {
    const denom = parseInt(protocolFeeInput, 10);
    if (isNaN(denom) || (denom !== 0 && denom < 4)) {
      onStatus('Protocol fee denominator must be 0 (off) or ≥ 4.');
      return;
    }
    setPfBusy(true);
    onStatus('Setting protocol fee…');
    try {
      const signer = await getSigner();
      const factory = new Contract(addrs.FACTORY, FACTORY_ABI, signer);
      const poolAddr = await factory.getPool(poolState.token0, poolState.token1, fee);
      await (await factory.setPoolProtocolFee(poolAddr, denom)).wait();
      onStatus(`Protocol fee set to ${denom === 0 ? 'disabled' : `1/${denom} of swap fees`}.`);
      setProtocolFeeInput('');
    } catch (e) {
      onStatus(e.shortMessage || e.reason || e.message || 'Failed.');
    } finally { setPfBusy(false); }
  }

  async function collectProtocolFees() {
    setPfBusy(true);
    onStatus('Collecting protocol fees…');
    try {
      const signer = await getSigner();
      const factory = new Contract(addrs.FACTORY, FACTORY_ABI, signer);
      const poolAddr = await factory.getPool(poolState.token0, poolState.token1, fee);
      await (await factory.collectPoolProtocol(poolAddr, account)).wait();
      onStatus('Protocol fees collected ✓.');
    } catch (e) {
      onStatus(e.shortMessage || e.reason || e.message || 'Collect failed.');
    } finally { setPfBusy(false); }
  }

  // ── Price + Volume combined chart ────────────────────────────────────────────
  const priceData = useMemo(() => {
    if (!swapHistory.length) return [];
    return swapHistory.map((s, i) => ({
      i,
      time:   new Date(s.ts).toLocaleTimeString(),
      price:  +s.price.toPrecision(6),
      volume: +s.volume.toFixed(4),
    }));
  }, [swapHistory]);

  const totalVolume = useMemo(
    () => swapHistory.reduce((acc, s) => acc + s.volume, 0),
    [swapHistory]
  );

  // ── Liquidity depth chart ─────────────────────────────────────────────────────
  const depthData = useMemo(() => {
    if (!mintHistory.length) return [];
    const BUCKETS = 24;
    const tickSpacing = FEE_TIERS.find((f) => f.fee === fee)?.tickSpacing ?? 60;
    const windowHalf  = BUCKETS * tickSpacing;
    const lo = currentTick - windowHalf;
    const hi = currentTick + windowHalf;
    const bSize = (hi - lo) / BUCKETS;

    const buckets = Array.from({ length: BUCKETS }, (_, i) => ({
      tickStart: Math.round(lo + i * bSize),
      tickEnd:   Math.round(lo + (i + 1) * bSize),
      liquidity: 0,
    }));

    mintHistory.forEach(({ tickLower, tickUpper, amount }) => {
      buckets.forEach((b) => {
        const overlap = Math.min(tickUpper, b.tickEnd) - Math.max(tickLower, b.tickStart);
        if (overlap > 0) b.liquidity += Number(amount) * (overlap / bSize);
      });
    });

    return buckets.map((b) => ({
      price:    fmtPrice(tickToPrice(Math.round((b.tickStart + b.tickEnd) / 2))),
      liquidity: +b.liquidity.toFixed(0),
      active:   currentTick >= b.tickStart && currentTick < b.tickEnd,
    }));
  }, [mintHistory, currentTick, fee]);

  // ── Volatility & dynamic fee recommendation ───────────────────────────────────
  const volatilityHint = useMemo(() => {
    if (!twap5m || !twap30m) return null;
    const vol = Math.abs(twap5m - twap30m) / twap30m * 100;
    if (vol > 2)   return { level: 'High',   color: '#ef4444', tier: '1.00%', vol };
    if (vol > 0.5) return { level: 'Medium', color: '#f59e0b', tier: '0.30%', vol };
    return           { level: 'Low',    color: '#22c55e', tier: '0.05%', vol };
  }, [twap5m, twap30m]);

  if (!poolState) return <div className="panel"><p className="muted">Load a pool first.</p></div>;

  // ── IL calculator ────────────────────────────────────────────────────────────
  const entry   = parseFloat(ilEntry) || price;
  const lower   = parseFloat(ilLower) || price * 0.9;
  const upper   = parseFloat(ilUpper) || price * 1.1;
  const il      = computeIL(entry, price, lower, upper);
  const ilColor = il === null ? '#64748b' : il < -5 ? '#ef4444' : il < -1 ? '#f59e0b' : '#22c55e';

  // Compare vs full-range IL
  const ilFullRange = computeIL(entry, price, 1e-18, 1e18); // approximate full range

  return (
    <div className="panel analytics">
      <h2>Analytics</h2>

      {/* ── Price Oracle ── */}
      <section className="analytics-section">
        <h3>Price Oracle (TWAP)</h3>
        <div className="oracle-grid">
          <OracleCard label="Spot Price"  value={fmtPrice(price)}  unit={`${symbol1}/${symbol0}`} />
          <OracleCard label="TWAP 5m"    value={twap5m  ? fmtPrice(twap5m)  : 'No history'} unit={twap5m  ? `${symbol1}/${symbol0}` : ''} />
          <OracleCard label="TWAP 30m"   value={twap30m ? fmtPrice(twap30m) : 'No history'} unit={twap30m ? `${symbol1}/${symbol0}` : ''} />
        </div>
        {twap5m && twap30m && (
          <div className="metric" style={{ marginTop: 8 }}>
            <span>TWAP divergence (5m vs 30m)</span>
            <strong>{(Math.abs(twap5m - twap30m) / twap30m * 100).toFixed(4)}%</strong>
          </div>
        )}
      </section>

      {/* ── On-chain DynamicFeeAdvisor ── */}
      {onChainFeeReport && (
        <section className="analytics-section">
          <h3>On-Chain Fee Advisor <span style={{ fontSize: 11, color: '#64748b', fontWeight: 400 }}>(DynamicFeeAdvisor contract)</span></h3>
          {(() => {
            const lvlLabels = ['Low', 'Medium', 'High'];
            const lvlColors = ['#22c55e', '#f59e0b', '#ef4444'];
            const lvl = Number(onChainFeeReport.volatilityLevel);
            const feePct = (Number(onChainFeeReport.recommendedFeeTier) / 10000).toFixed(2);
            const color = lvlColors[lvl] || '#64748b';
            return (
              <div className="vol-hint" style={{ borderLeftColor: color }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ color }}>Volatility: {lvlLabels[lvl]}</strong>
                  <span className="muted">Tick divergence: {onChainFeeReport.tickDivergence.toString()}</span>
                </div>
                <p style={{ marginTop: 4, fontWeight: 700 }}>On-chain Recommended: {feePct}% fee tier</p>
                <p className="hint" style={{ marginTop: 4 }}>
                  {onChainFeeReport.hasSufficientHistory
                    ? 'Based on 5-min vs 30-min TWAP from the oracle.'
                    : 'Insufficient TWAP history — using spot price fallback.'}
                </p>
              </div>
            );
          })()}
        </section>
      )}

      {/* ── Dynamic fee recommendation ── */}
      {volatilityHint && (
        <section className="analytics-section">
          <h3>Dynamic Fee Recommendation</h3>
          <div className="vol-hint" style={{ borderLeftColor: volatilityHint.color }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ color: volatilityHint.color }}>Volatility: {volatilityHint.level}</strong>
              <span className="muted">({volatilityHint.vol.toFixed(4)}% TWAP divergence)</span>
            </div>
            <p className="hint" style={{ marginTop: 6 }}>
              {volatilityHint.level === 'High'   && 'High inter-period price divergence — LPs on 1.00% pools earn more fee income to compensate for elevated impermanent loss risk.'}
              {volatilityHint.level === 'Medium' && 'Moderate volatility — 0.30% balances fee income against volume. Most LP capital should sit here.'}
              {volatilityHint.level === 'Low'    && 'Low volatility — volume-sensitive pairs benefit from 0.05% to maximise trading flow.'}
            </p>
            <p style={{ marginTop: 4, fontWeight: 700 }}>Recommended: {volatilityHint.tier} fee tier</p>
          </div>
        </section>
      )}

      {/* ── Price + Volume Chart ── */}
      <section className="analytics-section">
        <h3>Price History & Volume</h3>
        <div className="chart-meta">
          <span>Swaps: <strong>{priceData.length}</strong></span>
          <span>Total Volume: <strong>{totalVolume.toFixed(4)} {symbol0}</strong></span>
        </div>
        {priceData.length === 0 ? (
          <p className="muted">No swaps yet — execute some swaps to see price history.</p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={priceData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="time" tick={{ fontSize: 10 }} />
              <YAxis yAxisId="price" domain={['auto', 'auto']} tick={{ fontSize: 11 }} width={70}
                tickFormatter={(v) => v.toPrecision(4)} />
              <YAxis yAxisId="vol" orientation="right" tick={{ fontSize: 10 }} width={50}
                tickFormatter={(v) => v.toFixed(2)} />
              <Tooltip />
              <Bar yAxisId="vol" dataKey="volume" fill="#93c5fd" opacity={0.5} name={`Volume (${symbol0})`} />
              <Line yAxisId="price" type="monotone" dataKey="price" stroke="#2563eb"
                dot={false} strokeWidth={2} name={`Price (${symbol1}/${symbol0})`} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </section>

      {/* ── Liquidity Depth Chart ── */}
      <section className="analytics-section">
        <h3>Liquidity Depth (Net Positions)</h3>
        {depthData.length === 0 ? (
          <p className="muted">No liquidity positions detected.</p>
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={depthData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="price" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 11 }} width={60} />
              <Tooltip />
              <Bar dataKey="liquidity" radius={[2, 2, 0, 0]} name="Net Liquidity">
                {depthData.map((d, i) => (
                  <Cell key={i} fill={d.active ? '#f59e0b' : '#2563eb'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
        <p className="hint">
          <span style={{ color: '#f59e0b' }}>■</span> Active bucket (current price) &nbsp;
          <span style={{ color: '#2563eb' }}>■</span> Inactive — net liquidity after burns subtracted.
        </p>
      </section>

      {/* ── Fee Accumulation ── */}
      {(feeGrowthGlobal0X128 !== undefined) && (
        <section className="analytics-section">
          <h3>Fee Accumulation</h3>
          <div className="oracle-grid">
            <OracleCard
              label={`feeGrowth ${symbol0}`}
              value={feeGrowthGlobal0X128 > 0n ? 'Fees accrued' : 'Zero'}
              unit={feeGrowthGlobal0X128 > 0n ? `Q128: ${feeGrowthGlobal0X128.toString().slice(0,10)}…` : ''}
            />
            <OracleCard
              label={`feeGrowth ${symbol1}`}
              value={feeGrowthGlobal1X128 > 0n ? 'Fees accrued' : 'Zero'}
              unit={feeGrowthGlobal1X128 > 0n ? `Q128: ${feeGrowthGlobal1X128.toString().slice(0,10)}…` : ''}
            />
            <OracleCard
              label="Pool Fee Tier"
              value={`${(fee / 10000).toFixed(2)}%`}
              unit={`per swap`}
            />
          </div>
          <p className="hint">
            feeGrowthGlobal accumulates as Q128 fixed-point per unit of liquidity.
            Each LP's share is proportional to their liquidity×time in range.
          </p>
        </section>
      )}

      {/* ── Protocol Fee (POL) ── */}
      <section className="analytics-section">
        <h3>Protocol Owned Liquidity — Fee Control</h3>
        <div className="oracle-grid">
          <OracleCard
            label="Protocol Fee"
            value={protocolFeeDenominator === 0 ? 'Disabled' : `1/${protocolFeeDenominator} of swap fees`}
            unit={protocolFeeDenominator > 0 ? `${(100 / protocolFeeDenominator).toFixed(1)}% of LP fee` : ''}
          />
          <OracleCard
            label={`Accrued ${symbol0}`}
            value={protocolFeeToken0 !== undefined && protocolFeeToken0 > 0n ? (+formatUnits(protocolFeeToken0, 18)).toPrecision(6) : '0'}
            unit={symbol0}
          />
          <OracleCard
            label={`Accrued ${symbol1}`}
            value={protocolFeeToken1 !== undefined && protocolFeeToken1 > 0n ? (+formatUnits(protocolFeeToken1, 18)).toPrecision(6) : '0'}
            unit={symbol1}
          />
        </div>
        <p className="hint">
          Protocol fee is set by the factory owner (POL mechanism). A denominator of N means 1/N of each
          swap fee is redirected to the protocol treasury rather than LP fee growth.
          This enables sustainable protocol revenue without increasing costs to traders.
        </p>
        {account && addrs?.FACTORY && (
          <div className="il-grid" style={{ marginTop: 8 }}>
            <label>
              Set Denominator (0=off, ≥4=on)
              <input
                type="number" min="0" placeholder="e.g. 5"
                value={protocolFeeInput}
                onChange={(e) => setProtocolFeeInput(e.target.value)}
              />
            </label>
          </div>
        )}
        {account && addrs?.FACTORY && (
          <div className="actions" style={{ marginTop: 8 }}>
            <button onClick={setProtocolFee} disabled={pfBusy} className="btn-sm">
              {pfBusy ? 'Processing…' : 'Set Protocol Fee'}
            </button>
            <button onClick={collectProtocolFees} disabled={pfBusy} className="btn-sm">
              {pfBusy ? 'Processing…' : 'Collect Protocol Fees'}
            </button>
          </div>
        )}
      </section>

      {/* ── IL Calculator ── */}
      <section className="analytics-section">
        <h3>Impermanent Loss Calculator (Concentrated Liquidity)</h3>
        <p className="hint">
          Computes IL for a V3 concentrated position vs simply holding initial assets.
          Current price is auto-filled.
        </p>
        <div className="il-grid">
          <label>
            Entry Price ({symbol1}/{symbol0})
            <input type="number" min="0" placeholder={fmtPrice(price)}
              value={ilEntry} onChange={(e) => setIlEntry(e.target.value)} />
          </label>
          <label>
            Range Lower
            <input type="number" min="0" placeholder={fmtPrice(price * 0.9)}
              value={ilLower} onChange={(e) => setIlLower(e.target.value)} />
          </label>
          <label>
            Range Upper
            <input type="number" min="0" placeholder={fmtPrice(price * 1.1)}
              value={ilUpper} onChange={(e) => setIlUpper(e.target.value)} />
          </label>
        </div>

        {/* IL result comparison */}
        <div className="il-compare">
          <div className="il-card" style={{ borderColor: ilColor }}>
            <span className="il-label">Concentrated IL</span>
            <span className="il-value" style={{ color: ilColor }}>
              {il !== null ? `${il > 0 ? '+' : ''}${il.toFixed(3)}%` : '—'}
            </span>
            <span className="il-sub">Range: {fmtPrice(lower)} – {fmtPrice(upper)}</span>
          </div>
          <div className="il-card" style={{ borderColor: '#94a3b8' }}>
            <span className="il-label">Full-Range IL</span>
            <span className="il-value" style={{ color: '#94a3b8' }}>
              {ilFullRange !== null ? `${ilFullRange.toFixed(3)}%` : '—'}
            </span>
            <span className="il-sub">Unbounded (V2 style)</span>
          </div>
        </div>

        {il !== null && (
          <p className="hint">
            {il < -10 ? '⚠ Severe IL — price has moved far outside your range. Consider rebalancing.' :
             il < -5  ? 'Significant IL — tight range with large price movement amplifies exposure.' :
             il < -1  ? 'Moderate IL — typical for in-range concentrated positions.' :
             il < 0   ? 'Minimal IL — price is close to entry.' :
                        'Price has moved back toward entry (beneficial rebalancing).'}
          </p>
        )}

        {/* IL vs Price Curve */}
        <ILChart entryPrice={entry} lowerPrice={lower} upperPrice={upper} currentPrice={price} symbol1={symbol1} symbol0={symbol0} />
      </section>
    </div>
  );
}

function OracleCard({ label, value, unit }) {
  return (
    <div className="oracle-card">
      <span className="oracle-label">{label}</span>
      <strong className="oracle-value">{value}</strong>
      {unit && <span className="oracle-unit">{unit}</span>}
    </div>
  );
}

function ILChart({ entryPrice, lowerPrice, upperPrice, currentPrice, symbol0, symbol1 }) {
  const data = useMemo(() => {
    if (!entryPrice || !lowerPrice || !upperPrice) return [];
    const lo = lowerPrice * 0.75;
    const hi = upperPrice * 1.25;
    const N  = 50;
    return Array.from({ length: N }, (_, i) => {
      const p  = lo + (hi - lo) * (i / (N - 1));
      const il = computeIL(entryPrice, p, lowerPrice, upperPrice);
      return { price: +p.toPrecision(4), il: il !== null ? +il.toFixed(3) : 0 };
    });
  }, [entryPrice, lowerPrice, upperPrice]);

  if (!data.length) return null;

  return (
    <ResponsiveContainer width="100%" height={160} style={{ marginTop: 12 }}>
      <LineChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="price" tick={{ fontSize: 10 }} interval="preserveStartEnd" label={{ value: `Price (${symbol1}/${symbol0})`, position: 'insideBottom', offset: -2, fontSize: 10 }} />
        <YAxis tick={{ fontSize: 11 }} width={56} tickFormatter={(v) => v.toFixed(1) + '%'} />
        <Tooltip formatter={(v) => v.toFixed(3) + '%'} />
        <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="4 2" />
        <ReferenceLine x={+currentPrice.toPrecision(4)} stroke="#2563eb"
          label={{ value: 'now', position: 'top', fontSize: 10, fill: '#2563eb' }} />
        <ReferenceLine x={+lowerPrice.toPrecision(4)} stroke="#f59e0b" strokeDasharray="3 2" />
        <ReferenceLine x={+upperPrice.toPrecision(4)} stroke="#f59e0b" strokeDasharray="3 2"
          label={{ value: 'range', position: 'top', fontSize: 9, fill: '#f59e0b' }} />
        <Line type="monotone" dataKey="il" stroke="#ef4444" dot={false} strokeWidth={2} name="IL %" />
      </LineChart>
    </ResponsiveContainer>
  );
}
