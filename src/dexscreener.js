import axios from 'axios';

const BASE_URL = 'https://api.dexscreener.com';

// pump.fun bonding-curve pairs report dexId "pumpfun"; once a token
// graduates, its liquidity moves to pump.fun's own AMM, "pumpswap".
// Restricting to these two cuts out arbitrary/unknown DEX pairs.
const ALLOWED_DEX_IDS = new Set(['pumpfun', 'pumpswap']);

/**
 * Pulls currently boosted Solana tokens (a decent proxy for "active
 * right now"), then keeps only the ones actually trading on pump.fun
 * or PumpSwap. Swap this discovery source for a pump.fun-native feed
 * later if you want earlier/broader coverage.
 */
export async function getCandidatePairs() {
  const boostsRes = await axios.get(`${BASE_URL}/token-boosts/latest/v1`);
  const boosts = Array.isArray(boostsRes.data) ? boostsRes.data : [];
  const solanaBoosts = boosts.filter((b) => b.chainId === 'solana');

  const pairs = [];
  for (const boost of solanaBoosts) {
    try {
      const res = await axios.get(`${BASE_URL}/latest/dex/tokens/${boost.tokenAddress}`);
      const tokenPairs = res.data?.pairs || [];
      const pumpPairs = tokenPairs.filter(
        (p) => p.chainId === 'solana' && ALLOWED_DEX_IDS.has(p.dexId)
      );
      if (!pumpPairs.length) continue;

      const best = pumpPairs.reduce((a, b) =>
        (a.liquidity?.usd || 0) > (b.liquidity?.usd || 0) ? a : b
      );
      pairs.push(normalizePair(best));
    } catch (err) {
      continue;
    }
  }

  return pairs;
}

/** Refreshes a single pair's stats by its pair address. */
export async function getPairData(pairAddress) {
  const res = await axios.get(`${BASE_URL}/latest/dex/pairs/solana/${pairAddress}`);
  const pair = res.data?.pairs?.[0];
  return pair ? normalizePair(pair) : null;
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
