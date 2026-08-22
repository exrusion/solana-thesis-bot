import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const DATA_DIR = path.resolve(config.dataDir);
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const THESIS_LOG_FILE = path.join(DATA_DIR, 'thesis-log.json');
const DAILY_PNL_FILE = path.join(DATA_DIR, 'daily-pnl.json');
const SEQ_FILE = path.join(DATA_DIR, 'log-seq.json');
const TICK_FILE = path.join(DATA_DIR, 'last-tick.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  ensureDataDir();
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeJson(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// --- Positions ---

export function getOpenPositions() {
  return readJson(POSITIONS_FILE, []).filter((p) => p.status === 'open');
}

export function getAllPositions() {
  return readJson(POSITIONS_FILE, []);
}

export function openPosition(position) {
  const positions = readJson(POSITIONS_FILE, []);
  positions.push({ ...position, status: 'open', openedAt: new Date().toISOString() });
  writeJson(POSITIONS_FILE, positions);
}

export function closePosition(mintAddress, exitData) {
  const positions = readJson(POSITIONS_FILE, []);
  const idx = positions.findIndex((p) => p.mintAddress === mintAddress && p.status === 'open');
  if (idx === -1) return null;

  positions[idx] = {
    ...positions[idx],
    status: 'closed',
    closedAt: new Date().toISOString(),
    ...exitData,
  };
  writeJson(POSITIONS_FILE, positions);
  return positions[idx];
}

// --- Thesis log (the public "journal") ---

function nextLogId() {
  const seq = readJson(SEQ_FILE, { next: 1 });
  writeJson(SEQ_FILE, { next: seq.next + 1 });
  return seq.next;
}

export function logThesis(entry) {
  const log = readJson(THESIS_LOG_FILE, []);
  log.unshift({ id: nextLogId(), ...entry, timestamp: new Date().toISOString() });
  writeJson(THESIS_LOG_FILE, log.slice(0, 500)); // keep last 500 entries
}

export function getThesisLog(limit = 50) {
  return readJson(THESIS_LOG_FILE, []).slice(0, limit);
}

export function setLastTick() {
  writeJson(TICK_FILE, { lastTickAt: new Date().toISOString() });
}

export function getLastTick() {
  return readJson(TICK_FILE, { lastTickAt: null }).lastTickAt;
}

// --- Daily P&L / kill switch tracking ---

export function recordRealizedPnl(amountSol) {
  const today = new Date().toISOString().slice(0, 10);
  const record = readJson(DAILY_PNL_FILE, {});
  record[today] = (record[today] || 0) + amountSol;
  writeJson(DAILY_PNL_FILE, record);
  return record[today];
}

export function getTodaysPnl() {
  const today = new Date().toISOString().slice(0, 10);
  const record = readJson(DAILY_PNL_FILE, {});
  return record[today] || 0;
}

export function getAllTimePnl() {
  const record = readJson(DAILY_PNL_FILE, {});
  return Object.values(record).reduce((sum, v) => sum + v, 0);
}

export function getTotalSpentSol() {
  const positions = readJson(POSITIONS_FILE, []);
  return positions.reduce((sum, p) => sum + (p.entrySolAmount || 0), 0);
}
