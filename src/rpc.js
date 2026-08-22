import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from './config.js';

export const connection = new Connection(config.heliusRpcUrl, 'confirmed');

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

/**
 * Checks holder concentration via the largest token accounts.
 * Flags if the top holder controls more than maxTopHolderPercent of supply.
 */
export async function checkHolderConcentration(mintAddress, maxTopHolderPercent = 20) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const largest = await connection.getTokenLargestAccounts(mintPubkey);
    const supplyInfo = await connection.getTokenSupply(mintPubkey);

    const totalSupply = Number(supplyInfo.value.amount);
    if (totalSupply === 0 || !largest.value.length) {
      return { safe: false, reason: 'could not read supply / holder data' };
    }

    const topHolderAmount = Number(largest.value[0].amount);
    const topHolderPercent = (topHolderAmount / totalSupply) * 100;

    if (topHolderPercent > maxTopHolderPercent) {
      return {
        safe: false,
        reason: `top holder controls ${topHolderPercent.toFixed(1)}% of supply`,
      };
    }

    return { safe: true, topHolderPercent };
  } catch (err) {
    return { safe: false, reason: `holder check failed: ${err.message}` };
  }
}
