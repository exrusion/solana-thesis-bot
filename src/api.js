import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import {
  getOpenPositions,
  getAllPositions,
  getThesisLog,
  getTodaysPnl,
  getLastTick,
} from './positions.js';
import { connection, wallet } from './rpc.js';
import { getOutcomes, getInsightsSummary, getLearningSummary } from './outcomeTracker.js';
import { getScanStats } from './scanStats.js';
import { getRecentLogs } from './logCapture.js';
import { getModelStatus } from './mlModel.js';
import { telegramStatus } from './telegram.js';
import { askQuestion, ALLOWED_MODELS } from './askEngine.js';
import { getCommitments, getCommitmentStats, verifyAll, sha256 } from './commitment.js';
import { getSolUsdPrice } from './bondingCurve.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '16kb' }));
app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/status', async (req, res) => {
  const balanceLamports = await connection.getBalance(wallet.publicKey);
  const solBalance = balanceLamports / 1e9;
  const activity = getScanStats();
  const solUsd = await getSolUsdPrice();

  const allPositions = getAllPositions();
  const closed = allPositions.filter((p) => p.status === 'closed');
  const totalSpentSol = allPositions.reduce((sum, p) => sum + (p.entrySolAmount || 0), 0);
  const allTimeRealizedPnlSol = closed.reduce((sum, p) => sum + (p.realizedPnlSol || 0), 0);

  res.json({
    wallet: wallet.publicKey.toBase58(),
    solBalance,
    todaysRealizedPnlSol: getTodaysPnl(),
    allTimeRealizedPnlSol,
    totalSpentSol,
    openPositions: getOpenPositions().length,
    maxConcurrentPositions: config.maxConcurrentPositions,
    maxDailyLossSol: config.maxDailyLossSol,
    maxPositionSizeSol: config.maxPositionSizeSol,
    stopLossPercent: config.stopLossPercent,
    scanIntervalMs: config.scanIntervalMs,
    lastTickAt: getLastTick(),
    telegram: telegramStatus(),
    minMarketCapUsd: config.minMarketCapUsd,
    model: config.openRouterModel,
    tickCount: activity.tickCount,
    startedAt: activity.startedAt,
    unrealizedPnlUsd: activity.unrealizedPnlUsd,
    openPositionsValueUsd: activity.openPositionsValueUsd,
    livePositions: activity.livePositions || [],
    rejectionFunnel: activity.rejectionFunnel || {},
    solUsdPrice: solUsd || null,
    totalEquityUsd: solBalance * (solUsd || 0) + (activity.openPositionsValueUsd || 0),
    scanActivity: activity,
  });
});

app.get('/positions', (req, res) => {
  res.json(getAllPositions());
});

app.get('/thesis-log', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  res.json(getThesisLog(limit));
});

app.get('/outcomes', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  res.json(getOutcomes(limit));
});

app.get('/insights', (req, res) => {
  res.json(getInsightsSummary());
});

app.get('/ask/models', (req, res) => {
  res.json({ models: ALLOWED_MODELS, default: config.openRouterModel });
});

app.post('/ask', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
  const result = await askQuestion({
    question: req.body?.question,
    model: req.body?.model,
    ip,
  });
  res.status(result.error ? 429 : 200).json(result);
});

app.get('/proof.json', (req, res) => {
  res.json({
    ...getCommitmentStats(),
    tradingWallet: wallet.publicKey.toBase58(),
    commitments: getCommitments(parseInt(req.query.limit, 10) || 50),
  });
});

app.get('/verify.json', async (req, res) => {
  const result = await verifyAll(parseInt(req.query.limit, 10) || 25);
  result.tradingWallet = wallet.publicKey.toBase58();
  res.json(result);
});

app.post('/sha256', (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string') return res.status(400).json({ error: 'send { text }' });
  res.json({ sha256: sha256(text) });
});

app.get('/model', (req, res) => {
  res.json(getModelStatus());
});

app.get('/learning', (req, res) => {
  res.json(getLearningSummary());
});

app.get('/logs', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 150;
  res.json(getRecentLogs(limit));
});

app.listen(config.port, () => {
  console.log(`API listening on port ${config.port}`);
});
