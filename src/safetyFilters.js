import { checkMintSafety, checkHolderConcentration } from './rpc.js';
import { getRugCheckReport } from './rugcheck.js';
import { config } from './config.js';
import { getTradeStats } from './tradeStats.js';

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

  const mc = pair.marketCapUsd || 0;
  if (mc < config.minMarketCapUsd) {
    reasons.push(`market cap $${mc.toFixed(0)} below minimum $${config.minMarketCapUsd}`);
  } else if (mc > config.maxMarketCapUsd) {
    reasons.push(`market cap $${mc.toFixed(0)} above maximum $${config.maxMarketCapUsd}`);
  }

  const ageMinutes = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60000 : null;
  if (ageMinutes !== null && ageMinutes < config.minTokenAgeMinutes) {
    reasons.push(`only ${ageMinutes.toFixed(1)}m old, minimum ${config.minTokenAgeMinutes}m`);
  }

  // Observed trade activity. These counts only include trades seen while
  // the bot has been running, so they're a floor, not a full picture.
  const metrics = {};
  const trades = getTradeStats(pair.mintAddress);
  if (trades) {
    metrics.uniqueBuyers = trades.uniqueBuyers;
    metrics.buySellRatio = trades.buySellRatio;
    metrics.activityIncreasing = trades.activityIncreasing;
    metrics.observedTradeCount = trades.tradeCount;
  }
  if (!trades) {
    if (config.requireTradeActivity) reasons.push('no trade activity observed yet');
  } else {
    if (trades.uniqueBuyers < config.minUniqueBuyers) {
      reasons.push(`${trades.uniqueBuyers} of ${config.minUniqueBuyers} sampled buyers (~${trades.uniqueBuyers * 8} real, need ~${config.minUniqueBuyers * 8})`);
    }
    if (trades.buySellRatio < config.minBuySellRatio) {
      reasons.push(`buy/sell volume ratio ${trades.buySellRatio.toFixed(2)}x below minimum ${config.minBuySellRatio}x`);
    }
    if (config.requireActivityIncreasing && !trades.activityIncreasing) {
      reasons.push('trade activity not increasing');
    }
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

  // Everything above is free (in-memory / already-fetched). Everything
  // below costs 4 RPC calls plus an HTTP request per candidate. Most
  // tokens fail on the cheap checks, so bail here rather than paying for
  // network calls just to append more reasons to an already-doomed
  // candidate — that cost is what was pushing ticks past their interval.
  if (reasons.length > 0) {
    return { passed: false, reasons, metrics };
  }

  const mintSafety = await checkMintSafety(pair.mintAddress);
  if (!mintSafety.safe) {
    reasons.push(mintSafety.reason);
  }

  const holderSafety = await checkHolderConcentration(
    pair.mintAddress,
    config.maxTopHolderPercent,
    config.maxTop10Percent
  );
  if (holderSafety.topHolderPercent !== undefined) {
    metrics.topHolderPercent = holderSafety.topHolderPercent;
    metrics.top10Percent = holderSafety.top10Percent;
    metrics.realHolderCount = holderSafety.realHolderCount;
    metrics.poolPercent = holderSafety.poolPercent;
  }
  if (!holderSafety.safe) {
    reasons.push(holderSafety.reason);
  }

  // RugCheck's ML-based scoring — a much broader signal set than our own
  // basic checks (LP locks, sniper/bundler wallets, metadata mutability,
  // insider concentration, and more). A failed lookup is treated as
  // "unknown," not "unsafe" — a third-party outage shouldn't halt trading.
  const rugCheck = await getRugCheckReport(pair.mintAddress);
  if (rugCheck) {
    metrics.rugcheckScore = rugCheck.score;
    metrics.rugcheckFlags = rugCheck.dangerRisks;
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

  return { passed: reasons.length === 0, reasons, metrics };
}
