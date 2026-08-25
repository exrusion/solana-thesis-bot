import './logCapture.js'; // must be first — captures every console.log/error from here on
import './api.js'; // runs the API + serves the frontend in this same process
import { config } from './config.js';
import { getPairsForMint } from './dexscreener.js';
import { fetchBondingCurveState, getSolUsdPrice } from './bondingCurve.js';
import { fetchTokenMetadata } from './tokenMetadata.js';
import { passesSafetyFilters } from './safetyFilters.js';
import { generateThesis } from './thesisEngine.js';
import { buyToken, sellToken } from './jupiter.js';
import { getTokenBalanceRaw } from './rpc.js';
import { startPumpFunListener, drainFreshMints, getListenerStats } from './pumpfunListener.js';
import { recordEvaluation, processDueCheckpoints } from './outcomeTracker.js';
import { updateScanStats, incrementTickCount } from './scanStats.js';
import { trainModel, predictSurvival } from './mlModel.js';
import { getAllOutcomeRecords } from './outcomeTracker.js';
import {
  notifyBuy,
  notifyExit,
  notifyThesis,
  notifySkip,
  notifyStartup,
} from './telegram.js';
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
const MAX_LOOKUPS_PER_TICK = 80; // ticks were finishing in ~9s of 60s — plenty of headroom
const FRESH_MINT_EXPIRY_MS = 2 * 60 * 60 * 1000; // real momentum can take 30+ min to build

let pendingFreshMints = []; // { mintAddress, firstSeenAt, lastRealSolReservesSol } — persists across ticks
let totalFreshResolved = 0;
let totalFreshGivenUp = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/**
 * Distinguishes rejections that can resolve on their own from ones that
 * never will. A token with "3 unique buyers" may have 300 an hour later;
 * a token whose mint authority was never revoked will never fix itself.
 * Discarding the first kind on a single early look is how we lose the
 * tokens that go on to run.
 */
const PERMANENT_PATTERNS = [
  'mint authority',
  'freeze authority',
  'already rugged',
  'RugCheck danger flags',
  'RugCheck risk score',
  'above maximum',
  'is not pump.fun',
  'missing mint address',
];

function isPermanentRejection(reasons) {
  return reasons.some((r) => PERMANENT_PATTERNS.some((p) => r.includes(p)));
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
    firstSeenAt,
    observedOnly: true, // firstSeenAt is when WE noticed it, not when it launched
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
  const livePositions = [];

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

    // Value the position from the tokens actually held on-chain, not from
    // an entry-price ratio — that's the only figure that reflects reality
    // after partial exits or slippage.
    const heldRaw = await getTokenBalanceRaw(pos.mintAddress);
    const heldTokens = heldRaw ? Number(heldRaw) / 1e6 : 0; // pump.fun tokens use 6 decimals
    const currentValueUsd = heldTokens * currentPriceUsd;

    const costBasisUsd =
      (pos.entrySolAmount - (pos.partialExitSol || 0)) * (solUsd || 0);
    unrealizedPnlUsd += currentValueUsd - costBasisUsd;
    openPositionsValueUsd += currentValueUsd;

    const pnlPercent = ((currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;

    livePositions.push({
      mintAddress: pos.mintAddress,
      symbol: pos.symbol,
      entrySolAmount: pos.entrySolAmount,
      entrySignature: pos.entrySignature,
      pnlPercent,
      currentValueUsd,
      costBasisUsd,
      heldTokens,
      tookFirstProfit: pos.tookFirstProfit === true,
      minutesHeld: (Date.now() - new Date(pos.openedAt).getTime()) / 60000,
    });
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

    // Always sell against the wallet's REAL balance. The stored amount
    // came from a buy quote, and slippage means we usually hold slightly
    // less than quoted — selling the quoted figure fails simulation.
    const actualRaw = await getTokenBalanceRaw(pos.mintAddress);
    if (actualRaw === null || actualRaw === '0') {
      console.error(`[exit] ${pos.symbol}: wallet holds no balance for this mint — closing position without a sell`);
      closePosition(pos.mintAddress, {
        exitPriceUsd: currentPriceUsd,
        exitSignature: null,
        realizedPnlSol: -(pos.entrySolAmount - (pos.partialExitSol || 0)),
      });
      continue;
    }

    const sellRaw =
      action.type === 'partial'
        ? (BigInt(actualRaw) / 2n).toString()
        : actualRaw;

    console.log(`[exit] ${pos.symbol} — ${action.label} (selling ${sellRaw} of ${actualRaw} held)`);
    try {
      const result = await sellToken(pos.mintAddress, sellRaw);
      const exitSol = Number(result.outAmount) / 1e9;

      if (action.type === 'partial') {
        const leftover = (BigInt(actualRaw) - BigInt(sellRaw)).toString();
        updatePosition(pos.mintAddress, {
          remainingTokenRaw: leftover,
          tookFirstProfit: true,
          partialExitSol: (pos.partialExitSol || 0) + exitSol,
        });
        recordRealizedPnl(exitSol - pos.entrySolAmount / 2);
        notifyExit({
          symbol: pos.symbol,
          mint: pos.mintAddress,
          label: action.label,
          realizedPnlSol: exitSol - pos.entrySolAmount / 2,
          partial: true,
          signature: result.signature,
        });
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
        notifyExit({
          symbol: pos.symbol,
          mint: pos.mintAddress,
          label: action.label,
          realizedPnlSol,
          partial: false,
          signature: result.signature,
        });
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

  updateScanStats({ unrealizedPnlUsd, openPositionsValueUsd, livePositions });
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
  const watchedBefore = new Set(pendingFreshMints.filter((m) => m.journalled).map((m) => m.mintAddress));

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
  // Split the budget deliberately. Sorting purely youngest-first meant the
  // newest N were rechecked every tick and everything older was never
  // looked at again — so a token that started running fifteen minutes
  // after launch could never be seen. Half the slots go to fresh arrivals,
  // half rotate through the rest so nothing under watch goes stale.
  const FRESH_SLOTS = Math.floor(MAX_LOOKUPS_PER_TICK / 2);
  const byAge = [...pendingFreshMints].sort((a, b) => b.firstSeenAt - a.firstSeenAt);
  const freshPicks = byAge.slice(0, FRESH_SLOTS);
  const freshSet = new Set(freshPicks.map((e) => e.mintAddress));

  const rotationPool = pendingFreshMints.filter((e) => !freshSet.has(e.mintAddress));
  const rotationPicks = rotationPool.slice(0, MAX_LOOKUPS_PER_TICK - freshPicks.length);

  const toCheck = [...freshPicks, ...rotationPicks];
  const checkedSet = new Set(toCheck.map((e) => e.mintAddress));
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
      const hasBaseline = previous !== null && previous !== undefined && previous > 0;
      // null, not 0 — "we have not measured this yet" is a completely
      // different statement from "it did not grow", and reporting the
      // second when we mean the first was causing false rejections.
      const growthPercent = hasBaseline
        ? ((curve.realSolReservesSol - previous) / previous) * 100
        : null;
      entry.lastRealSolReservesSol = curve.realSolReservesSol;
      if (!entry.firstMeasuredAt) entry.firstMeasuredAt = now;

      const ageMinutes = (now - entry.firstSeenAt) / 60000;
      const marketCapUsd = curve.marketCapSol * solUsd;

      // Keep tracking anything that's simply too young rather than
      // evaluating and discarding it — that condition resolves on its own
      // within minutes, and a discarded token is gone for good.
      if (ageMinutes < config.minTokenAgeMinutes) {
        stillPending.push(entry);
        continue;
      }

      // Normally we wait for a second reading so growth is a real
      // measurement. A brand-new launch has no history to compare against
      // and the move is over before a second pass comes round, so it is
      // evaluated on sight instead — the filters still have to pass.
      const isFreshLaunch = ageMinutes <= config.freshLaneMaxAgeMinutes;
      if (!hasBaseline && !isFreshLaunch) {
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
  // Tokens we just checked go to the BACK, not the front. Putting them
  // first meant slice(0, N) grabbed the same N every tick and the rest of
  // the pool was never examined at all.
  // Checked entries go to the back so the rotation actually advances.
  pendingFreshMints = [
    ...pendingFreshMints.filter((e) => !checkedSet.has(e.mintAddress)),
    ...stillPending,
  ];

  const candidateMap = new Map();
  for (const pair of freshCandidates) {
    if (pair.mintAddress) candidateMap.set(pair.mintAddress, pair);
  }
  const candidates = [...candidateMap.values()];

  console.log(`[scan] ${candidates.length} candidates ready for evaluation this tick`);
  console.log(
    `[fresh-mints] pending: ${pendingFreshMints.length} | checked: ${toCheck.length} (${freshPicks.length} fresh + ${rotationPicks.length} rotating) | resolved (session total): ${totalFreshResolved} | given up (session total): ${totalFreshGivenUp}`
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
  const funnel = {};

  for (const pair of candidates) {
    if (getOpenPositions().length >= config.maxConcurrentPositions) break;
    if (!pair.mintAddress || openMints.has(pair.mintAddress)) continue;

    const filterResult = await passesSafetyFilters(pair);
    if (!filterResult.passed) {
      for (const stage of filterResult.failedStages || []) {
        funnel[stage] = (funnel[stage] || 0) + 1;
      }
      const permanent = isPermanentRejection(filterResult.reasons);

      // Transient failure: keep watching rather than discarding. Only the
      // first look gets journalled, so a token under observation for an
      // hour doesn't flood the feed with the same entry every tick.
      if (!permanent) {
        const alreadyWatching = pendingFreshMints.some((m) => m.mintAddress === pair.mintAddress);
        if (!alreadyWatching) {
          pendingFreshMints.push({
            mintAddress: pair.mintAddress,
            firstSeenAt: pair.pairCreatedAt || Date.now(),
            lastRealSolReservesSol: pair.liquidityUsd && solUsd ? pair.liquidityUsd / solUsd : null,
            journalled: true,
          });
        }
        if (watchedBefore.has(pair.mintAddress)) {
          continue; // already told the story once — stay quiet while we watch
        }
      }

      console.log(`[filter] ${pair.symbol} skipped — ${filterResult.reasons.join('; ')}${permanent ? '' : ' (still watching)'}`);
      notifySkip({ symbol: pair.symbol, mint: pair.mintAddress, reasons: filterResult.reasons });
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
    stats.mlSurvivalProbability = predictSurvival(stats);
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
    notifyThesis({
      symbol: pair.symbol,
      mint: pair.mintAddress,
      decision: thesis.decision,
      marketCapUsd: pair.marketCapUsd,
      liquidityUsd: pair.liquidityUsd,
      recentTrades: stats.recentTrades,
      reasoning: thesis.reasoning,
      invalidation: thesis.invalidationCondition,
    });

    if (thesis.decision === 'hold') {
      console.log(`[entry] ${pair.symbol} — thesis says hold, buying`);
      try {
        const result = await buyToken(pair.mintAddress, config.maxPositionSizeSol);
        notifyBuy({
          symbol: pair.symbol,
          mint: pair.mintAddress,
          solAmount: config.maxPositionSizeSol,
          marketCapUsd: pair.marketCapUsd,
          reasoning: thesis.reasoning,
          signature: result.signature,
        });
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

  const funnelText = Object.entries(funnel)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  console.log(
    `[scan] ${passedCount} passed filters | rejected by — ${funnelText || 'nothing rejected'}`
  );
  updateScanStats({ rejectionFunnel: funnel });
}

let tickInProgress = false;
let ticksSinceTrain = 0;

async function tick() {
  if (tickInProgress) {
    console.log('[tick] previous tick still running — skipping this interval to avoid overlap');
    return;
  }
  tickInProgress = true;
  const tickStart = Date.now();
  console.log(`\n--- tick ${new Date().toISOString()} ---`);
  setLastTick();
  incrementTickCount();
  try {
    await manageOpenPositions();
    await scanForNewPositions();
    ticksSinceTrain++;
    if (ticksSinceTrain >= 10) {
      ticksSinceTrain = 0;
      trainModel(getAllOutcomeRecords());
    }

    const outcomeResult = await processDueCheckpoints();
    if (outcomeResult.checked > 0 || outcomeResult.pending > 0) {
      console.log(
        `[outcomes] checked ${outcomeResult.checked} follow-up(s) this tick, ${outcomeResult.pending} still due`
      );
    }
  } catch (err) {
    console.error(`[tick] unhandled error: ${err.message}`);
  } finally {
    const elapsed = ((Date.now() - tickStart) / 1000).toFixed(1);
    const budget = (config.scanIntervalMs / 1000).toFixed(0);
    if (Date.now() - tickStart > config.scanIntervalMs) {
      console.error(`[tick] took ${elapsed}s — OVER the ${budget}s interval, next tick(s) will be skipped`);
    } else {
      console.log(`[tick] completed in ${elapsed}s of ${budget}s budget`);
    }
    tickInProgress = false;
  }
}

console.log('Pump Trade starting.');
console.log(`max position size: ${config.maxPositionSizeSol} SOL | max concurrent: ${config.maxConcurrentPositions}`);
console.log(`stop-loss: ${config.stopLossPercent}% | daily loss limit: ${config.maxDailyLossSol} SOL`);

notifyStartup();
startPumpFunListener();
tick();
setInterval(tick, config.scanIntervalMs);
