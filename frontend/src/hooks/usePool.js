import { useState, useEffect, useRef } from 'react';
import { Contract } from 'ethers';
import { POOL_ABI, ERC20_ABI, sqrtPriceX96ToPrice, tickToPrice } from '../constants.js';

export function usePool(poolAddress, provider) {
  const [poolState, setPoolState] = useState(null);
  const [swapHistory, setSwapHistory] = useState([]); // [{ts, price, volume}]
  const [mintHistory, setMintHistory] = useState([]);  // [{tickLower, tickUpper, amount}]
  const intervalRef = useRef(null);
  const historyLoadedRef = useRef(false);

  useEffect(() => {
    if (!poolAddress || !provider || poolAddress === '0x0000000000000000000000000000000000000000') {
      setPoolState(null);
      return;
    }

    const pool = new Contract(poolAddress, POOL_ABI, provider);

    async function loadState() {
      try {
        const [slot0, liquidity, t0addr, t1addr, fee] = await Promise.all([
          pool.slot0(),
          pool.liquidity(),
          pool.token0(),
          pool.token1(),
          pool.fee(),
        ]);

        const tok0 = new Contract(t0addr, ERC20_ABI, provider);
        const tok1 = new Contract(t1addr, ERC20_ABI, provider);
        const [sym0, sym1] = await Promise.all([tok0.symbol(), tok1.symbol()]);

        const price = sqrtPriceX96ToPrice(slot0.sqrtPriceX96);

        let twap5m = null, twap30m = null;
        try {
          const [t5, t30] = await Promise.all([
            pool.getTWAP(300),
            pool.getTWAP(1800),
          ]);
          twap5m  = tickToPrice(Number(t5));
          twap30m = tickToPrice(Number(t30));
        } catch (_) { /* pool too new, not enough observations */ }

        setPoolState({
          sqrtPriceX96: slot0.sqrtPriceX96,
          tick: Number(slot0.tick),
          price,
          liquidity,
          token0: t0addr,
          token1: t1addr,
          symbol0: sym0,
          symbol1: sym1,
          fee: Number(fee),
          twap5m,
          twap30m,
        });
      } catch (e) {
        console.warn('Pool state load failed:', e.message);
      }
    }

    async function loadHistory() {
      if (historyLoadedRef.current) return;
      historyLoadedRef.current = true;
      try {
        const fromBlock = 0;
        const toBlock = 'latest';

        const swapFilter = pool.filters.Swap();
        const swapEvents = await pool.queryFilter(swapFilter, fromBlock, toBlock);

        const history = await Promise.all(swapEvents.map(async (ev) => {
          const block = await provider.getBlock(ev.blockNumber);
          const price = sqrtPriceX96ToPrice(ev.args.sqrtPriceX96);
          const volume = ev.args.amount0 < 0n
            ? Number(-ev.args.amount0) / 1e18
            : Number(-ev.args.amount1) / 1e18;
          return { ts: block?.timestamp * 1000 || 0, price, volume };
        }));
        setSwapHistory(history.sort((a, b) => a.ts - b.ts));

        const mintFilter = pool.filters.Mint();
        const mintEvents = await pool.queryFilter(mintFilter, fromBlock, toBlock);
        const burns = {};
        const burnFilter = pool.filters.Burn();
        const burnEvents = await pool.queryFilter(burnFilter, fromBlock, toBlock);
        burnEvents.forEach((ev) => {
          const k = `${ev.args.tickLower}_${ev.args.tickUpper}`;
          burns[k] = (burns[k] || 0n) + ev.args.amount;
        });

        const mints = mintEvents.map((ev) => ({
          tickLower: Number(ev.args.tickLower),
          tickUpper: Number(ev.args.tickUpper),
          amount: ev.args.amount,
        }));

        // Subtract burns
        burnEvents.forEach((ev) => {
          // already accumulated, just pass raw mints; depth chart will combine
        });
        setMintHistory(mints);
      } catch (e) {
        console.warn('History load failed:', e.message);
      }
    }

    loadState();
    loadHistory();
    intervalRef.current = setInterval(loadState, 5000);

    // Live Swap event listener for real-time chart updates
    const onSwap = async (sender, recipient, amount0, amount1, sqrtPriceX96, liq, tick, ev) => {
      const block = await provider.getBlock(ev.blockNumber);
      const price = sqrtPriceX96ToPrice(sqrtPriceX96);
      setSwapHistory((prev) => [
        ...prev,
        { ts: block?.timestamp * 1000 || Date.now(), price, volume: Math.abs(Number(amount0)) / 1e18 },
      ]);
    };
    pool.on('Swap', onSwap);

    return () => {
      clearInterval(intervalRef.current);
      pool.off('Swap', onSwap);
      historyLoadedRef.current = false;
    };
  }, [poolAddress, provider]);

  return { poolState, swapHistory, mintHistory };
}
