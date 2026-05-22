import { useState, useEffect, useCallback } from 'react';
import { Contract, formatUnits } from 'ethers';
import {
  POSITION_MANAGER_ABI, POOL_ABI,
  tickToPrice, fmtPrice, fmt, deadline,
} from '../constants.js';

export function PositionsPanel({ addrs, poolState, getSigner, provider, account, onStatus }) {
  const [positions, setPositions] = useState([]);
  const [loading, setLoading]    = useState(false);
  const [busy, setBusy]          = useState(null); // tokenId being actioned

  const loadPositions = useCallback(async () => {
    if (!account || !addrs.POSITION_MANAGER || !provider) return;
    setLoading(true);
    try {
      const pm = new Contract(addrs.POSITION_MANAGER, POSITION_MANAGER_ABI, provider);

      // Find all NFTs minted to this account via Transfer(from=0, to=account)
      const filter = pm.filters.Transfer('0x0000000000000000000000000000000000000000', account);
      const events = await pm.queryFilter(filter, 0, 'latest');
      const ownedIds = [];
      for (const ev of events) {
        const id = ev.args.tokenId;
        try {
          const owner = await pm.ownerOf(id);
          if (owner.toLowerCase() === account.toLowerCase()) ownedIds.push(id);
        } catch (_) { /* burned */ }
      }

      const posData = await Promise.all(ownedIds.map(async (id) => {
        const pos = await pm.positions(id);
        const pool = new Contract(pos.pool, POOL_ABI, provider);
        const slot0 = await pool.slot0();
        const currentTick = Number(slot0.tick);
        const tl = Number(pos.tickLower);
        const tu = Number(pos.tickUpper);
        const inRange = currentTick >= tl && currentTick < tu;
        const token0  = await pool.token0();
        const token1  = await pool.token1();
        const fee     = await pool.fee();

        // Get pending fees from on-chain position
        const onChainPos = await pool.getPosition(addrs.POSITION_MANAGER, tl, tu);

        return {
          tokenId: id,
          pool: pos.pool,
          tickLower: tl,
          tickUpper: tu,
          liquidity: pos.liquidity,
          tokensOwed0: pos.tokensOwed0,
          tokensOwed1: pos.tokensOwed1,
          priceLower: tickToPrice(tl),
          priceUpper: tickToPrice(tu),
          inRange,
          token0, token1, fee: Number(fee),
        };
      }));

      setPositions(posData);
    } catch (e) {
      onStatus('Failed to load positions: ' + (e.message || e));
    } finally { setLoading(false); }
  }, [account, addrs.POSITION_MANAGER, provider, onStatus]);

  useEffect(() => { loadPositions(); }, [loadPositions]);

  async function collectFees(pos) {
    setBusy(pos.tokenId);
    onStatus('Collecting fees…');
    try {
      const signer = await getSigner();
      const pm = new Contract(addrs.POSITION_MANAGER, POSITION_MANAGER_ABI, signer);
      const MAX = 2n ** 128n - 1n;
      const tx = await pm.collect({
        tokenId: pos.tokenId,
        recipient: account,
        amount0Max: MAX,
        amount1Max: MAX,
      });
      await tx.wait();
      onStatus('Fees collected!');
      await loadPositions();
    } catch (e) {
      onStatus(e.shortMessage || e.reason || e.message || 'Collect failed.');
    } finally { setBusy(null); }
  }

  async function removeAll(pos) {
    if (!pos.liquidity || pos.liquidity === 0n) {
      onStatus('No liquidity to remove.');
      return;
    }
    setBusy(pos.tokenId);
    onStatus('Removing liquidity and collecting…');
    try {
      const signer = await getSigner();
      const pm = new Contract(addrs.POSITION_MANAGER, POSITION_MANAGER_ABI, signer);
      await (await pm.decreaseLiquidity({
        tokenId: pos.tokenId,
        liquidity: pos.liquidity,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: deadline(),
      })).wait();
      const MAX = 2n ** 128n - 1n;
      await (await pm.collect({
        tokenId: pos.tokenId,
        recipient: account,
        amount0Max: MAX,
        amount1Max: MAX,
      })).wait();
      onStatus('Liquidity removed and tokens collected!');
      await loadPositions();
    } catch (e) {
      onStatus(e.shortMessage || e.reason || e.message || 'Remove failed.');
    } finally { setBusy(null); }
  }

  const sym0 = poolState?.symbol0 ?? 'TK0';
  const sym1 = poolState?.symbol1 ?? 'TK1';

  return (
    <div className="panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>My Positions</h2>
        <button onClick={loadPositions} disabled={loading} style={{ width: 'auto', padding: '6px 14px' }}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {positions.length === 0 && !loading && (
        <p className="muted">No positions found for this wallet.</p>
      )}

      {positions.map((pos) => {
        const isBusy = busy === pos.tokenId;
        const feeLabel = (pos.fee / 10000).toFixed(2) + '%';
        const liqNum = Number(pos.liquidity);
        return (
          <div key={String(pos.tokenId)} className="position-card">
            <div className="position-header">
              <span className="pos-id">#{String(pos.tokenId)}</span>
              <span className="pos-pair">{sym0}/{sym1}</span>
              <span className="fee-badge">{feeLabel}</span>
              <span className={pos.inRange ? 'badge-green' : 'badge-gray'}>
                {pos.inRange ? '● In Range' : '○ Out of Range'}
              </span>
            </div>

            <div className="metric">
              <span>Price Range</span>
              <strong>{fmtPrice(pos.priceLower)} – {fmtPrice(pos.priceUpper)} {sym1}/{sym0}</strong>
            </div>
            <div className="metric">
              <span>Liquidity</span>
              <strong>{liqNum.toLocaleString()}</strong>
            </div>
            <div className="metric">
              <span>Claimable {sym0}</span>
              <strong>{fmt(pos.tokensOwed0)}</strong>
            </div>
            <div className="metric">
              <span>Claimable {sym1}</span>
              <strong>{fmt(pos.tokensOwed1)}</strong>
            </div>

            <div className="actions">
              <button
                onClick={() => collectFees(pos)}
                disabled={isBusy || (pos.tokensOwed0 === 0n && pos.tokensOwed1 === 0n)}
              >
                Collect Fees
              </button>
              <button
                onClick={() => removeAll(pos)}
                disabled={isBusy || pos.liquidity === 0n}
                className="btn-danger"
              >
                {isBusy ? 'Processing…' : 'Remove All'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
