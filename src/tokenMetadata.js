import { PublicKey } from '@solana/web3.js';
import { connection } from './rpc.js';

// Official Metaplex Token Metadata program — stores name/symbol/uri for
// every SPL token that has metadata, including all pump.fun tokens.
const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

function findMetadataAddress(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID
  );
  return pda;
}

// Metaplex on-chain strings are Borsh-encoded: a 4-byte little-endian
// length prefix followed by that many UTF-8 bytes (often null-padded).
function readBorshString(buffer, offset) {
  const len = buffer.readUInt32LE(offset);
  const value = buffer
    .subarray(offset + 4, offset + 4 + len)
    .toString('utf8')
    .replace(/\0/g, '')
    .trim();
  return { value, nextOffset: offset + 4 + len };
}

/** Returns { name, symbol } or null if metadata can't be read. */
export async function fetchTokenMetadata(mintAddress) {
  try {
    const mint = new PublicKey(mintAddress);
    const pda = findMetadataAddress(mint);
    const accountInfo = await connection.getAccountInfo(pda);
    if (!accountInfo) return null;

    const data = accountInfo.data;
    let offset = 1 + 32 + 32; // key(1) + updateAuthority(32) + mint(32)
    const name = readBorshString(data, offset);
    const symbol = readBorshString(data, name.nextOffset);

    if (!name.value && !symbol.value) return null;
    return { name: name.value, symbol: symbol.value };
  } catch (err) {
    return null;
  }
}
