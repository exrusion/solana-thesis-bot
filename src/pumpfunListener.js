import { PublicKey } from '@solana/web3.js';
import { connection } from './rpc.js';

// Official pump.fun bonding-curve program. In its "create" instruction,
// account index 0 is always the new token's mint.
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

const MAX_QUEUE = 200;
const PROCESS_INTERVAL_MS = 1200; // resolve one pending signature at roughly this pace
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 600;

const freshMints = []; // resolved: { mintAddress, detectedAt }
const pendingSignatures = []; // signatures awaiting resolution (nothing dropped on arrival)
const seenMints = new Set();
const seenSignatures = new Set();
let subscribed = false;

// Diagnostics — so we can actually see what the listener is doing
const stats = { logsSeen: 0, createLogsSeen: 0, resolvedTotal: 0, resolveFailures: 0, suspiciousMints: 0 };

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
  if (!isCreate || seenSignatures.has(signature)) return;

  stats.createLogsSeen++;
  seenSignatures.add(signature);
  pendingSignatures.push(signature);
  if (pendingSignatures.length > MAX_QUEUE) {
    const removed = pendingSignatures.shift();
    seenSignatures.delete(removed);
  }
}

async function resolveMintFromSignature(signature) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (tx) {
        const ix = tx.transaction?.message?.instructions?.find(
          (i) => i.programId?.toBase58?.() === PUMP_PROGRAM_ID.toBase58()
        );
        return ix?.accounts?.[0]?.toBase58?.() || null;
      }
    } catch (err) {
      // fall through to retry
    }
    await sleep(RETRY_DELAY_MS);
  }
  return null;
}

async function processNextPending() {
  const signature = pendingSignatures.shift();
  if (!signature) return;

  const mint = await resolveMintFromSignature(signature);
  if (mint) {
    // pump.fun's own UI grinds mint addresses to end in "pump" — a mismatch
    // doesn't necessarily mean the extraction is wrong (API-created tokens
    // without a vanity keypair won't have it), but a sustained high rate
    // here would be a red flag worth investigating.
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
  console.log('[pumpfun] listening on-chain for new token creations');
}

/** Returns and clears mints detected since the last call. */
export function drainFreshMints() {
  return freshMints.splice(0, freshMints.length).map((m) => m.mintAddress);
}

/** Diagnostics for logging — how much traffic the listener is actually seeing. */
export function getListenerStats() {
  return { ...stats, pendingCount: pendingSignatures.length };
}
