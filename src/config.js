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
  minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD || '10000'),

  scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS || '60000', 10),
  port: parseInt(process.env.PORT || '3000', 10),
};
