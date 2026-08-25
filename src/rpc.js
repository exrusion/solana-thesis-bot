import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from './config.js';

export const connection = new Connection(config.heliusRpcUrl, {
  commitment: 'confirmed',
  wsEndpoint: config.heliusRpcUrl.replace('https://', 'wss://'),
});

export const wallet = Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey));

/**
 * The ACTUAL token balance held by the wallet, in raw base units.
 * Never trust a buy quote's outAmount for this — slippage means the
 * amount actually received is usually less than quoted, and trying to
 * sell more than you hold fails simulation every time.
 */
export async function getTokenBalanceRaw(mintAddress) {
  try {
    const res = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: new PublicKey(mintAddress),
    });
    let total = 0n;
    for (const acc of res.value) {
      total += BigInt(acc.account.data.parsed.info.tokenAmount.amount);
    }
    return total.toString();
  } catch (err) {
    console.error(`[rpc] token balance lookup failed for ${mintAddress}: ${err.message}`);
    return null;
  }
}

/**
 * Checks the mint account for red flags:
 * - mintAuthority still set  -> devs can print more supply
 * - freezeAuthority still set -> devs can freeze your tokens
 */
// Mint and freeze authority, once revoked, can never come back — so a
// pass here is permanent and re-checking it every tick was pure waste.
const mintSafetyCache = new Map();

export async function checkMintSafety(mintAddress) {
  const cached = mintSafetyCache.get(mintAddress);
  if (cached) return cached;
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
      const result = { safe: false, reason: 'mint authority not revoked — supply can be inflated' };
      if (mintSafetyCache.size < 5000) mintSafetyCache.set(mintAddress, result);
      return result;
    }
    if (!freezeAuthorityRevoked) {
      const result = { safe: false, reason: 'freeze authority not revoked — tokens can be frozen' };
      if (mintSafetyCache.size < 5000) mintSafetyCache.set(mintAddress, result);
      return result;
    }

    const result = { safe: true };
    if (mintSafetyCache.size < 5000) mintSafetyCache.set(mintAddress, result);
    return result;
  } catch (err) {
    return { safe: false, reason: `mint check failed: ${err.message}` };
  }
}

/**
 * Any liquidity pool / program vault is a Program Derived Address, which
 * by definition is NOT on the ed25519 curve. Real user wallets always
 * are. So instead of guessing which address is the pool, we read each
 * token account's actual owner and drop the ones owned by a PDA — that
 * catches the pump.fun bonding curve, PumpSwap pools, and any other
 * program vault, without needing to know their addresses in advance.
 */
async function fetchAccountOwners(addresses) {
  const infos = await connection.getMultipleAccountsInfo(addresses);
  return infos.map((info) => {
    if (!info || info.data.length < 64) return null;
    // SPL token account layout: mint(32) | owner(32) | amount(8) | ...
    try {
      return new PublicKey(info.data.subarray(32, 64));
    } catch (err) {
      return null;
    }
  });
}

/**
 * Real holder concentration, measured against TOTAL supply and with all
 * pool/vault accounts removed from the holder list.
 *
 * Total supply is the denominator on purpose: it's what "top 10 hold X%"
 * conventionally means, and it's the only stable measure early on. Using
 * circulating supply instead makes any young token read as 100%
 * concentrated purely because few wallets have bought yet — an artifact
 * of arithmetic, not a real distribution problem.
 */
const holderCache = new Map();
const HOLDER_CACHE_MS = 3 * 60 * 1000;

export async function checkHolderConcentration(mintAddress, maxTopHolderPercent = 20, maxTop10Percent = 30) {
  const cached = holderCache.get(mintAddress);
  if (cached && Date.now() - cached.at < HOLDER_CACHE_MS) return cached.result;

  try {
    const mintPubkey = new PublicKey(mintAddress);
    const largest = await connection.getTokenLargestAccounts(mintPubkey);
    const supplyInfo = await connection.getTokenSupply(mintPubkey);

    const totalSupply = Number(supplyInfo.value.amount);
    if (totalSupply === 0 || !largest.value.length) {
      return { safe: false, reason: 'could not read supply / holder data' };
    }

    const addresses = largest.value.map((a) => a.address);
    const owners = await fetchAccountOwners(addresses);

    const realHolders = [];
    let poolAmount = 0;
    for (let i = 0; i < largest.value.length; i++) {
      const owner = owners[i];
      const amount = Number(largest.value[i].amount);
      // owner unreadable, or owner is a PDA (pool/vault) -> not a person
      if (!owner || !PublicKey.isOnCurve(owner.toBytes())) {
        poolAmount += amount;
        continue;
      }
      realHolders.push({ amount, owner: owner.toBase58() });
    }

    if (!realHolders.length) {
      return {
        safe: true,
        topHolderPercent: 0,
        top10Percent: 0,
        realHolderCount: 0,
        poolPercent: (poolAmount / totalSupply) * 100,
      };
    }

    realHolders.sort((a, b) => b.amount - a.amount);

    const topHolderPercent = (realHolders[0].amount / totalSupply) * 100;
    const top10Amount = realHolders.slice(0, 10).reduce((sum, h) => sum + h.amount, 0);
    const top10Percent = (top10Amount / totalSupply) * 100;

    const reasons = [];
    if (topHolderPercent > maxTopHolderPercent) {
      reasons.push(`top holder controls ${topHolderPercent.toFixed(1)}% of total supply`);
    }
    if (top10Percent > maxTop10Percent) {
      reasons.push(`top 10 holders control ${top10Percent.toFixed(1)}% of total supply`);
    }

    const result = {
      safe: reasons.length === 0,
      reason: reasons.join('; '),
      topHolderPercent,
      top10Percent,
      realHolderCount: realHolders.length,
      poolPercent: (poolAmount / totalSupply) * 100,
    };
    if (holderCache.size < 3000) holderCache.set(mintAddress, { at: Date.now(), result });
    return result;
  } catch (err) {
    return { safe: false, reason: `holder check failed: ${err.message}` };
  }
}
