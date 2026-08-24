import 'dotenv/config';

function required(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required env var: ${name}. Check your .env against .env.example`);
  }
  return val;
}

export const config = {
  heliusApiKey: required('HELIUS_API_KEY'),
  heliusRpcUrl: required('HELIUS_RPC_URL'),

  walletPrivateKey: required('WALLET_PRIVATE_KEY'),

  openRouterApiKey: required('OPENROUTER_API_KEY'),
  openRouterModel: process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5',

  maxPositionSizeSol: parseFloat(process.env.MAX_POSITION_SIZE_SOL || '0.5'),
  maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '3', 10),
  stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT || '15'),
  maxDailyLossSol: parseFloat(process.env.MAX_DAILY_LOSS_SOL || '2'),
  minHourlyVolumeUsd: parseFloat(process.env.MIN_1H_VOLUME_USD || '20000'),
  // Pump.fun's bonding curve has a virtual-reserve offset baked into its
  // pricing math, so market cap and real liquidity are NOT 1:1 — a token
  // doesn't typically cross $10k in real liquidity until its market cap
  // is already well past $30k. $10k here was borrowed from mature-DEX-pair
  // conventions and was silently rejecting most of the $10k-$30k market
  // cap range. Recalibrated to roughly match what $10k+ market cap tokens
  // actually have in real liquidity.
  minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD || '1200'),
  minMarketCapUsd: parseFloat(process.env.MIN_MARKET_CAP_USD || '5000'),
  maxMarketCapUsd: parseFloat(process.env.MAX_MARKET_CAP_USD || '1000000'),
  // We resolve roughly 1 in 8 trade events (each costs an RPC call), so
  // this counts OBSERVED unique buyers, not the true total. 8 observed
  // implies on the order of 60+ real buyers — which is the actual target.
  // If TRADE_SAMPLE_RATE in pumpfunListener.js changes, revisit this.
  minUniqueBuyers: parseInt(process.env.MIN_UNIQUE_BUYERS || '2', 10),
  minBuySellRatio: parseFloat(process.env.MIN_BUY_SELL_RATIO || '1.2'),
  maxTopHolderPercent: parseFloat(process.env.MAX_TOP_HOLDER_PERCENT || '20'),
  maxTop10Percent: parseFloat(process.env.MAX_TOP10_PERCENT || '45'),
  // Loosened deliberately so the untested buy/sell path finally executes.
  // These are plumbing-test settings, NOT the strategy you specified —
  // tighten them back once a buy and sell have completed cleanly.
  requireActivityIncreasing: process.env.REQUIRE_ACTIVITY_INCREASING === 'true',
  requireTradeActivity: process.env.REQUIRE_TRADE_ACTIVITY !== 'false',
  minTokenAgeMinutes: parseFloat(process.env.MIN_TOKEN_AGE_MINUTES || '2'),
  takeProfitPercent1: parseFloat(process.env.TAKE_PROFIT_PCT_1 || '40'),
  takeProfitPercent2: parseFloat(process.env.TAKE_PROFIT_PCT_2 || '100'),
  maxHoldMinutes: parseFloat(process.env.MAX_HOLD_MINUTES || '20'),
  // 'behavioral' (default) — ignore contract-level flags that pump.fun
  //   standardizes anyway (LP vault, mint/freeze authority) and keep only
  //   signals the curve cannot tell you: creator rug history, insider and
  //   bundler clustering, sniper concentration.
  // 'full' — act on every RugCheck flag and the numeric score.
  // 'off'  — skip RugCheck entirely.
  rugcheckMode: process.env.RUGCHECK_MODE || 'behavioral',
  maxRugcheckScore: parseFloat(process.env.MAX_RUGCHECK_SCORE || '50'),

  scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS || '60000', 10),
  port: parseInt(process.env.PORT || '3000', 10),
  dataDir: process.env.DATA_DIR || 'data',
};
