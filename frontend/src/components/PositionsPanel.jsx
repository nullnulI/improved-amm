import React, { useState, useEffect, useCallback } from 'react';
import { Contract, formatUnits, parseUnits } from 'ethers';
import {
  POSITION_MANAGER_ABI, POOL_ABI, ERC20_ABI,
  tickToPrice, fmtPrice, deadline,
} from '../constants.js';

export function PositionsPanel({ addrs, poolState, getSigner, provider, account, onStatus }) {
  const [positions, setPositions] = useState([]);
  const [loading, setLoading]     = useState(false);
  const [busy, setBusy]           = useState(null);
  const [expanding, setExpanding] = useState(null); // tokenId with open IncreaseLiq form
  const [addAmt0, setAddAmt0]     = useState('');
  const [addAmt1, setAddAmt1]     = useState('');
  const [jitWarnings, setJitWarn] = useState({});

  const loadPositions = useCallback(async () => {
    if (!account || !addrs.POSITION_MANAGER || !provider) return;
    setLoading(true);
    try {
      const pm = new Contract(addrs.POSITION_MANAGER, POSITION_MANAGER_ABI, provider);
      const mintFilter = pm.filters.Transfer('0x0000000000000000000000000000000000000000', account);
      const events = await pm.queryFilter(mintFilter, 0, 'latest');

      const ownedIds = (
        await Promise.all(
          events.map(async (ev) => {
            try {
              const owner = await pm.ownerOf(ev.args.tokenId);
              return owner.toLowerCase() === account.toLowerCase() ? ev.args.tokenId : null;
            } catch (_) { return null; }
          })
        )
      ).filter(Boolean);

      const posData = await Promise.all(
        ownedIds.map(async (id) => {
          const pos  = await pm.positions(id);
          const pool = new Contract(pos.pool, POOL_ABI, provider);
          const [slot0, token0, token1, fee] = await Promise.all([
            pool.slot0(),
            pool.token0(),
            pool.token1(),
            pool.fee(),
          ]);
          const tl = Number(pos.tickLower);
          const tu = Number(pos.tickUpper);
          const ct = Number(slot0.tick);

          return {
            tokenId:    id,
            pool:       pos.pool,
            tickLower:  tl,
            tickUpper:  tu,
            liquidity:  pos.liquidity,
            tokensOwed0: pos.tokensOwed0,
            tokensOwed1: pos.tokensOwed1,
            priceLower: tickToPrice(tl),
            priceUpper: tickToPrice(tu),
            inRange:    ct >= tl && ct < tu,
            token0, token1, fee: Number(fee),
          };
        })
      );

      setPositions(posData);
      await detectJIT(posData, provider);
    } catch (e) {
      onStatus('Failed to load positions: ' + (e.shortMessage || e.message));
    } finally { setLoading(false); }
  }, [account, addrs.POSITION_MANAGER, provider, onStatus]);

  // JIT Detection: flag positions where mint block == recent swap block
  async function detectJIT(posData, prov) {
    const warnings = {};
    const pm = new Contract(addrs.POSITION_MANAGER, POSITION_MANAGER_ABI, prov);
    for (const pos of posData) {
      try {
        const pool = new Contract(pos.pool, POOL_ABI, prov);
        const mintLogs = await pm.queryFilter(
          pm.filters.IncreaseLiquidity(pos.tokenId), 0, 'latest'
        );
        const swapLogs = await pool.queryFilter(pool.filters.Swap(), 0, 'latest');
        const mintBlocks = new Set(mintLogs.map((e) => e.blockNumber));
        const jit = swapLogs.some((e) => mintBlocks.has(e.blockNumber));
        if (jit) warnings[String(pos.tokenId)] = true;
      } catch (_) {}
    }
    setJitWarn(warnings);
  }

  useEffect(() => { loadPositions(); }, [loadPositions]);

  async function collectFees(pos) {
    setBusy(pos.tokenId);
    onStatus('Collecting fees…');
    try {
      const signer = await getSigner();
      const pm = new Contract(addrs.POSITION_MANAGER, POSITION_MANAGER_ABI, signer);
      const MAX = 2n ** 128n - 1n;
      const tx = await pm.collect({ tokenId: pos.tokenId, recipient: account, amount0Max: MAX, amount1Max: MAX });
      const receipt = await tx.wait();

      // Decode actual collected from Collect event
      const iface = pm.interface;
      let a0 = null, a1 = null;
      for (const log of receipt.logs) {
        try {
          const p = iface.parseLog(log);
          if (p?.name === 'Collect') { a0 = p.args.amount0; a1 = p.args.amount1; }
        } catch (_) {}
      }
      onStatus(`Fees collected ✓ — ${a0 !== null ? formatUnits(a0, 18) : '?'} ${poolState?.symbol0 ?? 'TK0'} + ${a1 !== null ? formatUnits(a1, 18) : '?'} ${poolState?.symbol1 ?? 'TK1'}.`);
      await loadPositions();
    } catch (e) {
      onStatus(e.shortMessage || e.reason || e.message || 'Collect failed.');
    } finally { setBusy(null); }
  }

  async function removeAll(pos) {
    if (!pos.liquidity || pos.liquidity === 0n) { onStatus('No liquidity to remove.'); return; }
    setBusy(pos.tokenId);
    onStatus('Removing liquidity…');
    try {
      const signer = await getSigner();
      const pm = new Contract(addrs.POSITION_MANAGER, POSITION_MANAGER_ABI, signer);
      await (await pm.decreaseLiquidity({
        tokenId: pos.tokenId,
        liquidity: pos.liquidity,
        amount0Min: 0n, amount1Min: 0n,
        deadline: deadline(),
      })).wait();
      const MAX = 2n ** 128n - 1n;
      await (await pm.collect({ tokenId: pos.tokenId, recipient: account, amount0Max: MAX, amount1Max: MAX })).wait();
      onStatus('Liquidity removed and tokens collected ✓.');
      await loadPositions();
    } catch (e) {
      onStatus(e.shortMessage || e.reason || e.message || 'Remove failed.');
    } finally { setBusy(null); }
  }

  async function increaseLiquidity(pos) {
    setBusy(pos.tokenId);
    onStatus('Adding liquidity to position…');
    try {
      const signer = await getSigner();
      const pm = new Contract(addrs.POSITION_MANAGER, POSITION_MANAGER_ABI, signer);
      const t0 = new Contract(pos.token0, ERC20_ABI, signer);
      const t1 = new Contract(pos.token1, ERC20_ABI, signer);
      const d0 = parseUnits(addAmt0 || '0', 18);
      const d1 = parseUnits(addAmt1 || '0', 18);
      if (d0 === 0n && d1 === 0n) { onStatus('Enter at least one amount.'); setBusy(null); return; }

      if (d0 > 0n) {
        const al0 = await t0.allowance(account, addrs.POSITION_MANAGER);
        if (al0 < d0) await (await t0.approve(addrs.POSITION_MANAGER, d0)).wait();
      }
      if (d1 > 0n) {
        const al1 = await t1.allowance(account, addrs.POSITION_MANAGER);
        if (al1 < d1) await (await t1.approve(addrs.POSITION_MANAGER, d1)).wait();
      }

      const tx = await pm.increaseLiquidity({
        tokenId: pos.tokenId,
        amount0Desired: d0, amount1Desired: d1,
        amount0Min: 0n, amount1Min: 0n,
        deadline: deadline(),
      });
      await tx.wait();
      setExpanding(null); setAddAmt0(''); setAddAmt1('');
      onStatus('Liquidity added to position ✓.');
      await loadPositions();
    } catch (e) {
      onStatus(e.shortMessage || e.reason || e.message || 'IncreaseLiquidity failed.');
    } finally { setBusy(null); }
  }

  const sym0 = poolState?.symbol0 ?? 'TK0';
  const sym1 = poolState?.symbol1 ?? 'TK1';

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>My Positions</h2>
        <button onClick={loadPositions} disabled={loading} className="btn-sm">
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {positions.length === 0 && !loading && (
        <p className="muted">No positions found for this wallet. Add liquidity to create one.</p>
      )}

      {positions.map((pos) => {
        const isBusy   = busy === pos.tokenId;
        const isExpand = expanding === pos.tokenId;
        const jit      = jitWarnings[String(pos.tokenId)];
        const feeLabel = `${(pos.fee / 10000).toFixed(2)}%`;
        const hasFees  = pos.tokensOwed0 > 0n || pos.tokensOwed1 > 0n;

        return (
          <div key={String(pos.tokenId)} className={`position-card ${jit ? 'jit-border' : ''}`}>
            <div className="position-header">
              <span className="pos-id">#{String(pos.tokenId)}</span>
              <span className="pos-pair">{sym0}/{sym1}</span>
              <span className="fee-badge">{feeLabel}</span>
              <span className={pos.inRange ? 'badge-green' : 'badge-gray'}>
                {pos.inRange ? '● In Range' : '○ Out of Range'}
              </span>
            </div>

            {jit && (
              <div className="jit-warning">
                ⚠ JIT Liquidity detected — this position was minted in the same block as a swap.
              </div>
            )}

            <div className="metric"><span>Price Range</span>
              <strong>{fmtPrice(pos.priceLower)} – {fmtPrice(pos.priceUpper)} {sym1}/{sym0}</strong></div>
            <div className="metric"><span>Liquidity</span>
              <strong>{Number(pos.liquidity).toLocaleString()}</strong></div>
            <div className="metric"><span>Claimable {sym0}</span>
              <strong style={pos.tokensOwed0 > 0n ? { color: '#16a34a' } : {}}>
                {(+formatUnits(pos.tokensOwed0, 18)).toPrecision(6)}</strong></div>
            <div className="metric"><span>Claimable {sym1}</span>
              <strong style={pos.tokensOwed1 > 0n ? { color: '#16a34a' } : {}}>
                {(+formatUnits(pos.tokensOwed1, 18)).toPrecision(6)}</strong></div>

            <div className="actions">
              <button onClick={() => collectFees(pos)} disabled={isBusy || !hasFees}>
                Collect Fees
              </button>
              <button
                onClick={() => { setExpanding(isExpand ? null : pos.tokenId); setAddAmt0(''); setAddAmt1(''); }}
                disabled={isBusy}
              >
                {isExpand ? 'Cancel' : '+ Add'}
              </button>
              <button onClick={() => removeAll(pos)} disabled={isBusy || pos.liquidity === 0n} className="btn-danger">
                {isBusy ? 'Processing…' : 'Remove All'}
              </button>
            </div>

            {isExpand && (
              <div className="increase-form">
                <p className="field-label">Add liquidity to position #{String(pos.tokenId)}</p>
                <div className="range-inputs">
                  <label>{sym0}<input type="number" min="0" placeholder="0.0" value={addAmt0} onChange={(e) => setAddAmt0(e.target.value)} /></label>
                  <label>{sym1}<input type="number" min="0" placeholder="0.0" value={addAmt1} onChange={(e) => setAddAmt1(e.target.value)} /></label>
                </div>
                <button className="btn-primary" onClick={() => increaseLiquidity(pos)} disabled={isBusy}>
                  {isBusy ? 'Processing…' : 'Confirm Add'}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
