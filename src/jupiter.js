import axios from 'axios';
import { VersionedTransaction } from '@solana/web3.js';
import { connection, wallet } from './rpc.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
// lite-api.jup.ag is Jupiter's current keyless endpoint, fine for a
// personal-scale bot. quote-api.jup.ag/v6 (the old endpoint) was retired.
// For higher rate limits later: get a key at portal.jup.ag and switch to
// https://api.jup.ag/swap/v1 with an `x-api-key` header.
const QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const SWAP_URL = 'https://lite-api.jup.ag/swap/v1/swap';

/**
 * Executes a swap from SOL into the target token (a "buy").
 * amountSol is a plain number, e.g. 0.25
 */
export async function buyToken(mintAddress, amountSol, slippageBps = 100) {
  const amountLamports = Math.floor(amountSol * 1e9);
  return executeSwap(SOL_MINT, mintAddress, amountLamports, slippageBps);
}

/**
 * Executes a swap from the token back into SOL (a "sell").
 * amountTokens must be in the token's raw base units (not UI amount).
 */
export async function sellToken(mintAddress, amountTokens, slippageBps = 150) {
  return executeSwap(mintAddress, SOL_MINT, amountTokens, slippageBps);
}

async function executeSwap(inputMint, outputMint, amount, slippageBps) {
  const quoteRes = await axios.get(QUOTE_URL, {
    params: {
      inputMint,
      outputMint,
      amount,
      slippageBps,
    },
  });
  const quote = quoteRes.data;

  const swapRes = await axios.post(SWAP_URL, {
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto',
  });

  const swapTxBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(swapTxBuf);
  tx.sign([wallet]);

  const signature = await connection.sendTransaction(tx, { maxRetries: 3 });
  const confirmation = await connection.confirmTransaction(signature, 'confirmed');

  if (confirmation.value.err) {
    throw new Error(`swap failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }

  return {
    signature,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    priceImpactPct: quote.priceImpactPct,
  };
}
