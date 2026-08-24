import fs from 'fs';
import path from 'path';
import { config } from './config.js';

/**
 * A logistic regression classifier trained on this bot's own outcome data.
 *
 * Features come from what we measure at evaluation time; the label is what
 * actually happened at the follow-up checkpoint (survived/graduated = 1,
 * dead = 0). Trained by gradient descent, weights persisted to disk, and
 * retrained periodically as new labelled outcomes arrive.
 *
 * This is genuinely trained on our data — but it is only as good as that
 * data. Below MIN_SAMPLES it refuses to make predictions rather than
 * emitting noise that looks like signal.
 */

const MODEL_FILE = path.join(path.resolve(config.dataDir), 'model.json');

const MIN_SAMPLES = 40;      // below this, predictions are not meaningful
const EPOCHS = 300;
const LEARNING_RATE = 0.08;
const L2 = 0.001;            // keeps weights from exploding on small samples

export const FEATURE_NAMES = [
  'log_market_cap',
  'log_liquidity',
  'liq_to_mcap',
  'top_holder_pct',
  'top10_pct',
  'buy_sell_ratio',
  'unique_buyers',
  'growth_pct',
  'pool_pct',
  'rugcheck_score',
];

function safeLog(x) {
  return Math.log10(Math.max(1, x || 0));
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/** Turns a stored evaluation snapshot into a fixed-length feature vector. */
export function extractFeatures(snapshot = {}) {
  const mc = snapshot.marketCapUsd || 0;
  const liq = snapshot.liquidityUsd || 0;
  return [
    safeLog(mc) / 6,                                          // ~0-1 across $1-$1M
    safeLog(liq) / 6,
    mc > 0 ? clamp(liq / mc, 0, 2) / 2 : 0,
    clamp((snapshot.topHolderPercent || 0) / 100, 0, 1),
    clamp((snapshot.top10Percent || 0) / 100, 0, 1),
    clamp((snapshot.buySellRatio === Infinity ? 10 : snapshot.buySellRatio || 0) / 10, 0, 1),
    clamp((snapshot.uniqueBuyers || 0) / 20, 0, 1),
    clamp(((snapshot.priceChange1h || 0) + 100) / 300, 0, 1),  // -100%..+200% -> 0..1
    clamp((snapshot.poolPercent || 0) / 100, 0, 1),
    clamp((snapshot.rugcheckScore || 0) / 100, 0, 1),
  ];
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function emptyModel() {
  return {
    weights: new Array(FEATURE_NAMES.length).fill(0),
    bias: 0,
    trainedAt: null,
    sampleCount: 0,
    positiveRate: null,
    trainAccuracy: null,
  };
}

let model = null;

function loadModel() {
  if (model) return model;
  try {
    if (fs.existsSync(MODEL_FILE)) {
      model = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf-8'));
      return model;
    }
  } catch (err) {
    console.error(`[ml] could not read saved model: ${err.message}`);
  }
  model = emptyModel();
  return model;
}

function saveModel(m) {
  try {
    fs.mkdirSync(path.dirname(MODEL_FILE), { recursive: true });
    fs.writeFileSync(MODEL_FILE, JSON.stringify(m, null, 2));
  } catch (err) {
    console.error(`[ml] could not save model: ${err.message}`);
  }
}

/**
 * Builds a training set from outcome records. A record is usable once it
 * has a resolved checkpoint; the label is whether the token was still
 * alive or had graduated (1) versus dead (0).
 */
export function buildTrainingSet(records) {
  const X = [];
  const y = [];
  for (const r of records) {
    const cp = r.checkpoints?.['15m'] || r.checkpoints?.['1h'];
    if (!cp || cp.status === 'error') continue;
    if (!r.entrySnapshot) continue;
    X.push(extractFeatures(r.entrySnapshot));
    y.push(cp.status === 'dead' ? 0 : 1);
  }
  return { X, y };
}

export function trainModel(records) {
  const { X, y } = buildTrainingSet(records);
  if (X.length < MIN_SAMPLES) {
    const m = loadModel();
    m.sampleCount = X.length;
    return { trained: false, reason: `only ${X.length} labelled samples, need ${MIN_SAMPLES}`, sampleCount: X.length };
  }

  const n = FEATURE_NAMES.length;
  let w = new Array(n).fill(0);
  let b = 0;

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const gw = new Array(n).fill(0);
    let gb = 0;
    for (let i = 0; i < X.length; i++) {
      let z = b;
      for (let j = 0; j < n; j++) z += w[j] * X[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < n; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < n; j++) {
      w[j] -= LEARNING_RATE * (gw[j] / X.length + L2 * w[j]);
    }
    b -= LEARNING_RATE * (gb / X.length);
  }

  let correct = 0;
  for (let i = 0; i < X.length; i++) {
    let z = b;
    for (let j = 0; j < n; j++) z += w[j] * X[i][j];
    if ((sigmoid(z) >= 0.5 ? 1 : 0) === y[i]) correct++;
  }

  const positives = y.reduce((a, v) => a + v, 0);

  model = {
    weights: w,
    bias: b,
    trainedAt: new Date().toISOString(),
    sampleCount: X.length,
    positiveRate: positives / y.length,
    trainAccuracy: correct / X.length,
  };
  saveModel(model);
  console.log(`[ml] retrained on ${X.length} samples — train accuracy ${(model.trainAccuracy * 100).toFixed(1)}%`);
  return { trained: true, ...model };
}

/** Returns a survival probability 0-1, or null when the model isn't usable yet. */
export function predictSurvival(snapshot) {
  const m = loadModel();
  if (!m.trainedAt || m.sampleCount < MIN_SAMPLES) return null;
  const f = extractFeatures(snapshot);
  let z = m.bias;
  for (let j = 0; j < f.length; j++) z += m.weights[j] * f[j];
  return sigmoid(z);
}

export function getModelStatus() {
  const m = loadModel();
  const weights = m.trainedAt
    ? FEATURE_NAMES.map((name, i) => ({ name, weight: m.weights[i] })).sort(
        (a, b) => Math.abs(b.weight) - Math.abs(a.weight)
      )
    : [];
  return {
    trained: !!m.trainedAt,
    trainedAt: m.trainedAt,
    sampleCount: m.sampleCount,
    minSamples: MIN_SAMPLES,
    positiveRate: m.positiveRate,
    trainAccuracy: m.trainAccuracy,
    weights,
  };
}
