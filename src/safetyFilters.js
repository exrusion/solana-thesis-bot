import { checkMintSafety, checkHolderConcentration } from './rpc.js';
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

  if (pair.volume1h < config.minHourlyVolumeUsd) {
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

  return { passed: reasons.length === 0, reasons };
}
