let stats = {
  pendingMintsCount: 0,
  closestPendingSymbol: null,
  closestPendingMarketCapUsd: 0,
  topPending: [], // [{ symbol, marketCapUsd }, ...] up to 3, highest first
  totalResolved: 0,
  totalGivenUp: 0,
  createsSeen: 0,
  tradesSeen: 0,
  tickCount: 0,
  startedAt: new Date().toISOString(),
  unrealizedPnlUsd: 0,
  openPositionsValueUsd: 0,
  livePositions: [],
  rejectionFunnel: {},
  lastUpdatedAt: null,
};

export function updateScanStats(partial) {
  stats = { ...stats, ...partial, lastUpdatedAt: new Date().toISOString() };
}

export function incrementTickCount() {
  stats = { ...stats, tickCount: stats.tickCount + 1 };
}

export function getScanStats() {
  return stats;
}
