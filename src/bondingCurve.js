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

    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      complete,
      priceSolPerToken,
      realSolReservesSol: Number(realSolReserves) / 1e9,
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
    const res = await axios.get('https://lite-api.jup.ag/price/v3', { params: { ids: 'SOL' } });
    const price = res.data?.SOL?.usdPrice ?? res.data?.data?.SOL?.price;
    if (price) {
      cachedSolUsd = price;
      cachedAt = now;
    }
  } catch (err) {
    // keep previous cached value (if any) on failure
  }
  return cachedSolUsd;
}
