import './api.js'; // runs the API + serves the frontend in this same process
import { config } from './config.js';
import { getCandidatePairs, getPairData } from './dexscreener.js';
import { passesSafetyFilters } from './safetyFilters.js';
import { generateThesis } from './thesisEngine.js';
import { buyToken, sellToken } from './jupiter.js';
import {
  getOpenPositions,
  openPosition,
  closePosition,
  logThesis,
  recordRealizedPnl,
  getTodaysPnl,
  setLastTick,
} from './positions.js';

function killSwitchTripped() {
  return getTodaysPnl() <= -config.maxDailyLossSol;
}

async function manageOpenPositions() {
  const open = getOpenPositions();

  for (const pos of open) {
    let fresh;
    try {
      fresh = await getPairData(pos.pairAddress);
    } catch (err) {
      console.error(`[manage] failed to refresh ${pos.symbol}: ${err.message}`);
      continue;
    }
    if (!fresh) continue;

    const pnlPercent = ((fresh.priceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;

    if (pnlPercent <= -config.stopLossPercent) {
      console.log(`[exit] ${pos.symbol} hit stop-loss at ${pnlPercent.toFixed(1)}% — selling`);
      try {
        const result = await sellToken(pos.mintAddress, pos.tokenAmountRaw);
        const exitSol = Number(result.outAmount) / 1e9;
        const realizedPnlSol = exitSol - pos.entrySolAmount;

        closePosition(pos.mintAddress, {
          exitPriceUsd: fresh.priceUsd,
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
  const candidates = await getCandidatePairs();
  console.log(`[scan] fetched ${candidates.length} candidate pairs`);

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

tick();
setInterval(tick, config.scanIntervalMs);
