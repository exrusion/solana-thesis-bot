import { PublicKey } from '@solana/web3.js';
import { connection } from './rpc.js';
import { recordTrade } from './tradeStats.js';

// Official pump.fun bonding-curve program. In its "create" instruction,
// account index 0 is always the new token's mint.
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Reference/infrastructure tokens that should never be treated as a
// tradeable candidate, no matter how they got picked up — a hard
// safety net on top of the extraction fix below.
const BLOCKED_MINTS = new Set([
  SOL_MINT,
  'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn', // $PUMP governance token
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

const MAX_QUEUE = 400; // was saturating at 150, dropping most trade events
// This was resolving ~150 transactions a minute on its own. Discovery
// does not need that density; the scan loop re-checks everything anyway.
const PROCESS_INTERVAL_MS = 2500;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 600;

// Trades are now parsed for real buyer/volume statistics, not just
// discovery — so we sample far more of them than before. Still not 1:1,
// since resolution costs an RPC call each.
// Trade sampling is now only a discovery hint — real activity is measured
// per token in the scan loop — so it can be far sparser.
const TRADE_SAMPLE_RATE = 80;

const freshMints = []; // resolved: { mintAddress, detectedAt }
// Separate queues so high-volume trade sampling can never starve creates —
// creates are always drained first, trades only fill leftover capacity.
const pendingCreates = [];
const pendingTrades = [];
const seenMints = new Set();
const seenSignatures = new Set();
let subscribed = false;
let tradeCounter = 0;

const stats = {
  logsSeen: 0,
  createLogsSeen: 0,
  tradeLogsSeen: 0,
  resolvedTotal: 0,
  resolveFailures: 0,
  suspiciousMints: 0,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueueMint(mintAddress) {
  if (!mintAddress || seenMints.has(mintAddress) || BLOCKED_MINTS.has(mintAddress)) return;
  seenMints.add(mintAddress);
  freshMints.push({ mintAddress, detectedAt: Date.now() });
  if (freshMints.length > MAX_QUEUE) {
    const removed = freshMints.shift();
    seenMints.delete(removed.mintAddress);
  }
}

function handleLog({ signature, logs }) {
  stats.logsSeen++;

  const isCreate = logs.some((l) => l.includes('Instruction: Create'));
  const isTrade =
    !isCreate && logs.some((l) => l.includes('Instruction: Buy') || l.includes('Instruction: Sell'));

  if (!isCreate && !isTrade) return;
  if (seenSignatures.has(signature)) return;

  if (isTrade) {
    stats.tradeLogsSeen++;
    tradeCounter++;
    if (tradeCounter % TRADE_SAMPLE_RATE !== 0) return; // sampled out — most trades are skipped on purpose
    const isBuy = logs.some((l) => l.includes('Instruction: Buy'));
    seenSignatures.add(signature);
    pendingTrades.push({ signature, isBuy });
    if (pendingTrades.length > MAX_QUEUE) {
      const removed = pendingTrades.shift();
      seenSignatures.delete(removed.signature);
    }
  } else {
    stats.createLogsSeen++;
    seenSignatures.add(signature);
    pendingCreates.push({ signature, isBuy: false });
    if (pendingCreates.length > MAX_QUEUE) {
      const removed = pendingCreates.shift();
      seenSignatures.delete(removed.signature);
    }
  }
}

async function resolveTransaction(signature, isCreate) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (tx) {
        if (isCreate) {
          const ix = tx.transaction?.message?.instructions?.find(
            (i) => i.programId?.toBase58?.() === PUMP_PROGRAM_ID.toBase58()
          );
          return { mint: ix?.accounts?.[0]?.toBase58?.() || null };
        }

        // buy/sell: skip WSOL when picking the traded mint, since pump.fun
        // trades often touch it too and it can land first in the list.
        const balances = tx.meta?.postTokenBalances || [];
        const traded = balances.find((b) => b.mint && b.mint !== SOL_MINT);
        const mint = traded?.mint || balances[0]?.mint || null;

        // The fee payer is the trader. Their SOL delta approximates trade
        // size — it includes network fees, so treat it as a close proxy
        // rather than an exact figure.
        const wallet = tx.transaction?.message?.accountKeys?.[0]?.pubkey?.toBase58?.() || null;
        const pre = tx.meta?.preBalances?.[0];
        const post = tx.meta?.postBalances?.[0];
        const solAmount =
          pre !== undefined && post !== undefined ? Math.abs(pre - post) / 1e9 : 0;

        return { mint, wallet, solAmount };
      }
    } catch (err) {
      // fall through to retry
    }
    await sleep(RETRY_DELAY_MS);
  }
  return null;
}

async function processNextPending() {
  // creates always go first — trades only get processed once creates are caught up
  let item = pendingCreates.shift();
  let isCreate = true;
  if (!item) {
    item = pendingTrades.shift();
    isCreate = false;
  }
  if (!item) return;

  const parsed = await resolveTransaction(item.signature, isCreate);
  if (!parsed || !parsed.mint) {
    stats.resolveFailures++;
    return;
  }

  if (!parsed.mint.endsWith('pump')) stats.suspiciousMints++;
  enqueueMint(parsed.mint);
  stats.resolvedTotal++;

  // For trades, accumulate real per-token activity: who bought, how much,
  // and when. This is the only source of unique-buyer and buy/sell-ratio
  // data — the bonding curve account stores current state, not history.
  if (!isCreate && parsed.wallet) {
    recordTrade({
      mint: parsed.mint,
      wallet: parsed.wallet,
      isBuy: item.isBuy,
      solAmount: parsed.solAmount,
    });
  }
}

/** Starts listening. Safe to call once at startup. */
export function startPumpFunListener() {
  if (subscribed) return;
  subscribed = true;
  connection.onLogs(PUMP_PROGRAM_ID, handleLog, 'confirmed');
  setInterval(processNextPending, PROCESS_INTERVAL_MS);
  console.log('[pumpfun] listening on-chain for new AND actively-traded existing tokens (creates prioritized)');
}

/** Returns and clears mints detected since the last call. */
export function drainFreshMints() {
  return freshMints.splice(0, freshMints.length).map((m) => m.mintAddress);
}

/** Diagnostics for logging — how much traffic the listener is actually seeing. */
export function getListenerStats() {
  return { ...stats, pendingCreates: pendingCreates.length, pendingTrades: pendingTrades.length };
}
