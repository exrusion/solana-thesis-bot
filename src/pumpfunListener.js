import { PublicKey } from '@solana/web3.js';
import { connection } from './rpc.js';

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

const MAX_QUEUE = 150; // per-queue cap
const PROCESS_INTERVAL_MS = 1200;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 600;

// Trade signals are sampled much more sparsely than before — the previous
// rate (1-in-50) was flooding the processing queue and risked crowding out
// creates entirely, since both shared one queue with the same throughput.
const TRADE_SAMPLE_RATE = 400; // process roughly 1 in 400 trade signatures

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
    seenSignatures.add(signature);
    pendingTrades.push(signature);
    if (pendingTrades.length > MAX_QUEUE) {
      const removed = pendingTrades.shift();
      seenSignatures.delete(removed);
    }
  } else {
    stats.createLogsSeen++;
    seenSignatures.add(signature);
    pendingCreates.push(signature);
    if (pendingCreates.length > MAX_QUEUE) {
      const removed = pendingCreates.shift();
      seenSignatures.delete(removed);
    }
  }
}

async function resolveMintFromSignature(signature, isCreate) {
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
          return ix?.accounts?.[0]?.toBase58?.() || null;
        }
        // buy/sell: read the mint from token balance changes instead of a
        // fixed account index — robust regardless of exact instruction
        // account ordering. Skip WSOL specifically, since pump.fun trades
        // often touch it too and it can land before the actual traded
        // token in the balance list.
        const balances = tx.meta?.postTokenBalances || [];
        const traded = balances.find((b) => b.mint && b.mint !== SOL_MINT);
        return traded?.mint || balances[0]?.mint || null;
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
  let signature = pendingCreates.shift();
  let isCreate = true;
  if (!signature) {
    signature = pendingTrades.shift();
    isCreate = false;
  }
  if (!signature) return;

  const mint = await resolveMintFromSignature(signature, isCreate);
  if (mint) {
    if (!mint.endsWith('pump')) stats.suspiciousMints++;
    enqueueMint(mint);
    stats.resolvedTotal++;
  } else {
    stats.resolveFailures++;
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
