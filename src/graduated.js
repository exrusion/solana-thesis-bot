import axios from 'axios';
import { PublicKey } from '@solana/web3.js';
import { connection } from './rpc.js';

/**
 * Data for tokens that have graduated off the bonding curve to PumpSwap.
 *
 * Previously this came from DexScreener, which lags badly on freshly
 * migrated pools — a live $52k token read as $0 and got rejected. These
 * sources have no indexing step at all:
 *
 *   price  -> Jupiter's price API, which quotes anything routable
 *   supply -> read straight from the mint account
 *   depth  -> an actual Jupiter quote for our real position size
 *
 * Depth measured this way is better than any reported "liquidity" number,
 * because it answers the only question that matters for us: can this
 * position actually be filled, and at what slippage.
 */

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PRICE_URL = 'https://lite-api.jup.ag/price/v3';
const QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';

async function getUsdPrice(mintAddress) {
  try {
    const res = await axios.get(PRICE_URL, { params: { ids: mintAddress }, timeout: 8000 });
    return res.data?.[mintAddress]?.usdPrice ?? null;
  } catch (err) {
    return null;
  }
}

async function getSupply(mintAddress) {
  try {
    const info = await connection.getTokenSupply(new PublicKey(mintAddress));
    return Number(info.value.amount) / 10 ** info.value.decimals;
  } catch (err) {
    return null;
  }
}

/**
 * Round-trip price impact for a given SOL size. Returns the impact as a
 * percentage — small means the position can be filled cleanly.
 */
async function getExecutableDepth(mintAddress, solAmount) {
  try {
    const res = await axios.get(QUOTE_URL, {
      params: {
        inputMint: SOL_MINT,
        outputMint: mintAddress,
        amount: Math.floor(solAmount * 1e9),
        slippageBps: 300,
      },
      timeout: 8000,
    });
    const impact = parseFloat(res.data?.priceImpactPct ?? '0');
    return { routable: true, priceImpactPct: Math.abs(impact) * 100 };
  } catch (err) {
    // No route means nothing can be traded, which is itself the answer
    return { routable: false, priceImpactPct: null };
  }
}

/** Just the price, for refreshing an open position. */
export async function getGraduatedPriceUsd(mintAddress) {
  return getUsdPrice(mintAddress);
}

/** Returns a candidate shaped like the bonding-curve ones, or null. */
export async function getGraduatedTokenData(mintAddress, positionSizeSol, solUsd) {
  const [priceUsd, supply] = await Promise.all([
    getUsdPrice(mintAddress),
    getSupply(mintAddress),
  ]);

  if (!priceUsd || !supply) return null; // not routable yet — keep watching

  // Size the depth probe well above our actual position so a token that
  // only just clears $10 is not mistaken for one with real depth.
  const probeSol = Math.max(positionSizeSol * 20, 1);
  const depth = await getExecutableDepth(mintAddress, probeSol);
  if (!depth.routable) return null;

  // Convert impact into a comparable liquidity figure: a 1% impact on a
  // probe of size X implies roughly 100X of depth on that side.
  const probeUsd = probeSol * (solUsd || 0);
  const impliedLiquidityUsd =
    depth.priceImpactPct > 0 ? (probeUsd / depth.priceImpactPct) * 100 : probeUsd * 100;

  return {
    dexId: 'pumpswap',
    mintAddress,
    priceUsd,
    marketCapUsd: priceUsd * supply,
    liquidityUsd: impliedLiquidityUsd,
    priceImpactPct: depth.priceImpactPct,
    graduated: true,
  };
}
