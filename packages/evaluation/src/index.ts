import type { PerformanceSnapshot, Portfolio } from "../../contracts/src/index.js";
import { totalUnrealizedPnl } from "../../portfolio/src/index.js";

export type ProperScoreObservation = {
  pairingKey: string;
  forecastTime: string;
  probabilities: Record<string, number>;
  outcomeSelectionId: string;
};

export type ProperScoreSummary = {
  sampleSize: number;
  brierScore: number | null;
  logLoss: number | null;
};

export type ForecastBenchmarkComparison = {
  stateSpace: ProperScoreSummary;
  marketBaseline: ProperScoreSummary;
  brierDifference: number | null;
  logLossDifference: number | null;
  reasonCodes: string[];
};

export function brierScore(
  probabilities: Record<string, number>,
  outcomeSelectionId: string,
): number {
  if (probabilities[outcomeSelectionId] === undefined) {
    throw new Error("OUTCOME_SELECTION_MISSING_FROM_FORECAST");
  }
  return Object.entries(probabilities).reduce(
    (score, [selectionId, probability]) => score + (probability - (selectionId === outcomeSelectionId ? 1 : 0)) ** 2,
    0,
  );
}

export function logLoss(
  probabilities: Record<string, number>,
  outcomeSelectionId: string,
  epsilon = 1e-15,
): number {
  const probability = probabilities[outcomeSelectionId];
  if (probability === undefined) throw new Error("OUTCOME_SELECTION_MISSING_FROM_FORECAST");
  return -Math.log(Math.min(1 - epsilon, Math.max(epsilon, probability)));
}

export function summarizeProperScores(observations: ProperScoreObservation[]): ProperScoreSummary {
  if (observations.length === 0) return { sampleSize: 0, brierScore: null, logLoss: null };
  return {
    sampleSize: observations.length,
    brierScore: observations.reduce(
      (sum, observation) => sum + brierScore(observation.probabilities, observation.outcomeSelectionId),
      0,
    ) / observations.length,
    logLoss: observations.reduce(
      (sum, observation) => sum + logLoss(observation.probabilities, observation.outcomeSelectionId),
      0,
    ) / observations.length,
  };
}

/**
 * Paired comparison only: caller must provide forecasts made at the same
 * information time for the same observed outcomes.
 */
export function compareWithMarketBaseline(
  stateSpace: ProperScoreObservation[],
  marketBaseline: ProperScoreObservation[],
): ForecastBenchmarkComparison {
  if (stateSpace.length !== marketBaseline.length) {
    throw new Error("PAIRED_BENCHMARK_LENGTH_MISMATCH");
  }
  stateSpace.forEach((forecast, index) => {
    const baseline = marketBaseline[index];
    if (
      baseline === undefined
      || forecast.pairingKey !== baseline.pairingKey
      || forecast.forecastTime !== baseline.forecastTime
      || forecast.outcomeSelectionId !== baseline.outcomeSelectionId
    ) {
      throw new Error("PAIRED_BENCHMARK_IDENTITY_MISMATCH");
    }
  });
  const stateSpaceSummary = summarizeProperScores(stateSpace);
  const marketSummary = summarizeProperScores(marketBaseline);
  const available = stateSpaceSummary.sampleSize > 0
    && stateSpaceSummary.brierScore !== null
    && stateSpaceSummary.logLoss !== null
    && marketSummary.brierScore !== null
    && marketSummary.logLoss !== null;
  return {
    stateSpace: stateSpaceSummary,
    marketBaseline: marketSummary,
    brierDifference: available ? stateSpaceSummary.brierScore! - marketSummary.brierScore! : null,
    logLossDifference: available ? stateSpaceSummary.logLoss! - marketSummary.logLoss! : null,
    reasonCodes: available
      ? ["PAIRED_OUTCOMES_SCORED", "NO_ALPHA_CLAIM"]
      : ["NO_OUTCOMES_AVAILABLE", "BENCHMARK_NOT_ESTIMABLE", "NO_ALPHA_CLAIM"],
  };
}

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

export * from "./audit.js";
export * from "./markout.js";

