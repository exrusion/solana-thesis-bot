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
import { getOutcomes } from './outcomeTracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/status', async (req, res) => {
  const balanceLamports = await connection.getBalance(wallet.publicKey);
  res.json({
    wallet: wallet.publicKey.toBase58(),
    solBalance: balanceLamports / 1e9,
    todaysRealizedPnlSol: getTodaysPnl(),
    openPositions: getOpenPositions().length,
    maxConcurrentPositions: config.maxConcurrentPositions,
    maxDailyLossSol: config.maxDailyLossSol,
    maxPositionSizeSol: config.maxPositionSizeSol,
    stopLossPercent: config.stopLossPercent,
    scanIntervalMs: config.scanIntervalMs,
    lastTickAt: getLastTick(),
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

app.listen(config.port, () => {
  console.log(`API listening on port ${config.port}`);
});
