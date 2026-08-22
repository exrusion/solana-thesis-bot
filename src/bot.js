import './api.js'; // runs the API + serves the frontend in this same process
import { config } from './config.js';
import { getPairsForMint } from './dexscreener.js';
import { fetchBondingCurveState, getSolUsdPrice } from './bondingCurve.js';
import { passesSafetyFilters } from './safetyFilters.js';
import { generateThesis } from './thesisEngine.js';
import { buyToken, sellToken } from './jupiter.js';
import { startPumpFunListener, drainFreshMints, getListenerStats } from './pumpfunListener.js';
import {
  getOpenPositions,
  openPosition,
  closePosition,
  logThesis,
  recordRealizedPnl,
  getTodaysPnl,
  setLastTick,
} from './positions.js';

const MAX_PENDING_FRESH_MINTS = 500;
const MAX_LOOKUPS_PER_TICK = 25;
const FRESH_MINT_EXPIRY_MS = 30 * 60 * 1000; // most pump.fun creates never trade at all — give real ones time

let pendingFreshMints = []; // { mintAddress, firstSeenAt, lastRealSolReservesSol } — persists across ticks
let totalFreshResolved = 0;
let totalFreshGivenUp = 0;

function killSwitchTripped() {
  return getTodaysPnl() <= -config.maxDailyLossSol;
}

/** Builds a pipeline-compatible candidate from on-chain bonding-curve reserves, with real momentum since we first saw it. */
function buildBondingCurveCandidate(mintAddress, curve, solUsd, firstSeenAt, growthPercent) {
  const liquidityUsd = curve.realSolReservesSol * solUsd;
  return {
    pairAddress: mintAddress, // no real DexScreener pair yet — position tracking uses mintAddress, not this
    dexId: 'pumpfun',
    mintAddress,
    symbol: `${mintAddress.slice(0, 4)}…${mintAddress.slice(-4)}`,
    priceUsd: curve.priceSolPerToken * solUsd,
    liquidityUsd,
    // Proxy, not true gross volume: the bonding curve gives reserves, not
    // trade history. Real SOL committed to the curve is a reasonable
    // stand-in for "how much genuine buying interest this has attracted."
    volume1h: liquidityUsd,
    volume6h: liquidityUsd,
    volume24h: liquidityUsd,
    // This is real growth in the curve's real SOL reserves since we first
    // detected the token (could be a few minutes to ~30min old) — our own
    // "is this actually moving" signal, not a literal 1h/6h/24h window.
    priceChange1h: growthPercent,
    priceChange6h: growthPercent,
    priceChange24h: growthPercent,
    pairCreatedAt: firstSeenAt,
    url: `https://pump.fun/${mintAddress}`,
  };
}

async function manageOpenPositions() {
  const open = getOpenPositions();
  if (!open.length) return;
  const solUsd = await getSolUsdPrice();

  for (const pos of open) {
    let currentPriceUsd = null;

    try {
      const curve = await fetchBondingCurveState(pos.mintAddress);
      if (curve && !curve.complete && solUsd) {
        currentPriceUsd = curve.priceSolPerToken * solUsd;
      } else {
        const pair = await getPairsForMint(pos.mintAddress);
        if (pair) currentPriceUsd = pair.priceUsd;
      }
    } catch (err) {
      console.error(`[manage] failed to refresh ${pos.symbol}: ${err.message}`);
      continue;
    }

    if (currentPriceUsd === null) continue; // no fresh price this tick — try again next tick

    const pnlPercent = ((currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;

    if (pnlPercent <= -config.stopLossPercent) {
      console.log(`[exit] ${pos.symbol} hit stop-loss at ${pnlPercent.toFixed(1)}% — selling`);
      try {
        const result = await sellToken(pos.mintAddress, pos.tokenAmountRaw);
        const exitSol = Number(result.outAmount) / 1e9;
        const realizedPnlSol = exitSol - pos.entrySolAmount;

        closePosition(pos.mintAddress, {
          exitPriceUsd: currentPriceUsd,
          exitSignature: result.signature,
          realizedPnlSol,
        });
        recordRealizedPnl(realizedPnlSol);
      } catch (err) {
        console.error(`[exit] sell failed for ${pos.symbol}: ${err.message}`);
      }
    }
  }
}

async function scanForNewPositions() {
  if (killSwitchTripped()) {
    console.log('[kill switch] daily loss limit hit — skipping new entries this tick');
    return;
  }

  const open = getOpenPositions();
  if (open.length >= config.maxConcurrentPositions) {
    return;
  }

  const openMints = new Set(open.map((p) => p.mintAddress));

  // fold newly detected mints into the retry pool
  const justDetected = drainFreshMints();
  const alreadyPending = new Set(pendingFreshMints.map((m) => m.mintAddress));
  for (const mintAddress of justDetected) {
    if (!alreadyPending.has(mintAddress)) {
      pendingFreshMints.push({ mintAddress, firstSeenAt: Date.now() });
    }
  }

  // drop anything that never got any data within the expiry window
  const now = Date.now();
  const beforeExpiry = pendingFreshMints.length;
  pendingFreshMints = pendingFreshMints.filter((m) => now - m.firstSeenAt < FRESH_MINT_EXPIRY_MS);
  totalFreshGivenUp += beforeExpiry - pendingFreshMints.length;
  if (pendingFreshMints.length > MAX_PENDING_FRESH_MINTS) {
    const overflow = pendingFreshMints.length - MAX_PENDING_FRESH_MINTS;
    totalFreshGivenUp += overflow;
    pendingFreshMints = pendingFreshMints.slice(-MAX_PENDING_FRESH_MINTS);
  }

  const solUsd = await getSolUsdPrice();
  const toCheck = pendingFreshMints.slice(0, MAX_LOOKUPS_PER_TICK);
  const stillPending = [];
  const freshCandidates = [];

  for (const entry of toCheck) {
    if (openMints.has(entry.mintAddress)) continue; // already holding it

    // bonding curve first — instant, zero indexing lag. DexScreener only as
    // a fallback for tokens that have already graduated off the curve.
    const curve = await fetchBondingCurveState(entry.mintAddress);

    if (curve && !curve.complete && solUsd) {
      const previous = entry.lastRealSolReservesSol;
      const growthPercent =
        previous && previous > 0
          ? ((curve.realSolReservesSol - previous) / previous) * 100
          : 0;
      entry.lastRealSolReservesSol = curve.realSolReservesSol;

      const liquidityUsd = curve.realSolReservesSol * solUsd;
      const closeToExpiry = now - entry.firstSeenAt > FRESH_MINT_EXPIRY_MS - config.scanIntervalMs;

      if (liquidityUsd >= config.minLiquidityUsd || closeToExpiry) {
        // worth a real verdict now — either it's grown enough to plausibly
        // pass, or this is its last chance before we give up on it
        freshCandidates.push(
          buildBondingCurveCandidate(entry.mintAddress, curve, solUsd, entry.firstSeenAt, growthPercent)
        );
        totalFreshResolved++;
      } else {
        stillPending.push(entry); // still too small — keep quietly tracking its growth
      }
      continue;
    }

    // graduated off the curve, or bonding curve unreadable — try DexScreener by mint
    const pair = await getPairsForMint(entry.mintAddress);
    if (pair) {
      freshCandidates.push(pair);
      totalFreshResolved++;
    } else {
      stillPending.push(entry);
    }
  }
  pendingFreshMints = [...stillPending, ...pendingFreshMints.slice(MAX_LOOKUPS_PER_TICK)];

  const candidateMap = new Map();
  for (const pair of freshCandidates) {
    if (pair.mintAddress) candidateMap.set(pair.mintAddress, pair);
  }
  const candidates = [...candidateMap.values()];

  console.log(`[scan] ${candidates.length} candidates ready for evaluation this tick`);
  console.log(
    `[fresh-mints] pending: ${pendingFreshMints.length} | resolved (session total): ${totalFreshResolved} | given up (session total): ${totalFreshGivenUp}`
  );
  const stats = getListenerStats();
  console.log(
    `[pumpfun] logs seen: ${stats.logsSeen} | creates seen: ${stats.createLogsSeen} | resolved: ${stats.resolvedTotal} | resolve failures: ${stats.resolveFailures} | suspicious (no "pump" suffix): ${stats.suspiciousMints} | pending: ${stats.pendingCount}`
  );

  let passedCount = 0;

  for (const pair of candidates) {
    if (getOpenPositions().length >= config.maxConcurrentPositions) break;
    if (!pair.mintAddress || openMints.has(pair.mintAddress)) continue;

    const filterResult = await passesSafetyFilters(pair);
    if (!filterResult.passed) {
      console.log(`[filter] ${pair.symbol} skipped — ${filterResult.reasons.join('; ')}`);
      logThesis({
        type: 'filtered',
        symbol: pair.symbol,
        mintAddress: pair.mintAddress,
        dexId: pair.dexId,
        url: pair.url,
        reasons: filterResult.reasons,
      });
      continue;
    }
    passedCount++;

    const ageHours = pair.pairCreatedAt
      ? (Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60)
      : null;

    const stats = { ...pair, ageHours };
    let thesis;
    try {
      thesis = await generateThesis(stats);
    } catch (err) {
      console.error(`[thesis] failed for ${pair.symbol}: ${err.message}`);
      continue;
    }

    logThesis({
      type: 'thesis',
      symbol: pair.symbol,
      mintAddress: pair.mintAddress,
      dexId: pair.dexId,
      url: pair.url,
      stats,
      thesis,
    });
    console.log(`[thesis] ${pair.symbol} — ${thesis.decision}`);

    if (thesis.decision === 'hold') {
      console.log(`[entry] ${pair.symbol} — thesis says hold, buying`);
      try {
        const result = await buyToken(pair.mintAddress, config.maxPositionSizeSol);
        openPosition({
          mintAddress: pair.mintAddress,
          pairAddress: pair.pairAddress,
          symbol: pair.symbol,
          entryPriceUsd: pair.priceUsd,
          entrySolAmount: config.maxPositionSizeSol,
          tokenAmountRaw: result.outAmount,
          entrySignature: result.signature,
          thesis,
        });
      } catch (err) {
        console.error(`[entry] buy failed for ${pair.symbol}: ${err.message}`);
      }
    }
  }

  console.log(`[scan] ${passedCount} candidate(s) passed safety filters this tick`);
}

async function tick() {
  console.log(`\n--- tick ${new Date().toISOString()} ---`);
  setLastTick();
  try {
    await manageOpenPositions();
    await scanForNewPositions();
  } catch (err) {
    console.error(`[tick] unhandled error: ${err.message}`);
  }
}

console.log('solana-thesis-bot starting.');
console.log(`max position size: ${config.maxPositionSizeSol} SOL | max concurrent: ${config.maxConcurrentPositions}`);
console.log(`stop-loss: ${config.stopLossPercent}% | daily loss limit: ${config.maxDailyLossSol} SOL`);

startPumpFunListener();
tick();
setInterval(tick, config.scanIntervalMs);
