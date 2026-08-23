import './logCapture.js'; // must be first — captures every console.log/error from here on
import './api.js'; // runs the API + serves the frontend in this same process
import { config } from './config.js';
import { getPairsForMint } from './dexscreener.js';
import { fetchBondingCurveState, getSolUsdPrice } from './bondingCurve.js';
import { fetchTokenMetadata } from './tokenMetadata.js';
import { passesSafetyFilters } from './safetyFilters.js';
import { generateThesis } from './thesisEngine.js';
import { buyToken, sellToken } from './jupiter.js';
import { startPumpFunListener, drainFreshMints, getListenerStats } from './pumpfunListener.js';
import { recordEvaluation, processDueCheckpoints } from './outcomeTracker.js';
import { updateScanStats, incrementTickCount } from './scanStats.js';
import {
  getOpenPositions,
  openPosition,
  closePosition,
  updatePosition,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killSwitchTripped() {
  return getTodaysPnl() <= -config.maxDailyLossSol;
}

/** Builds a pipeline-compatible candidate from on-chain bonding-curve reserves, with real momentum since we first saw it. */
async function buildBondingCurveCandidate(mintAddress, curve, solUsd, firstSeenAt, growthPercent) {
  const liquidityUsd = curve.realSolReservesSol * solUsd;
  const marketCapUsd = curve.marketCapSol * solUsd;

  const metadata = await fetchTokenMetadata(mintAddress);
  const symbol = metadata?.symbol || `${mintAddress.slice(0, 4)}…${mintAddress.slice(-4)}`;

  return {
    pairAddress: mintAddress, // no real DexScreener pair yet — position tracking uses mintAddress, not this
    dexId: 'pumpfun',
    mintAddress,
    symbol,
    name: metadata?.name || null,
    priceUsd: curve.priceSolPerToken * solUsd,
    liquidityUsd,
    marketCapUsd,
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
    url: `https://pump.fun/coin/${mintAddress}`,
  };
}

async function manageOpenPositions() {
  const open = getOpenPositions();
  if (!open.length) {
    updateScanStats({ unrealizedPnlUsd: 0, openPositionsValueUsd: 0 });
    return;
  }
  const solUsd = await getSolUsdPrice();

  let unrealizedPnlUsd = 0;
  let openPositionsValueUsd = 0;

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

    const entryValueUsd = pos.entryPriceUsd > 0 ? pos.entrySolAmount * (solUsd || 0) : 0;
    const currentValueUsd = pos.entryPriceUsd > 0 ? (currentPriceUsd / pos.entryPriceUsd) * entryValueUsd : 0;
    unrealizedPnlUsd += currentValueUsd - entryValueUsd;
    openPositionsValueUsd += currentValueUsd;

    const pnlPercent = ((currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
    const heldMinutes = (Date.now() - new Date(pos.openedAt).getTime()) / 60000;
    const remainingRaw = pos.remainingTokenRaw ?? pos.tokenAmountRaw;
    const tookFirstProfit = pos.tookFirstProfit === true;

    // Decide what this tick calls for, in priority order.
    let action = null;
    if (pnlPercent <= -config.stopLossPercent) {
      action = { type: 'full', label: `stop-loss tripped at ${pnlPercent.toFixed(1)}%` };
    } else if (pnlPercent >= config.takeProfitPercent2) {
      action = { type: 'full', label: `target hit at +${pnlPercent.toFixed(1)}% — closing the rest` };
    } else if (!tookFirstProfit && pnlPercent >= config.takeProfitPercent1) {
      action = { type: 'partial', label: `+${pnlPercent.toFixed(1)}% — taking half off the table` };
    } else if (heldMinutes >= config.maxHoldMinutes) {
      action = { type: 'full', label: `${config.maxHoldMinutes}m time limit reached at ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%` };
    }

    if (!action) continue;

    const sellRaw =
      action.type === 'partial'
        ? Math.floor(Number(remainingRaw) / 2).toString()
        : remainingRaw;

    console.log(`[exit] ${pos.symbol} — ${action.label}`);
    try {
      const result = await sellToken(pos.mintAddress, sellRaw);
      const exitSol = Number(result.outAmount) / 1e9;

      if (action.type === 'partial') {
        const leftover = (BigInt(remainingRaw) - BigInt(sellRaw)).toString();
        updatePosition(pos.mintAddress, {
          remainingTokenRaw: leftover,
          tookFirstProfit: true,
          partialExitSol: (pos.partialExitSol || 0) + exitSol,
        });
        recordRealizedPnl(exitSol - pos.entrySolAmount / 2);
        logThesis({
          type: 'exit',
          symbol: pos.symbol,
          mintAddress: pos.mintAddress,
          url: `https://pump.fun/coin/${pos.mintAddress}`,
          reasons: [
            action.label + '.',
            `half sold for ${exitSol.toFixed(3)} SOL, rest rides to +${config.takeProfitPercent2}% or the ${config.maxHoldMinutes}m bell.`,
          ],
        });
      } else {
        const totalOut = exitSol + (pos.partialExitSol || 0);
        const realizedPnlSol = totalOut - pos.entrySolAmount;
        closePosition(pos.mintAddress, {
          exitPriceUsd: currentPriceUsd,
          exitSignature: result.signature,
          realizedPnlSol,
        });
        recordRealizedPnl(exitSol - (tookFirstProfit ? pos.entrySolAmount / 2 : pos.entrySolAmount));
        logThesis({
          type: 'exit',
          symbol: pos.symbol,
          mintAddress: pos.mintAddress,
          url: `https://pump.fun/coin/${pos.mintAddress}`,
          reasons: [
            action.label + '.',
            `position closed. total realized: ${realizedPnlSol >= 0 ? '+' : ''}${realizedPnlSol.toFixed(3)} SOL.`,
          ],
        });
      }
    } catch (err) {
      console.error(`[exit] sell failed for ${pos.symbol}: ${err.message}`);
    }
  }

  updateScanStats({ unrealizedPnlUsd, openPositionsValueUsd });
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
  if (!solUsd) {
    console.error('[scan] WARNING: SOL/USD price unavailable — bonding-curve candidates will fall through to the ungated DexScreener path this tick');
  }
  const toCheck = pendingFreshMints.slice(0, MAX_LOOKUPS_PER_TICK);
  const stillPending = [];
  const freshCandidates = [];

  for (const entry of toCheck) {
    if (openMints.has(entry.mintAddress)) continue; // already holding it
    await sleep(300); // stay comfortably under Helius's rate limit across ~25 lookups/tick

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

      const marketCapUsd = curve.marketCapSol * solUsd;

      // Keep tracking anything that's simply too young rather than
      // evaluating and discarding it — that condition resolves on its own
      // within minutes, and a discarded token is gone for good.
      const ageMinutes = (now - entry.firstSeenAt) / 60000;
      if (ageMinutes < config.minTokenAgeMinutes) {
        stillPending.push(entry);
        continue;
      }

      if (marketCapUsd >= config.minMarketCapUsd) {
        freshCandidates.push(
          await buildBondingCurveCandidate(entry.mintAddress, curve, solUsd, entry.firstSeenAt, growthPercent)
        );
        totalFreshResolved++;
      } else {
        stillPending.push(entry); // under $10k market cap — never evaluated, just dropped if it expires
      }
      continue;
    }

    // graduated off the curve, or bonding curve unreadable — try DexScreener by mint
    const pair = await getPairsForMint(entry.mintAddress);
    if (pair) {
      pair.url = `https://pump.fun/coin/${entry.mintAddress}`; // always pump.fun, never DexScreener
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
  const listenerStats = getListenerStats();
  console.log(
    `[pumpfun] logs seen: ${listenerStats.logsSeen} | creates: ${listenerStats.createLogsSeen} | trades sampled: ${listenerStats.tradeLogsSeen} | resolved: ${listenerStats.resolvedTotal} | resolve failures: ${listenerStats.resolveFailures} | suspicious (no "pump" suffix): ${listenerStats.suspiciousMints} | queue: ${listenerStats.pendingCreates} creates / ${listenerStats.pendingTrades} trades`
  );

  let topPending = [];
  if (solUsd) {
    const withMc = [];
    for (const entry of pendingFreshMints) {
      if (entry.lastRealSolReservesSol == null) continue;
      withMc.push({
        symbol: `${entry.mintAddress.slice(0, 4)}…${entry.mintAddress.slice(-4)}`,
        marketCapUsd: entry.lastRealSolReservesSol * solUsd,
      });
    }
    withMc.sort((a, b) => b.marketCapUsd - a.marketCapUsd);
    topPending = withMc.slice(0, 3);
  }
  updateScanStats({
    pendingMintsCount: pendingFreshMints.length,
    closestPendingSymbol: topPending[0]?.symbol || null,
    closestPendingMarketCapUsd: topPending[0]?.marketCapUsd || 0,
    topPending,
    totalResolved: totalFreshResolved,
    totalGivenUp: totalFreshGivenUp,
    createsSeen: listenerStats.createLogsSeen,
    tradesSeen: listenerStats.tradeLogsSeen,
  });

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
      recordEvaluation({
        mintAddress: pair.mintAddress,
        symbol: pair.symbol,
        decision: 'filtered',
        entrySnapshot: {
          marketCapUsd: pair.marketCapUsd,
          liquidityUsd: pair.liquidityUsd,
          volume1h: pair.volume1h,
          priceChange1h: pair.priceChange1h,
          priceUsd: pair.priceUsd,
        },
        filterReasons: filterResult.reasons,
      });
      continue;
    }
    passedCount++;

    const ageHours = pair.pairCreatedAt
      ? (Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60)
      : null;

    // Fold in everything the filters already measured — holder
    // concentration, observed buyers, buy/sell ratio, RugCheck score.
    // Without this the model reasons on "unknown" for its most important
    // structural signals.
    const stats = { ...pair, ageHours, ...(filterResult.metrics || {}) };
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
    recordEvaluation({
      mintAddress: pair.mintAddress,
      symbol: pair.symbol,
      decision: thesis.decision,
      entrySnapshot: {
        marketCapUsd: pair.marketCapUsd,
        liquidityUsd: pair.liquidityUsd,
        volume1h: pair.volume1h,
        priceChange1h: pair.priceChange1h,
        priceUsd: pair.priceUsd,
      },
      thesisReasoning: thesis.reasoning,
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
          remainingTokenRaw: result.outAmount,
          tookFirstProfit: false,
          partialExitSol: 0,
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

let tickInProgress = false;

async function tick() {
  if (tickInProgress) {
    console.log('[tick] previous tick still running — skipping this interval to avoid overlap');
    return;
  }
  tickInProgress = true;
  console.log(`\n--- tick ${new Date().toISOString()} ---`);
  setLastTick();
  incrementTickCount();
  try {
    await manageOpenPositions();
    await scanForNewPositions();
    const outcomeResult = await processDueCheckpoints();
    if (outcomeResult.checked > 0 || outcomeResult.pending > 0) {
      console.log(
        `[outcomes] checked ${outcomeResult.checked} follow-up(s) this tick, ${outcomeResult.pending} still due`
      );
    }
  } catch (err) {
    console.error(`[tick] unhandled error: ${err.message}`);
  } finally {
    tickInProgress = false;
  }
}

console.log('solana-thesis-bot starting.');
console.log(`max position size: ${config.maxPositionSizeSol} SOL | max concurrent: ${config.maxConcurrentPositions}`);
console.log(`stop-loss: ${config.stopLossPercent}% | daily loss limit: ${config.maxDailyLossSol} SOL`);

startPumpFunListener();
tick();
setInterval(tick, config.scanIntervalMs);
