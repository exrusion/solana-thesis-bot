import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { fetchBondingCurveState, getSolUsdPrice } from './bondingCurve.js';
import { getPairsForMint } from './dexscreener.js';

const DATA_DIR = path.resolve(config.dataDir);
const OUTCOMES_FILE = path.join(DATA_DIR, 'outcomes.json');

// Follow-up windows — matches the intervals commonly used in published
// memecoin-outcome datasets, so this data would be directly comparable.
const CHECKPOINTS = [
  // 5m gives the panel something to show quickly; 15m matches the bot's
  // own ~20 minute holding period and is the primary training label.
  { label: '5m', ms: 5 * 60 * 1000 },
  { label: '15m', ms: 15 * 60 * 1000 },
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

async function fetchCurrentState(mintAddress, entrySnapshot) {
  const solUsd = await getSolUsdPrice();
  const curve = await fetchBondingCurveState(mintAddress);

  // A graduated token's curve account is zeroed out, so fetchBondingCurveState
  // returns null. Checking curve?.complete on a null object silently yields
  // undefined and everything got filed as "alive" — hence 0 graduated.
  if (curve && curve.complete) {
    const pair = await getPairsForMint(mintAddress);
    return {
      status: 'graduated',
      marketCapUsd: pair?.marketCapUsd || 0,
      liquidityUsd: pair?.liquidityUsd || 0,
      priceUsd: pair?.priceUsd || 0,
    };
  }

  if (curve && !curve.complete && solUsd) {
    const marketCapUsd = curve.marketCapSol * solUsd;
    const liquidityUsd = curve.realSolReservesSol * solUsd;
    const entryMc = entrySnapshot?.marketCapUsd || 0;

    // "Alive" has to mean something. A curve account existing proves
    // nothing — they persist forever. Treat a collapse from where we
    // evaluated it, or the near-total absence of committed SOL, as dead.
    const collapsed = entryMc > 0 && marketCapUsd < entryMc * 0.3;
    const abandoned = liquidityUsd < 200;

    return {
      status: collapsed || abandoned ? 'dead' : 'alive',
      marketCapUsd,
      liquidityUsd,
      priceUsd: curve.priceSolPerToken * solUsd,
    };
  }

  // Curve unreadable: either it graduated and moved to an AMM, or it's gone.
  const pair = await getPairsForMint(mintAddress);
  if (pair) {
    return {
      status: 'graduated',
      marketCapUsd: pair.marketCapUsd || 0,
      liquidityUsd: pair.liquidityUsd || 0,
      priceUsd: pair.priceUsd || 0,
    };
  }

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
      const state = await fetchCurrentState(record.mintAddress, record.entrySnapshot);
      record.checkpoints[label] = { checkedAt: new Date().toISOString(), ...state };
    } catch (err) {
      record.checkpoints[label] = { checkedAt: new Date().toISOString(), status: 'error' };
    }
  }

  writeOutcomes(records);
  return { checked: toProcess.length, pending: due.length - toProcess.length };
}

export function getAllOutcomeRecords() {
  return readOutcomes();
}

export function getOutcomes(limit = 100) {
  return readOutcomes().slice(0, limit);
}

function categorizeReason(reason) {
  if (reason.includes('liquidity $')) return 'low liquidity';
  if (reason.includes('market cap $')) return 'low market cap';
  if (reason.includes('1h volume')) return 'low volume';
  if (reason.includes('top holder controls')) return 'holder concentration';
  if (reason.includes('mint authority')) return 'mint authority not revoked';
  if (reason.includes('freeze authority')) return 'freeze authority not revoked';
  if (reason.includes('RugCheck')) return 'RugCheck flag';
  if (reason.includes('dexId')) return 'wrong DEX';
  return 'other';
}

/**
 * Real aggregate stats from the data collected so far — patterns observed,
 * not automatic adjustments. Nothing here changes bot behavior on its own;
 * it's meant to be read by a person deciding whether to tune something.
 */
export function getInsightsSummary() {
  const records = readOutcomes();
  const total = records.length;

  const byDecision = { hold: 0, fail: 0, filtered: 0 };
  for (const r of records) byDecision[r.decision] = (byDecision[r.decision] || 0) + 1;

  const checkpointStatus = { alive: 0, graduated: 0, dead: 0, error: 0, pending: 0 };
  for (const r of records) {
    const cp = r.checkpoints['1h'];
    if (!cp) checkpointStatus.pending++;
    else checkpointStatus[cp.status] = (checkpointStatus[cp.status] || 0) + 1;
  }

  const reasonCounts = {};
  for (const r of records) {
    if (!r.filterReasons) continue;
    for (const reason of r.filterReasons) {
      const category = categorizeReason(reason);
      reasonCounts[category] = (reasonCounts[category] || 0) + 1;
    }
  }
  const topReasons = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  return { total, byDecision, checkpointStatus, topReasons };
}

/**
 * Correlates each rejection reason against what actually happened to those
 * tokens afterwards. This is the genuinely useful signal: it tells you
 * whether a filter is earning its place or throwing away winners.
 *
 * Two distinct things are surfaced here, and they are NOT the same:
 *  - RugCheck flags come from a real, pre-trained ML model (wallet
 *    clustering, anomaly detection) that actively gates every candidate.
 *  - Everything else is straightforward aggregation of our own outcome
 *    data. No model is trained on it, and nothing self-adjusts.
 */
const CLASSIFIER_FIXED_AT = new Date('2026-08-24T13:00:00Z').getTime();

export function getLearningSummary() {
  const all = readOutcomes();
  // Records checked before the classifier fix are unreliable (graduated
  // tokens were filed as alive, and "alive" only meant the account
  // existed). Excluding them beats reporting known-wrong percentages.
  const records = all.filter((r) => {
    const cp = r.checkpoints['15m'] || r.checkpoints['5m'] || r.checkpoints['1h'];
    return !cp || new Date(cp.checkedAt).getTime() >= CLASSIFIER_FIXED_AT;
  });

  // only records with a resolved 1h checkpoint can tell us anything
  const resolved = records.filter((r) => {
    const cp = r.checkpoints['15m'] || r.checkpoints['5m'] || r.checkpoints['1h'];
    return cp && cp.status !== 'error';
  });

  const emptyOutcome = () => ({ dead: 0, alive: 0, graduated: 0, total: 0 });

  // How each rejection reason correlates with what happened next
  const byReason = {};
  for (const r of resolved) {
    if (!r.filterReasons) continue;
    const status = (r.checkpoints['15m'] || r.checkpoints['5m'] || r.checkpoints['1h']).status;
    const seen = new Set();
    for (const reason of r.filterReasons) {
      const cat = categorizeReason(reason);
      if (seen.has(cat)) continue; // don't double-count one token per category
      seen.add(cat);
      if (!byReason[cat]) byReason[cat] = emptyOutcome();
      byReason[cat][status] = (byReason[cat][status] || 0) + 1;
      byReason[cat].total++;
    }
  }

  const filterCalibration = Object.entries(byReason)
    .filter(([, o]) => o.total >= 2) // still low, but flagged as low-confidence in the UI
    .map(([reason, o]) => ({
      reason,
      total: o.total,
      diedPercent: (o.dead / o.total) * 100,
      survivedPercent: ((o.alive + o.graduated) / o.total) * 100,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);

  // How the AI's own verdicts held up
  const thesisCalibration = {};
  for (const r of resolved) {
    if (r.decision !== 'hold' && r.decision !== 'fail') continue;
    if (!thesisCalibration[r.decision]) thesisCalibration[r.decision] = emptyOutcome();
    const status = (r.checkpoints['15m'] || r.checkpoints['5m'] || r.checkpoints['1h']).status;
    thesisCalibration[r.decision][status] = (thesisCalibration[r.decision][status] || 0) + 1;
    thesisCalibration[r.decision].total++;
  }

  // Which RugCheck ML signals fire most often
  const rugcheckFlags = {};
  for (const r of records) {
    if (!r.filterReasons) continue;
    for (const reason of r.filterReasons) {
      if (!reason.startsWith('RugCheck danger flags:')) continue;
      const flags = reason.replace('RugCheck danger flags:', '').split(',').map((f) => f.trim());
      for (const f of flags) {
        if (f) rugcheckFlags[f] = (rugcheckFlags[f] || 0) + 1;
      }
    }
  }
  const topRugcheckFlags = Object.entries(rugcheckFlags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([flag, count]) => ({ flag, count }));

  // How close the next batch of labels is, so the panel can show progress
  // rather than an unchanging "nothing to report".
  const now = Date.now();
  let awaiting = 0;
  let soonestMs = null;
  for (const r of records) {
    const has = r.checkpoints['5m'] || r.checkpoints['15m'];
    if (has) continue;
    awaiting++;
    const due = new Date(r.evaluatedAt).getTime() + 5 * 60 * 1000 - now;
    if (due > 0 && (soonestMs === null || due < soonestMs)) soonestMs = due;
  }

  return {
    totalRecords: records.length,
    resolvedRecords: resolved.length,
    awaitingCheckpoint: awaiting,
    nextCheckpointInSeconds: soonestMs === null ? null : Math.round(soonestMs / 1000),
    filterCalibration,
    thesisCalibration,
    topRugcheckFlags,
  };
}
