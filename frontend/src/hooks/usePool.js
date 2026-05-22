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
        const [slot0, liquidity, t0addr, t1addr, fee, fg0, fg1, protocolFeeDenom, protocolFeesData] = await Promise.all([
          pool.slot0(),
          pool.liquidity(),
          pool.token0(),
          pool.token1(),
          pool.fee(),
          pool.feeGrowthGlobal0X128(),
          pool.feeGrowthGlobal1X128(),
          pool.protocolFee().catch(() => 0),
          pool.protocolFees().catch(() => ({ token0: 0n, token1: 0n })),
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
          feeGrowthGlobal0X128: fg0,
          feeGrowthGlobal1X128: fg1,
          twap5m,
          twap30m,
          protocolFeeDenominator: Number(protocolFeeDenom),
          protocolFeeToken0: protocolFeesData.token0,
          protocolFeeToken1: protocolFeesData.token1,
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

        const [mintEvents, burnEvents] = await Promise.all([
          pool.queryFilter(pool.filters.Mint(), fromBlock, toBlock),
          pool.queryFilter(pool.filters.Burn(), fromBlock, toBlock),
        ]);

        // Build net liquidity map (mints minus burns per tick range)
        const liqMap = {};
        mintEvents.forEach((ev) => {
          const k = `${Number(ev.args.tickLower)}_${Number(ev.args.tickUpper)}`;
          if (!liqMap[k]) liqMap[k] = { tickLower: Number(ev.args.tickLower), tickUpper: Number(ev.args.tickUpper), amount: 0n };
          liqMap[k].amount += ev.args.amount;
        });
        burnEvents.forEach((ev) => {
          const k = `${Number(ev.args.tickLower)}_${Number(ev.args.tickUpper)}`;
          if (!liqMap[k]) liqMap[k] = { tickLower: Number(ev.args.tickLower), tickUpper: Number(ev.args.tickUpper), amount: 0n };
          liqMap[k].amount -= ev.args.amount;
        });
        const netMints = Object.values(liqMap).filter((m) => m.amount > 0n);
        setMintHistory(netMints);
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
      // Use the positive (input) leg as volume in token0 terms
      const volume = amount0 > 0n
        ? Number(amount0) / 1e18
        : Number(-amount1) / 1e18;
      setSwapHistory((prev) => [
        ...prev,
        { ts: block?.timestamp * 1000 || Date.now(), price, volume: Math.max(0, volume) },
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
