import { checkMintSafety, checkHolderConcentration } from './rpc.js';
import { getRugCheckReport } from './rugcheck.js';
import { config } from './config.js';

/**
 * Runs every candidate through hard gates before it's allowed anywhere
 * near the thesis engine or the wallet. Any failure = auto-skip.
 * This is deliberately conservative — real funds are on the other side.
 */
const ALLOWED_DEX_IDS = new Set(['pumpfun', 'pumpswap']);

export async function passesSafetyFilters(pair) {
  const reasons = [];

  if (!ALLOWED_DEX_IDS.has(pair.dexId)) {
    reasons.push(`dexId "${pair.dexId}" is not pump.fun/PumpSwap — skipping`);
    return { passed: false, reasons };
  }

  if (pair.liquidityUsd < config.minLiquidityUsd) {
    reasons.push(`liquidity $${pair.liquidityUsd.toFixed(0)} below minimum $${config.minLiquidityUsd}`);
  }

  if ((pair.marketCapUsd || 0) < config.minMarketCapUsd) {
    reasons.push(`market cap $${(pair.marketCapUsd || 0).toFixed(0)} below minimum $${config.minMarketCapUsd}`);
  }

  // Volume check only applies to graduated tokens, where DexScreener gives
  // us real trade volume. For bonding-curve tokens we have no trade
  // history, so volume1h is just a copy of liquidity — checking it there
  // would silently enforce a second, stricter liquidity floor rather than
  // measuring anything new.
  const isBondingCurve = pair.dexId === 'pumpfun';
  if (!isBondingCurve && pair.volume1h < config.minHourlyVolumeUsd) {
    reasons.push(`1h volume $${pair.volume1h.toFixed(0)} below minimum $${config.minHourlyVolumeUsd}`);
  }

  if (!pair.mintAddress) {
    reasons.push('missing mint address');
    return { passed: false, reasons };
  }

  const mintSafety = await checkMintSafety(pair.mintAddress);
  if (!mintSafety.safe) {
    reasons.push(mintSafety.reason);
  }

  const holderSafety = await checkHolderConcentration(pair.mintAddress);
  if (!holderSafety.safe) {
    reasons.push(holderSafety.reason);
  }

  // RugCheck's ML-based scoring — a much broader signal set than our own
  // basic checks (LP locks, sniper/bundler wallets, metadata mutability,
  // insider concentration, and more). A failed lookup is treated as
  // "unknown," not "unsafe" — a third-party outage shouldn't halt trading.
  const rugCheck = await getRugCheckReport(pair.mintAddress);
  if (rugCheck) {
    if (rugCheck.rugged) {
      reasons.push('RugCheck flags this token as already rugged');
    }
    if (rugCheck.dangerRisks.length > 0) {
      reasons.push(`RugCheck danger flags: ${rugCheck.dangerRisks.join(', ')}`);
    }
    if (rugCheck.score !== null && rugCheck.score >= config.maxRugcheckScore) {
      reasons.push(`RugCheck risk score ${rugCheck.score} at/above maximum ${config.maxRugcheckScore}`);
    }
  }

  return { passed: reasons.length === 0, reasons };
}
