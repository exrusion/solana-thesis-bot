import axios from 'axios';

const BASE_URL = 'https://api.dexscreener.com';

// pump.fun bonding-curve pairs report dexId "pumpfun"; once a token
// graduates, its liquidity moves to pump.fun's own AMM, "pumpswap".
const ALLOWED_DEX_IDS = new Set(['pumpfun', 'pumpswap']);

/** Refreshes a single pair's stats by its pair address. */
export async function getPairData(pairAddress) {
  const res = await axios.get(`${BASE_URL}/latest/dex/pairs/solana/${pairAddress}`);
  const pair = res.data?.pairs?.[0];
  return pair ? normalizePair(pair) : null;
}

/**
 * Looks up a token by mint address — used for mints detected directly
 * on-chain (fresh pump.fun creations) that don't come from the boosts
 * feed. May return null if DexScreener hasn't indexed the pair yet
 * (common for tokens only a few seconds old).
 */
export async function getPairsForMint(mintAddress) {
  try {
    const res = await axios.get(`${BASE_URL}/latest/dex/tokens/${mintAddress}`);
    const tokenPairs = res.data?.pairs || [];
    const pumpPairs = tokenPairs.filter(
      (p) => p.chainId === 'solana' && ALLOWED_DEX_IDS.has(p.dexId)
    );
    if (!pumpPairs.length) return null;

    const best = pumpPairs.reduce((a, b) =>
      (a.liquidity?.usd || 0) > (b.liquidity?.usd || 0) ? a : b
    );
    return normalizePair(best);
  } catch (err) {
    return null;
  }
}

function normalizePair(p) {
  return {
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    mintAddress: p.baseToken?.address,
    symbol: p.baseToken?.symbol,
    priceUsd: parseFloat(p.priceUsd || '0'),
    liquidityUsd: p.liquidity?.usd || 0,
    volume1h: p.volume?.h1 || 0,
    volume6h: p.volume?.h6 || 0,
    volume24h: p.volume?.h24 || 0,
    priceChange1h: p.priceChange?.h1 || 0,
    priceChange6h: p.priceChange?.h6 || 0,
    priceChange24h: p.priceChange?.h24 || 0,
    pairCreatedAt: p.pairCreatedAt,
    url: p.url,
  };
}
