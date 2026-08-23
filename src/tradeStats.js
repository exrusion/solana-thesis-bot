/**
 * Builds real trade statistics per token from the live pump.fun event
 * stream. The bonding curve account only stores current state, not trade
 * history — so unique buyer counts, buy/sell ratios, and activity trends
 * have to be accumulated ourselves as trades happen.
 *
 * IMPORTANT: this only sees trades that occur while the bot is running,
 * and only those it manages to resolve. Counts are a floor, not a
 * complete picture — a token that traded before startup will look
 * quieter than it really is.
 */

const MAX_TOKENS = 800;
const RECENT_WINDOW_MS = 3 * 60 * 1000; // for the "activity increasing" check

const tokenStats = new Map(); // mint -> { buyers:Set, sellers:Set, buyVolSol, sellVolSol, trades:[{ts, isBuy, solAmount}], firstSeenAt }

function ensure(mint) {
  let s = tokenStats.get(mint);
  if (!s) {
    s = {
      buyers: new Set(),
      sellers: new Set(),
      buyVolSol: 0,
      sellVolSol: 0,
      trades: [],
      firstSeenAt: Date.now(),
    };
    tokenStats.set(mint, s);
    if (tokenStats.size > MAX_TOKENS) {
      const oldestKey = tokenStats.keys().next().value;
      tokenStats.delete(oldestKey);
    }
  }
  return s;
}

/** Records one observed trade. solAmount is a plain SOL number. */
export function recordTrade({ mint, wallet, isBuy, solAmount }) {
  if (!mint || !wallet) return;
  const s = ensure(mint);

  if (isBuy) {
    s.buyers.add(wallet);
    s.buyVolSol += solAmount || 0;
  } else {
    s.sellers.add(wallet);
    s.sellVolSol += solAmount || 0;
  }

  s.trades.push({ ts: Date.now(), isBuy, solAmount: solAmount || 0 });
  if (s.trades.length > 500) s.trades.shift();
}

/**
 * Returns observed stats for a token, or null if we've never seen a trade
 * for it. Callers must treat null as "unknown", not "zero activity".
 */
export function getTradeStats(mint) {
  const s = tokenStats.get(mint);
  if (!s) return null;

  const now = Date.now();
  const recent = s.trades.filter((t) => now - t.ts <= RECENT_WINDOW_MS);
  const older = s.trades.filter(
    (t) => now - t.ts > RECENT_WINDOW_MS && now - t.ts <= RECENT_WINDOW_MS * 2
  );

  // "activity increasing" = more trades in the last window than the one before it
  const activityIncreasing = older.length > 0 ? recent.length > older.length : recent.length >= 3;

  const buySellRatio = s.sellVolSol > 0 ? s.buyVolSol / s.sellVolSol : s.buyVolSol > 0 ? Infinity : 0;

  return {
    uniqueBuyers: s.buyers.size,
    uniqueSellers: s.sellers.size,
    buyVolSol: s.buyVolSol,
    sellVolSol: s.sellVolSol,
    buySellRatio,
    tradeCount: s.trades.length,
    recentTradeCount: recent.length,
    previousTradeCount: older.length,
    activityIncreasing,
    observedSinceMs: now - s.firstSeenAt,
  };
}

export function getTrackedTokenCount() {
  return tokenStats.size;
}
