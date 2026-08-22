import axios from 'axios';

const BASE_URL = 'https://api.rugcheck.xyz/v1';

/**
 * Fetches RugCheck's risk report for a token. RugCheck runs actual ML
 * techniques (wallet clustering, anomaly detection, taint propagation)
 * across 20+ on-chain signals — far more than our own basic mint/holder
 * checks cover (LP lock status, sniper/bundler wallets, metadata
 * mutability, insider concentration, etc.).
 *
 * Returns null on failure — callers should treat that as "unknown," not
 * "safe" or "unsafe." We don't want a third-party outage to halt trading
 * entirely; we just lose this one signal for that check.
 */
export async function getRugCheckReport(mintAddress) {
  try {
    const res = await axios.get(`${BASE_URL}/tokens/${mintAddress}/report`, {
      timeout: 8000,
    });
    const data = res.data;

    const rugged = data?.rugged === true;
    const score = data?.score_normalised ?? data?.score ?? null;
    const risks = Array.isArray(data?.risks) ? data.risks : [];
    const dangerRisks = risks.filter((r) => r.level === 'danger').map((r) => r.name);

    return { rugged, score, dangerRisks };
  } catch (err) {
    console.error(`[rugcheck] lookup failed for ${mintAddress}: ${err.message}`);
    return null;
  }
}
