import { useState, useMemo } from 'react';
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { computeIL, tickToPrice, fmtPrice, FEE_TIERS } from '../constants.js';

export function AnalyticsPanel({ poolState, swapHistory, mintHistory }) {
  const [ilEntry, setIlEntry]   = useState('');
  const [ilLower, setIlLower]   = useState('');
  const [ilUpper, setIlUpper]   = useState('');

  if (!poolState) return <div className="panel"><p className="muted">Load a pool first.</p></div>;

  const { price, symbol0, symbol1, twap5m, twap30m, tick: currentTick, fee } = poolState;

  // ── Price chart ──────────────────────────────────────────────────────────────
  const priceData = useMemo(() => {
    if (!swapHistory.length) return [];
    return swapHistory.map((s) => ({
      time: new Date(s.ts).toLocaleTimeString(),
      price: +s.price.toPrecision(6),
      volume: +s.volume.toFixed(4),
    }));
  }, [swapHistory]);

  // ── Liquidity depth chart ────────────────────────────────────────────────────
  const depthData = useMemo(() => {
    if (!mintHistory.length || !currentTick) return [];
    const BUCKETS = 20;
    const tickSpacing = FEE_TIERS.find(f => f.fee === fee)?.tickSpacing ?? 60;
    const windowHalf  = BUCKETS * tickSpacing;
    const lo = currentTick - windowHalf;
    const hi = currentTick + windowHalf;
    const bucketSize = (hi - lo) / BUCKETS;

    const buckets = Array.from({ length: BUCKETS }, (_, i) => ({
      tickStart: Math.round(lo + i * bucketSize),
      tickEnd:   Math.round(lo + (i + 1) * bucketSize),
      liquidity: 0,
    }));

    mintHistory.forEach(({ tickLower, tickUpper, amount }) => {
      buckets.forEach((b) => {
        const overlap = Math.min(tickUpper, b.tickEnd) - Math.max(tickLower, b.tickStart);
        if (overlap > 0) b.liquidity += Number(amount) * (overlap / bucketSize);
      });
    });

    return buckets.map((b) => ({
      price: fmtPrice(tickToPrice(Math.round((b.tickStart + b.tickEnd) / 2))),
      liquidity: +b.liquidity.toFixed(0),
      active: currentTick >= b.tickStart && currentTick < b.tickEnd,
    }));
  }, [mintHistory, currentTick, fee]);

  // ── TWAP vs Spot ─────────────────────────────────────────────────────────────
  const twapData = useMemo(() => {
    const rows = [{ name: 'Spot', value: price }];
    if (twap5m)  rows.push({ name: 'TWAP 5m', value: twap5m });
    if (twap30m) rows.push({ name: 'TWAP 30m', value: twap30m });
    return rows;
  }, [price, twap5m, twap30m]);

  // ── IL Calculator ─────────────────────────────────────────────────────────────
  const il = useMemo(() => {
    const entry = parseFloat(ilEntry) || price;
    const lower = parseFloat(ilLower) || price * 0.9;
    const upper = parseFloat(ilUpper) || price * 1.1;
    return computeIL(entry, price, lower, upper);
  }, [ilEntry, ilLower, ilUpper, price]);

  // ── Volatility hint ──────────────────────────────────────────────────────────
  const volatilityHint = useMemo(() => {
    if (!twap5m || !twap30m) return null;
    const vol = Math.abs(twap5m - twap30m) / twap30m * 100;
    if (vol > 2)   return { level: 'High', color: '#ef4444', tier: '1.00%', msg: 'High recent volatility — 1.00% fee tier captures more fees as LP.' };
    if (vol > 0.5) return { level: 'Medium', color: '#f59e0b', tier: '0.30%', msg: 'Moderate volatility — 0.30% fee tier is optimal.' };
    return { level: 'Low', color: '#22c55e', tier: '0.05%', msg: 'Low volatility — 0.05% fee tier maximises volume capture.' };
  }, [twap5m, twap30m]);

  const ilColor = il === null ? '#64748b' : il < -5 ? '#ef4444' : il < -1 ? '#f59e0b' : '#22c55e';

  return (
    <div className="panel analytics">
      <h2>Analytics</h2>

      {/* ── Oracle & Volatility ── */}
      <section className="analytics-section">
        <h3>Price Oracle</h3>
        <div className="oracle-grid">
          <OracleCard label="Spot Price"  value={fmtPrice(price)}  unit={`${symbol1}/${symbol0}`} />
          <OracleCard label="TWAP 5m"    value={twap5m  ? fmtPrice(twap5m)  : 'Insufficient history'} unit={twap5m  ? `${symbol1}/${symbol0}` : ''} />
          <OracleCard label="TWAP 30m"   value={twap30m ? fmtPrice(twap30m) : 'Insufficient history'} unit={twap30m ? `${symbol1}/${symbol0}` : ''} />
        </div>
        {volatilityHint && (
          <div className="vol-hint" style={{ borderLeftColor: volatilityHint.color }}>
            <strong style={{ color: volatilityHint.color }}>Volatility: {volatilityHint.level}</strong>
            <br />{volatilityHint.msg}
            <br /><strong>Recommended fee tier: {volatilityHint.tier}</strong>
          </div>
        )}
      </section>

      {/* ── Price History Chart ── */}
      <section className="analytics-section">
        <h3>Price History</h3>
        {priceData.length === 0 ? (
          <p className="muted">No swaps yet — execute some swaps to see the price chart.</p>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={priceData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="time" tick={{ fontSize: 11 }} />
              <YAxis domain={['auto', 'auto']} tick={{ fontSize: 11 }} width={70}
                tickFormatter={(v) => v.toPrecision(4)} />
              <Tooltip formatter={(v) => v.toPrecision(6)} />
              <Line type="monotone" dataKey="price" stroke="#2563eb" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </section>

      {/* ── Liquidity Depth Chart ── */}
      <section className="analytics-section">
        <h3>Liquidity Depth</h3>
        {depthData.length === 0 ? (
          <p className="muted">No liquidity positions detected.</p>
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={depthData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="price" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 11 }} width={60} />
              <Tooltip />
              <Bar
                dataKey="liquidity"
                fill="#2563eb"
                radius={[2, 2, 0, 0]}
                label={false}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
        <p className="hint">Bars show active liquidity by price bucket. Current price is {fmtPrice(price)} {symbol1}/{symbol0}.</p>
      </section>

      {/* ── IL Calculator ── */}
      <section className="analytics-section">
        <h3>Impermanent Loss Calculator</h3>
        <p className="hint">
          Computes concentrated-liquidity IL for a position in [{symbol1}/{symbol0}] terms.
        </p>
        <div className="il-grid">
          <label>
            Entry Price ({symbol1}/{symbol0})
            <input
              type="number"
              min="0"
              placeholder={fmtPrice(price)}
              value={ilEntry}
              onChange={(e) => setIlEntry(e.target.value)}
            />
          </label>
          <label>
            Range Lower
            <input
              type="number"
              min="0"
              placeholder={fmtPrice(price * 0.9)}
              value={ilLower}
              onChange={(e) => setIlLower(e.target.value)}
            />
          </label>
          <label>
            Range Upper
            <input
              type="number"
              min="0"
              placeholder={fmtPrice(price * 1.1)}
              value={ilUpper}
              onChange={(e) => setIlUpper(e.target.value)}
            />
          </label>
        </div>
        <div className="il-result" style={{ color: ilColor }}>
          {il === null
            ? 'Enter valid price range'
            : `IL: ${il > 0 ? '+' : ''}${il.toFixed(3)}%`}
        </div>
        {il !== null && (
          <p className="hint">
            {il < -5  ? 'Significant impermanent loss — tight range amplifies exposure.' :
             il < -1  ? 'Moderate IL — common for concentrated positions with price movement.' :
             il < 0   ? 'Minimal IL — price is close to your entry.' :
                        'Positive rebalancing effect (price moved back toward entry).'}
          </p>
        )}

        {/* IL vs price ratio chart */}
        <ILChart
          entryPrice={parseFloat(ilEntry) || price}
          lowerPrice={parseFloat(ilLower) || price * 0.9}
          upperPrice={parseFloat(ilUpper) || price * 1.1}
          currentPrice={price}
        />
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

function ILChart({ entryPrice, lowerPrice, upperPrice, currentPrice }) {
  const data = useMemo(() => {
    if (!entryPrice || !lowerPrice || !upperPrice) return [];
    const lo = lowerPrice * 0.8;
    const hi = upperPrice * 1.2;
    const points = 40;
    return Array.from({ length: points }, (_, i) => {
      const p = lo + (hi - lo) * (i / (points - 1));
      const il = computeIL(entryPrice, p, lowerPrice, upperPrice);
      return { price: +p.toPrecision(4), il: il !== null ? +il.toFixed(3) : 0 };
    });
  }, [entryPrice, lowerPrice, upperPrice]);

  if (!data.length) return null;

  return (
    <ResponsiveContainer width="100%" height={160} style={{ marginTop: 12 }}>
      <LineChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="price" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 11 }} width={56} tickFormatter={(v) => v.toFixed(1) + '%'} />
        <Tooltip formatter={(v) => v.toFixed(3) + '%'} />
        <ReferenceLine y={0} stroke="#94a3b8" />
        <ReferenceLine x={+currentPrice.toPrecision(4)} stroke="#2563eb" strokeDasharray="4 2" label={{ value: 'now', position: 'top', fontSize: 10 }} />
        <Line type="monotone" dataKey="il" stroke="#ef4444" dot={false} strokeWidth={2} name="IL %" />
      </LineChart>
    </ResponsiveContainer>
  );
}
