import { PublicKey } from '@solana/web3.js';
import { connection } from './rpc.js';
import { getPairsForMint } from './dexscreener.js';

const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

const MAX_NAME_LEN = 64;
const MAX_SYMBOL_LEN = 32;
const RETRIES = 3;
const RETRY_DELAY_MS = 400;

const cache = new Map(); // mint -> { name, symbol } | 'unresolved'
const MAX_CACHE = 1000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findMetadataAddress(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID
  );
  return pda;
}

/**
 * Borsh string: 4-byte LE length prefix, then that many UTF-8 bytes.
 * Metaplex pads these with nulls to a fixed width, so the declared length
 * is the padded width, not the visible text length.
 */
function readBorshString(buffer, offset, maxLen) {
  if (offset + 4 > buffer.length) return null;
  const len = buffer.readUInt32LE(offset);
  // A sane string length is the only proof we're reading the right offset.
  if (len === 0 || len > maxLen || offset + 4 + len > buffer.length) return null;
  const value = buffer
    .subarray(offset + 4, offset + 4 + len)
    .toString('utf8')
    .replace(/\0/g, '')
    .trim();
  return { value, nextOffset: offset + 4 + len };
}

/** Attempt 1: the standard Metaplex metadata account. */
async function fromMetaplex(mintAddress) {
  const mint = new PublicKey(mintAddress);
  const pda = findMetadataAddress(mint);

  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const info = await connection.getAccountInfo(pda);
      if (!info) return { ok: false, why: 'no metaplex account at derived PDA' };

      const data = info.data;
      const offset = 1 + 32 + 32; // key + updateAuthority + mint
      const name = readBorshString(data, offset, MAX_NAME_LEN);
      if (!name) return { ok: false, why: `name unreadable (account ${data.length} bytes)` };
      const symbol = readBorshString(data, name.nextOffset, MAX_SYMBOL_LEN);

      const sym = symbol?.value || '';
      const nm = name.value || '';
      if (!sym && !nm) return { ok: false, why: 'metaplex fields parsed empty' };
      return { ok: true, name: nm, symbol: sym };
    } catch (err) {
      // Rate limiting is common here — retry before giving up.
      if (attempt < RETRIES - 1) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      return { ok: false, why: `rpc error: ${err.message}` };
    }
  }
  return { ok: false, why: 'exhausted retries' };
}

/** Attempt 2: DexScreener already knows the symbol for indexed tokens. */
async function fromDexScreener(mintAddress) {
  try {
    const pair = await getPairsForMint(mintAddress);
    if (pair?.symbol) return { ok: true, name: pair.symbol, symbol: pair.symbol };
    return { ok: false, why: 'not indexed by dexscreener yet' };
  } catch (err) {
    return { ok: false, why: `dexscreener error: ${err.message}` };
  }
}

/**
 * Resolves a token's display symbol, trying every source we have before
 * falling back to a truncated address. Logs which source worked so a
 * silent, total failure of one method can't hide again.
 */
export async function fetchTokenMetadata(mintAddress) {
  const cached = cache.get(mintAddress);
  if (cached) return cached === 'unresolved' ? null : cached;

  const metaplex = await fromMetaplex(mintAddress);
  if (metaplex.ok) {
    const result = { name: metaplex.name, symbol: metaplex.symbol || metaplex.name };
    if (cache.size < MAX_CACHE) cache.set(mintAddress, result);
    return result;
  }

  const dex = await fromDexScreener(mintAddress);
  if (dex.ok) {
    console.log(`[tokenMetadata] ${mintAddress} resolved via dexscreener (metaplex: ${metaplex.why})`);
    const result = { name: dex.name, symbol: dex.symbol };
    if (cache.size < MAX_CACHE) cache.set(mintAddress, result);
    return result;
  }

  console.error(
    `[tokenMetadata] UNRESOLVED ${mintAddress} — metaplex: ${metaplex.why} | dexscreener: ${dex.why}`
  );
  if (cache.size < MAX_CACHE) cache.set(mintAddress, 'unresolved');
  return null;
}
