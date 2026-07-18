import type { PerformanceSnapshot, Portfolio } from "../../contracts/src/index.js";
import { totalUnrealizedPnl } from "../../portfolio/src/index.js";

export function buildPerformanceSnapshot(portfolio: Portfolio): PerformanceSnapshot {
  const makerPnl = portfolio.positions.reduce((acc, position) => acc + (position.makerQuantity === 0 ? 0 : position.realizedPnl), 0);
  const directionalPnl = portfolio.positions.reduce((acc, position) => acc + (position.takerQuantity === 0 ? 0 : position.realizedPnl), 0);
  return {
    performanceSnapshotId: `perf-${Date.now()}`,
    makerPnl,
    directionalPnl,
    realizedPnl: portfolio.cash.realizedPnl,
    unrealizedPnl: totalUnrealizedPnl(portfolio),
    fees: portfolio.cash.feesPaid,
    generatedAt: new Date().toISOString(),
    provenance: { source: "SYNTHETIC" },
  };
}
