import { PublicKey } from '@solana/web3.js';
import { connection } from './rpc.js';

// Official pump.fun bonding-curve program. In its "create" instruction,
// account index 0 is always the new token's mint — confirmed against the
// program's instruction layout.
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

const MAX_QUEUE = 200;
const MIN_MS_BETWEEN_LOOKUPS = 1500; // throttle so we don't hammer the RPC on busy periods

const freshMints = []; // { mintAddress, detectedAt }
const seen = new Set();
let lastLookupAt = 0;
let subscribed = false;

function enqueue(mintAddress) {
  if (!mintAddress || seen.has(mintAddress)) return;
  seen.add(mintAddress);
  freshMints.push({ mintAddress, detectedAt: Date.now() });
  if (freshMints.length > MAX_QUEUE) {
    const removed = freshMints.shift();
    seen.delete(removed.mintAddress);
  }
}

async function handleLog({ signature, logs }) {
  const isCreate = logs.some((l) => l.includes('Instruction: Create'));
  if (!isCreate) return;

  const now = Date.now();
  if (now - lastLookupAt < MIN_MS_BETWEEN_LOOKUPS) return; // throttle
  lastLookupAt = now;

  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
    const ix = tx?.transaction?.message?.instructions?.find(
      (i) => i.programId?.toBase58?.() === PUMP_PROGRAM_ID.toBase58()
    );
    const mint = ix?.accounts?.[0]?.toBase58?.();
    if (mint) enqueue(mint);
  } catch (err) {
    // transaction not propagated yet, or rate-limited — skip, we'll catch the next one
  }
}

/** Starts listening. Safe to call once at startup. */
export function startPumpFunListener() {
  if (subscribed) return;
  subscribed = true;
  connection.onLogs(PUMP_PROGRAM_ID, handleLog, 'confirmed');
  console.log('[pumpfun] listening on-chain for new token creations');
}

/** Returns and clears mints detected since the last call. */
export function drainFreshMints() {
  return freshMints.splice(0, freshMints.length).map((m) => m.mintAddress);
}
