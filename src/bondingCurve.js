import axios from 'axios';
import { PublicKey } from '@solana/web3.js';
import { connection } from './rpc.js';

// Official pump.fun bonding-curve program.
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const TOKEN_DECIMALS = 6; // standard for pump.fun tokens

export function findBondingCurveAddress(mintAddress) {
  const mint = new PublicKey(mintAddress);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

/**
 * Reads the bonding curve account directly on-chain — has real data the
 * instant a token is created, with zero third-party indexing lag. This is
 * what most freshly-created pump.fun tokens actually need: DexScreener
 * often never indexes a token that never gets meaningful trading, but the
 * bonding curve account always reflects ground truth.
 *
 * Returns null once a token has migrated off the curve (layout no longer
 * applies — use DexScreener/PumpSwap data instead) or if the account
 * can't be read.
 */
export async function fetchBondingCurveState(mintAddress) {
  try {
    const pda = findBondingCurveAddress(mintAddress);
    const accountInfo = await connection.getAccountInfo(pda);
    if (!accountInfo || accountInfo.data.length < 49) return null;

    const data = accountInfo.data;
    const virtualTokenReserves = data.readBigUInt64LE(8);
    const virtualSolReserves = data.readBigUInt64LE(16);
    const realTokenReserves = data.readBigUInt64LE(24);
    const realSolReserves = data.readBigUInt64LE(32);
    const tokenTotalSupply = data.readBigUInt64LE(40);
    const complete = data[48] === 1;

    if (virtualTokenReserves === 0n) return null;

    const priceSolPerToken =
      Number(virtualSolReserves) / 1e9 / (Number(virtualTokenReserves) / 10 ** TOKEN_DECIMALS);
    const marketCapSol = priceSolPerToken * (Number(tokenTotalSupply) / 10 ** TOKEN_DECIMALS);

    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      complete,
      priceSolPerToken,
      realSolReservesSol: Number(realSolReserves) / 1e9,
      marketCapSol,
    };
  } catch (err) {
    return null;
  }
}

const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

/**
 * Counts recent transactions against a token's own bonding curve account.
 *
 * This replaces inferring activity from a global 1-in-8 trade sample —
 * that sample is spread across thousands of tokens, so any single token
 * showed 0-1 events no matter how busy it really was. Querying the
 * token's own account gives a true count for one extra RPC call.
 */
export async function getRecentTradeCount(mintAddress, lookbackMinutes = 15) {
  try {
    const pda = findBondingCurveAddress(mintAddress);
    const sigs = await connection.getSignaturesForAddress(pda, { limit: 400 });
    if (!sigs.length) return { total: 0, recent: 0, priorRate: 0, acceleration: null };

    const nowSec = Date.now() / 1000;
    const windowSec = lookbackMinutes * 60;

    const recent = sigs.filter((s) => s.blockTime && s.blockTime >= nowSec - windowSec).length;

    // The token's own baseline: the three windows before the current one.
    // Comparing against this instead of a fixed number is what separates
    // "always quiet" from "waking up" — an old token going from 2 to 8 is
    // accelerating hard even though 8 looks small in absolute terms.
    const priorStart = nowSec - windowSec * 4;
    const priorEnd = nowSec - windowSec;
    const priorCount = sigs.filter(
      (s) => s.blockTime && s.blockTime >= priorStart && s.blockTime < priorEnd
    ).length;
    const priorRate = priorCount / 3; // per window, averaged

    // No prior history at all means a brand-new token, not a stalled one.
    const acceleration = priorRate > 0 ? recent / priorRate : null;

    return {
      total: sigs.length,
      recent,
      priorRate,
      acceleration,
      hitLimit: sigs.length >= 400,
    };
  } catch (err) {
    return null;
  }
}

let cachedSolUsd = null;
let cachedAt = 0;
const SOL_PRICE_CACHE_MS = 5 * 60 * 1000;

/** Cached SOL/USD price so bonding-curve SOL figures can flow through the same USD thresholds used everywhere else. */
export async function getSolUsdPrice() {
  const now = Date.now();
  if (cachedSolUsd && now - cachedAt < SOL_PRICE_CACHE_MS) return cachedSolUsd;
  try {
    const res = await axios.get('https://lite-api.jup.ag/price/v3', {
      params: { ids: SOL_MINT_ADDRESS },
    });
    const price = res.data?.[SOL_MINT_ADDRESS]?.usdPrice;
    if (price) {
      cachedSolUsd = price;
      cachedAt = now;
    } else {
      console.error('[bondingCurve] SOL price response missing expected field:', JSON.stringify(res.data));
    }
  } catch (err) {
    console.error(`[bondingCurve] SOL price fetch failed: ${err.message}`);
  }
  return cachedSolUsd;
}
