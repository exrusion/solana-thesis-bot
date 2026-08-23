import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from './config.js';

export const connection = new Connection(config.heliusRpcUrl, {
  commitment: 'confirmed',
  wsEndpoint: config.heliusRpcUrl.replace('https://', 'wss://'),
});

export const wallet = Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey));

/**
 * Checks the mint account for red flags:
 * - mintAuthority still set  -> devs can print more supply
 * - freezeAuthority still set -> devs can freeze your tokens
 */
export async function checkMintSafety(mintAddress) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const info = await connection.getParsedAccountInfo(mintPubkey);
    const parsed = info?.value?.data?.parsed?.info;

    if (!parsed) {
      return { safe: false, reason: 'could not read mint account' };
    }

    const mintAuthorityRevoked = parsed.mintAuthority === null;
    const freezeAuthorityRevoked = parsed.freezeAuthority === null;

    if (!mintAuthorityRevoked) {
      return { safe: false, reason: 'mint authority not revoked — supply can be inflated' };
    }
    if (!freezeAuthorityRevoked) {
      return { safe: false, reason: 'freeze authority not revoked — tokens can be frozen' };
    }

    return { safe: true };
  } catch (err) {
    return { safe: false, reason: `mint check failed: ${err.message}` };
  }
}

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/**
 * Derives the bonding curve's own token account. This account holds all
 * unsold supply and ALWAYS appears as the largest holder — it is the
 * liquidity pool, not a whale. Counting it as holder concentration
 * rejects healthy tokens for a problem that doesn't exist.
 */
function findBondingCurveTokenAccount(mint) {
  const [curve] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
  const [ata] = PublicKey.findProgramAddressSync(
    [curve.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

/**
 * Checks real holder concentration, excluding the bonding curve/LP.
 * Returns both top-1 and top-10 concentration among actual holders.
 */
export async function checkHolderConcentration(mintAddress, maxTopHolderPercent = 20, maxTop10Percent = 30) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const largest = await connection.getTokenLargestAccounts(mintPubkey);
    const supplyInfo = await connection.getTokenSupply(mintPubkey);

    const totalSupply = Number(supplyInfo.value.amount);
    if (totalSupply === 0 || !largest.value.length) {
      return { safe: false, reason: 'could not read supply / holder data' };
    }

    const lpAccount = findBondingCurveTokenAccount(mintPubkey).toBase58();
    const realHolders = largest.value.filter((a) => a.address.toBase58() !== lpAccount);

    if (!realHolders.length) {
      // everything is still in the curve — nobody has bought yet
      return { safe: true, topHolderPercent: 0, top10Percent: 0, circulatingHolders: 0 };
    }

    // Concentration is measured against circulating supply (what's actually
    // out of the curve), not total supply — otherwise every early token
    // looks perfectly distributed simply because the curve holds most of it.
    const lpEntry = largest.value.find((a) => a.address.toBase58() === lpAccount);
    const lpAmount = lpEntry ? Number(lpEntry.amount) : 0;
    const circulating = totalSupply - lpAmount;
    if (circulating <= 0) {
      return { safe: true, topHolderPercent: 0, top10Percent: 0, circulatingHolders: 0 };
    }

    const topHolderPercent = (Number(realHolders[0].amount) / circulating) * 100;
    const top10Amount = realHolders.slice(0, 10).reduce((sum, a) => sum + Number(a.amount), 0);
    const top10Percent = (top10Amount / circulating) * 100;

    const reasons = [];
    if (topHolderPercent > maxTopHolderPercent) {
      reasons.push(`top holder controls ${topHolderPercent.toFixed(1)}% of circulating supply`);
    }
    if (top10Percent > maxTop10Percent) {
      reasons.push(`top 10 holders control ${top10Percent.toFixed(1)}% of circulating supply`);
    }

    return {
      safe: reasons.length === 0,
      reason: reasons.join('; '),
      topHolderPercent,
      top10Percent,
      circulatingHolders: realHolders.length,
    };
  } catch (err) {
    return { safe: false, reason: `holder check failed: ${err.message}` };
  }
}
