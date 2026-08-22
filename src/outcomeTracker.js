import fs from 'fs';
import path from 'path';
import { fetchBondingCurveState, getSolUsdPrice } from './bondingCurve.js';
import { getPairsForMint } from './dexscreener.js';

const DATA_DIR = path.resolve('data');
const OUTCOMES_FILE = path.join(DATA_DIR, 'outcomes.json');

// Follow-up windows — matches the intervals commonly used in published
// memecoin-outcome datasets, so this data would be directly comparable.
const CHECKPOINTS = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '6h', ms: 6 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
];

const MAX_RECORDS = 3000;
const MAX_CHECKS_PER_TICK = 15; // bounded so this never competes much with live trading calls

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readOutcomes() {
  ensureDataDir();
  if (!fs.existsSync(OUTCOMES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(OUTCOMES_FILE, 'utf-8'));
  } catch (err) {
    console.error(`[outcomes] failed to read outcomes file, starting fresh: ${err.message}`);
    return [];
  }
}

function writeOutcomes(records) {
  ensureDataDir();
  fs.writeFileSync(OUTCOMES_FILE, JSON.stringify(records, null, 2));
}

/**
 * Called whenever a candidate gets a real pipeline evaluation (filtered out
 * or given a thesis). Snapshots its state now and schedules follow-up
 * checks so we can later see what actually happened — including to the
 * tokens we passed on. That's the data we don't have yet.
 */
export function recordEvaluation({ mintAddress, symbol, decision, entrySnapshot, filterReasons, thesisReasoning }) {
  const records = readOutcomes();

  records.unshift({
    mintAddress,
    symbol,
    evaluatedAt: new Date().toISOString(),
    decision, // 'hold' | 'fail' | 'filtered'
    entrySnapshot, // { marketCapUsd, liquidityUsd, volume1h, priceChange1h, priceUsd }
    filterReasons: filterReasons || null,
    thesisReasoning: thesisReasoning || null,
    checkpoints: Object.fromEntries(CHECKPOINTS.map((c) => [c.label, null])),
  });

  writeOutcomes(records.length > MAX_RECORDS ? records.slice(0, MAX_RECORDS) : records);
}

async function fetchCurrentState(mintAddress) {
  const solUsd = await getSolUsdPrice();
  const curve = await fetchBondingCurveState(mintAddress);

  if (curve && !curve.complete && solUsd) {
    return {
      status: 'alive',
      marketCapUsd: curve.marketCapSol * solUsd,
      liquidityUsd: curve.realSolReservesSol * solUsd,
      priceUsd: curve.priceSolPerToken * solUsd,
    };
  }

  // graduated, or bonding curve unreadable — try DexScreener
  const pair = await getPairsForMint(mintAddress);
  if (pair) {
    return {
      status: curve?.complete ? 'graduated' : 'alive',
      marketCapUsd: pair.marketCapUsd || 0,
      liquidityUsd: pair.liquidityUsd || 0,
      priceUsd: pair.priceUsd || 0,
    };
  }

  // no data anywhere — almost always means the token was abandoned with
  // zero real activity, which is itself a meaningful, common outcome
  return { status: 'dead', marketCapUsd: 0, liquidityUsd: 0, priceUsd: 0 };
}

/** Call once per tick — fills in whatever checkpoints are currently due, a few at a time. */
export async function processDueCheckpoints() {
  const records = readOutcomes();
  const now = Date.now();

  const due = [];
  for (const record of records) {
    for (const { label, ms } of CHECKPOINTS) {
      if (record.checkpoints[label] === null && now - new Date(record.evaluatedAt).getTime() >= ms) {
        due.push({ record, label });
      }
    }
  }

  const toProcess = due.slice(0, MAX_CHECKS_PER_TICK);
  if (!toProcess.length) return { checked: 0, pending: due.length };

  for (const { record, label } of toProcess) {
    try {
      const state = await fetchCurrentState(record.mintAddress);
      record.checkpoints[label] = { checkedAt: new Date().toISOString(), ...state };
    } catch (err) {
      record.checkpoints[label] = { checkedAt: new Date().toISOString(), status: 'error' };
    }
  }

  writeOutcomes(records);
  return { checked: toProcess.length, pending: due.length - toProcess.length };
}

export function getOutcomes(limit = 100) {
  return readOutcomes().slice(0, limit);
}
