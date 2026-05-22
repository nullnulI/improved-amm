// ── Chain ──────────────────────────────────────────────────────────────────────
export const REQUIRED_CHAIN_ID = 31337n;

// ── Tick / Price math ─────────────────────────────────────────────────────────
export const MIN_TICK = -887272;
export const MAX_TICK =  887272;

export function sqrtPriceX96ToPrice(sqrtPriceX96) {
  const n = Number(sqrtPriceX96) / 2 ** 96;
  return n * n;
}

export function tickToPrice(tick) {
  return Math.pow(1.0001, tick);
}

export function priceToTick(price) {
  if (price <= 0) return 0;
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

export function nearestUsableTick(tick, tickSpacing) {
  const rounded = Math.round(tick / tickSpacing) * tickSpacing;
  return Math.max(MIN_TICK, Math.min(MAX_TICK, rounded));
}

export function fmt(value, decimals = 6) {
  if (value === null || value === undefined) return '–';
  const n = typeof value === 'bigint' ? Number(value) / 1e18 : Number(value);
  if (!isFinite(n)) return '–';
  if (n === 0) return '0';
  if (Math.abs(n) < 1e-4) return n.toExponential(3);
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

export function fmtPrice(price) {
  if (!price || !isFinite(price)) return '–';
  return price.toPrecision(6);
}

export function deadline() {
  return Math.floor(Date.now() / 1000) + 3600;
}

// ── Fee tiers ──────────────────────────────────────────────────────────────────
export const FEE_TIERS = [
  { fee: 500,   label: '0.05%', tickSpacing: 10,  desc: 'Stable pairs' },
  { fee: 3000,  label: '0.30%', tickSpacing: 60,  desc: 'Most pairs' },
  { fee: 10000, label: '1.00%', tickSpacing: 200, desc: 'Exotic pairs' },
];

// ── IL Calculator (concentrated liquidity) ─────────────────────────────────────
export function computeIL(entryPrice, currentPrice, lowerPrice, upperPrice) {
  if (!entryPrice || !currentPrice || !lowerPrice || !upperPrice) return null;
  if (lowerPrice >= upperPrice || entryPrice <= 0 || currentPrice <= 0) return null;

  const P0 = entryPrice, P = currentPrice;
  const Pa = lowerPrice, Pb = upperPrice;
  const sp0 = Math.sqrt(P0), sp = Math.sqrt(P), spa = Math.sqrt(Pa), spb = Math.sqrt(Pb);

  // Normalise L so initial portfolio value = 1
  let L;
  if (P0 <= Pa)      L = 1 / ((1 / spa - 1 / spb) * P0);
  else if (P0 >= Pb) L = 1 / (spb - spa);
  else               L = 1 / (((spb - sp0) / (sp0 * spb)) * P0 + (sp0 - spa));

  function amounts(price, sqrtP) {
    if (price <= Pa) return { x: L * (1 / spa - 1 / spb), y: 0 };
    if (price >= Pb) return { x: 0, y: L * (spb - spa) };
    return { x: L * (spb - sqrtP) / (sqrtP * spb), y: L * (sqrtP - spa) };
  }

  const init = amounts(P0, sp0);
  const cur  = amounts(P, sp);
  const valueLP   = cur.x  * P + cur.y;
  const valueHold = init.x * P + init.y;
  return (valueLP / valueHold - 1) * 100;
}

// ── Slippage ───────────────────────────────────────────────────────────────────
export const SLIPPAGE_PRESETS = [
  { label: '0.1%', bps: 10 },
  { label: '0.5%', bps: 50 },
  { label: '1.0%', bps: 100 },
];

export function applySlippage(amount, bps) {
  return (amount * (10000n - BigInt(bps))) / 10000n;
}

// ── ABIs ───────────────────────────────────────────────────────────────────────
export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
];

export const POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function getTWAP(uint32 secondsAgo) view returns (int24 arithmeticMeanTick)',
  'function getPosition(address owner, int24 tickLower, int24 tickUpper) view returns (tuple(uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1))',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
];

export const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
  'function createPool(address tokenA, address tokenB, uint24 fee) returns (address)',
  'function feeAmountTickSpacing(uint24 fee) view returns (int24)',
];

export const POSITION_MANAGER_ABI = [
  'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function increaseLiquidity(tuple(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) returns (uint256 amount0, uint256 amount1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)',
  'function positions(uint256 tokenId) view returns (tuple(address pool, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1))',
  'function totalSupply() view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)',
];

export const SWAP_ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)',
  'function exactInput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) returns (uint256 amountOut)',
];

export const QUOTER_ABI = [
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) returns (uint256 amountOut)',
];
