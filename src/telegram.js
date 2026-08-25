import axios from 'axios';
import { config } from './config.js';

/**
 * Telegram notifications.
 *
 * The bot evaluates far more tokens than anyone wants pinged about, and
 * Telegram throttles aggressively, so messages go through a paced queue
 * and the noise level is configurable. Default is trades only.
 */

const SEND_INTERVAL_MS = 1500; // Telegram tolerates roughly 20/min to a channel
const MAX_QUEUE = 60;

const queue = [];
let sending = false;

function enabled() {
  return !!(config.telegramBotToken && config.telegramChatId);
}

function esc(text) {
  // Telegram MarkdownV2 needs these escaped or the message is rejected
  return String(text ?? '').replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

async function drain() {
  if (sending) return;
  sending = true;
  while (queue.length) {
    const text = queue.shift();
    try {
      await axios.post(
        `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
        {
          chat_id: config.telegramChatId,
          text,
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        },
        { timeout: 10000 }
      );
    } catch (err) {
      const detail = err.response?.data?.description || err.message;
      console.error(`[telegram] send failed: ${detail}`);
      // A bad token or chat id will fail forever — don't spin on it
      if (err.response?.status === 401 || err.response?.status === 400) {
        queue.length = 0;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, SEND_INTERVAL_MS));
  }
  sending = false;
}

function push(text) {
  if (!enabled()) return;
  if (queue.length >= MAX_QUEUE) return; // drop rather than fall further behind
  queue.push(text);
  drain();
}

/** 'trades' < 'theses' < 'all' */
function levelAllows(required) {
  const order = { trades: 1, theses: 2, all: 3 };
  return (order[config.telegramLevel] || 1) >= order[required];
}

export function notifyBuy({ symbol, mint, solAmount, marketCapUsd, reasoning, signature }) {
  const lines = [
    `🟢 *BOUGHT* $${esc(symbol)}`,
    `${esc(solAmount)} SOL · mcap ${esc('$' + Math.round(marketCapUsd || 0).toLocaleString())}`,
    '',
    ...(reasoning || []).slice(0, 3).map((r) => `• ${esc(r)}`),
    '',
    `[chart](https://pump.fun/coin/${mint})${signature ? ` · [tx](https://solscan.io/tx/${signature})` : ''}`,
  ];
  push(lines.join('\n'));
}

export function notifyExit({ symbol, mint, label, realizedPnlSol, partial, signature }) {
  const up = (realizedPnlSol ?? 0) >= 0;
  const lines = [
    `${up ? '🔵' : '🔴'} *${partial ? 'PARTIAL EXIT' : 'CLOSED'}* $${esc(symbol)}`,
    esc(label),
    realizedPnlSol !== undefined && realizedPnlSol !== null
      ? `realized ${esc((up ? '+' : '') + realizedPnlSol.toFixed(4))} SOL`
      : '',
    '',
    `[chart](https://pump.fun/coin/${mint})${signature ? ` · [tx](https://solscan.io/tx/${signature})` : ''}`,
  ].filter(Boolean);
  push(lines.join('\n'));
}

export function notifyThesis({
  symbol,
  mint,
  decision,
  marketCapUsd,
  liquidityUsd,
  recentTrades,
  reasoning,
  invalidation,
}) {
  if (!levelAllows('theses')) return;
  if (decision === 'hold') return; // buys are announced separately with fuller detail

  const stats = [
    marketCapUsd ? `mcap ${'$' + Math.round(marketCapUsd).toLocaleString()}` : null,
    liquidityUsd ? `liq ${'$' + Math.round(liquidityUsd).toLocaleString()}` : null,
    recentTrades !== undefined && recentTrades !== null ? `${recentTrades} tx/15m` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const lines = [
    `⚪️ *PASSED ON* $${esc(symbol)}`,
    stats ? esc(stats) : '',
    '',
    // full reasoning, not a truncated preview — this is the part worth reading
    ...(reasoning || []).map((r) => `• ${esc(r)}`),
    invalidation ? `\n_${esc('would reconsider if: ' + invalidation)}_` : '',
    '',
    `[chart](https://pump.fun/coin/${mint})`,
  ].filter((l) => l !== '');

  push(lines.join('\n'));
}

export function notifySkip({ symbol, mint, reasons }) {
  if (!levelAllows('all')) return;
  push(
    [`⚫️ *skipped* $${esc(symbol)}`, esc((reasons || []).join('; ')), `[chart](https://pump.fun/coin/${mint})`].join(
      '\n'
    )
  );
}

export function notifyError(message) {
  push(`⚠️ *${esc('error')}*\n${esc(message)}`);
}

export function notifyStartup() {
  if (!enabled()) return;
  push(
    [
      `🤖 *Pump Trade online*`,
      `position ${esc(config.maxPositionSizeSol)} SOL · stop ${esc(config.stopLossPercent)}% · exit ${esc(config.maxHoldMinutes)}m`,
      `mcap band ${esc('$' + config.minMarketCapUsd.toLocaleString() + '-$' + config.maxMarketCapUsd.toLocaleString())}`,
      `notify level: ${esc(config.telegramLevel)}`,
    ].join('\n')
  );
}

export function telegramStatus() {
  return {
    enabled: enabled(),
    level: config.telegramLevel,
    queued: queue.length,
  };
}
