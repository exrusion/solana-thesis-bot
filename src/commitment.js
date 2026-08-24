import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  Keypair,
  Transaction,
  TransactionInstruction,
  PublicKey,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { connection } from './rpc.js';
import { config } from './config.js';

/**
 * Commit-reveal proof of work.
 *
 * Before a trade can happen, the whole decision — mint, verdict, every
 * rule and the numbers behind it, plus a random nonce — is hashed and
 * ONLY the hash is written into a Solana memo. A validator timestamps
 * that memo in a confirmed block. After the reveal delay the plaintext
 * is published; anyone can sha256 it and check it against the hash that
 * was already sealed in an earlier block.
 *
 * The memo is signed by a SEPARATE burner key that cannot sign trades,
 * so the timestamping side and the trading side are different keys.
 */

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const COMMITMENTS_FILE = path.join(path.resolve(config.dataDir), 'commitments.json');
const REVEAL_AFTER_MS = 20 * 60 * 1000;
const MAX_STORED = 1000;
const PREFIX = 'pumptrade-commit-v1';

let memoKeypair = null;
if (config.memoPrivateKey) {
  try {
    memoKeypair = Keypair.fromSecretKey(bs58.decode(config.memoPrivateKey));
  } catch (err) {
    console.error(`[commit] MEMO_PRIVATE_KEY is not a valid base58 secret key: ${err.message}`);
  }
}

export function memoKeyAddress() {
  return memoKeypair ? memoKeypair.publicKey.toBase58() : null;
}

function readAll() {
  try {
    if (!fs.existsSync(COMMITMENTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(COMMITMENTS_FILE, 'utf-8'));
  } catch (err) {
    return [];
  }
}

function writeAll(rows) {
  try {
    fs.mkdirSync(path.dirname(COMMITMENTS_FILE), { recursive: true });
    fs.writeFileSync(COMMITMENTS_FILE, JSON.stringify(rows.slice(0, MAX_STORED), null, 2));
  } catch (err) {
    console.error(`[commit] could not save commitments: ${err.message}`);
  }
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The exact string that gets hashed. Published verbatim at reveal time. */
function buildPreimage(nonce, decision) {
  // Key order must be stable or the hash won't reproduce.
  return `${PREFIX}|${nonce}|${JSON.stringify(decision, Object.keys(decision).sort())}`;
}

/**
 * Seals a decision on chain. Returns the stored row, or null if no memo
 * key is configured (in which case the bot still trades, it just cannot
 * prove ordering).
 */
export async function sealDecision({ mint, symbol, verdict, reasoning, stats, rules }) {
  if (!memoKeypair) return null;

  const decidedAt = new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString('hex');

  const decision = {
    v: 1,
    decided_at: decidedAt,
    mint,
    symbol,
    verdict, // 'act' when it intends to buy, 'pass' when it does not
    reasoning,
    inputs: stats,
    rules,
  };

  const preimage = buildPreimage(nonce, decision);
  const hash = sha256(preimage);

  const started = Date.now();
  let memoSignature = null;
  try {
    const tx = new Transaction().add(
      new TransactionInstruction({
        keys: [],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(`${PREFIX}|${hash}`, 'utf8'),
      })
    );
    memoSignature = await sendAndConfirmTransaction(connection, tx, [memoKeypair], {
      commitment: 'confirmed',
      maxRetries: 3,
    });
  } catch (err) {
    console.error(`[commit] memo write failed for ${symbol}: ${err.message}`);
    return null;
  }

  const row = {
    id: crypto.randomBytes(6).toString('hex'),
    hash,
    nonce,
    preimage, // withheld from the public API until revealAt
    decidedAt,
    sealedAfterMs: Date.now() - started,
    memoSignature,
    revealAt: new Date(Date.now() + REVEAL_AFTER_MS).toISOString(),
    mint,
    symbol,
    verdict,
    fillSignature: null,
  };

  const rows = readAll();
  rows.unshift(row);
  writeAll(rows);
  console.log(`[commit] sealed ${symbol} (${verdict}) — memo ${memoSignature}`);
  return row;
}

/** Binds the transaction that actually filled to the commitment that named it. */
export function attachFill(commitmentId, fillSignature) {
  const rows = readAll();
  const row = rows.find((r) => r.id === commitmentId);
  if (!row) return;
  row.fillSignature = fillSignature;
  writeAll(rows);
}

/**
 * Public view. The preimage is withheld until the reveal time passes —
 * that delay is the whole point: the hash is public and timestamped long
 * before the reasoning behind it is.
 */
export function getCommitments(limit = 50) {
  const now = Date.now();
  return readAll()
    .slice(0, limit)
    .map((r) => {
      const revealed = now >= new Date(r.revealAt).getTime();
      return {
        id: r.id,
        hash: r.hash,
        decidedAt: r.decidedAt,
        sealedAfterMs: r.sealedAfterMs,
        memoSignature: r.memoSignature,
        memoUrl: `https://solscan.io/tx/${r.memoSignature}`,
        revealAt: r.revealAt,
        revealed,
        symbol: r.symbol,
        mint: r.mint,
        verdict: r.verdict,
        fillSignature: r.fillSignature,
        fillUrl: r.fillSignature ? `https://solscan.io/tx/${r.fillSignature}` : null,
        preimage: revealed ? r.preimage : null,
      };
    });
}

/**
 * Recomputes every revealed commitment and reports pass/fail per check.
 * Deliberately dumb and mechanical — no prose, just the four things that
 * would falsify the claim.
 */
export async function verifyAll(limit = 25) {
  const rows = readAll().slice(0, limit);
  const results = [];

  for (const r of rows) {
    const revealed = Date.now() >= new Date(r.revealAt).getTime();
    const result = {
      id: r.id,
      symbol: r.symbol,
      mint: r.mint,
      verdict: r.verdict,
      revealed,
      checks: {},
    };

    result.checks.hashMatchesPreimage = revealed ? sha256(r.preimage) === r.hash : null;

    try {
      const memoTx = await connection.getTransaction(r.memoSignature, {
        maxSupportedTransactionVersion: 0,
      });
      result.memoSlot = memoTx?.slot ?? null;
      result.checks.memoOnChain = !!memoTx;

      if (r.fillSignature) {
        const fillTx = await connection.getTransaction(r.fillSignature, {
          maxSupportedTransactionVersion: 0,
        });
        result.fillSlot = fillTx?.slot ?? null;
        result.checks.memoSealedBeforeFill =
          memoTx && fillTx ? memoTx.slot < fillTx.slot : null;

        const mints = (fillTx?.meta?.postTokenBalances || []).map((b) => b.mint);
        result.checks.fillTouchesCommittedMint = fillTx ? mints.includes(r.mint) : null;
      } else {
        result.checks.memoSealedBeforeFill = null;
        result.checks.fillTouchesCommittedMint = null;
      }
    } catch (err) {
      result.error = err.message;
    }

    const values = Object.values(result.checks).filter((v) => v !== null);
    result.pass = values.length > 0 && values.every((v) => v === true);
    results.push(result);
  }

  const checked = results.filter((r) => r.pass !== undefined);
  return {
    memoKey: memoKeyAddress(),
    tradingWallet: null, // filled in by the API layer
    totalChecked: checked.length,
    passing: checked.filter((r) => r.pass).length,
    failing: checked.filter((r) => !r.pass).length,
    results,
  };
}

export function getCommitmentStats() {
  const rows = readAll();
  const now = Date.now();
  return {
    memoKeyConfigured: !!memoKeypair,
    memoKey: memoKeyAddress(),
    totalSealed: rows.length,
    revealed: rows.filter((r) => now >= new Date(r.revealAt).getTime()).length,
    boundToFill: rows.filter((r) => r.fillSignature).length,
    actDecisions: rows.filter((r) => r.verdict === 'act').length,
    passDecisions: rows.filter((r) => r.verdict === 'pass').length,
    revealDelayMinutes: REVEAL_AFTER_MS / 60000,
  };
}
