let stats = {
  pendingMintsCount: 0,
  closestPendingSymbol: null,
  closestPendingMarketCapUsd: 0,
  totalResolved: 0,
  totalGivenUp: 0,
  createsSeen: 0,
  tradesSeen: 0,
  lastUpdatedAt: null,
};

export function updateScanStats(partial) {
  stats = { ...stats, ...partial, lastUpdatedAt: new Date().toISOString() };
}

export function getScanStats() {
  return stats;
}
