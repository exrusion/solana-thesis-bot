import { PublicKey } from '@solana/web3.js';
import { connection } from './rpc.js';

// Official pump.fun bonding-curve program. In its "create" instruction,
// account index 0 is always the new token's mint.
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

const MAX_QUEUE = 200;
const PROCESS_INTERVAL_MS = 1200;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 600;

// Buy/sell events vastly outnumber creates. Sampling these is how we
// discover EXISTING actively-traded tokens (not just ones created after
// this bot started) without hammering the RPC with every single trade.
const TRADE_SAMPLE_RATE = 50; // process roughly 1 in 50 trade signatures

const freshMints = []; // resolved: { mintAddress, detectedAt }
const pendingSignatures = []; // { signature, isCreate } awaiting resolution
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
  if (!mintAddress || seenMints.has(mintAddress)) return;
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
  } else {
    stats.createLogsSeen++;
  }

  seenSignatures.add(signature);
  pendingSignatures.push({ signature, isCreate });
  if (pendingSignatures.length > MAX_QUEUE) {
    const removed = pendingSignatures.shift();
    seenSignatures.delete(removed.signature);
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
        // account ordering, which we haven't independently verified for
        // buy/sell (only for create).
        return tx.meta?.postTokenBalances?.[0]?.mint || null;
      }
    } catch (err) {
      // fall through to retry
    }
    await sleep(RETRY_DELAY_MS);
  }
  return null;
}

async function processNextPending() {
  const item = pendingSignatures.shift();
  if (!item) return;

  const mint = await resolveMintFromSignature(item.signature, item.isCreate);
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
  console.log('[pumpfun] listening on-chain for new AND actively-traded existing tokens');
}

/** Returns and clears mints detected since the last call. */
export function drainFreshMints() {
  return freshMints.splice(0, freshMints.length).map((m) => m.mintAddress);
}

/** Diagnostics for logging — how much traffic the listener is actually seeing. */
export function getListenerStats() {
  return { ...stats, pendingCount: pendingSignatures.length };
}
