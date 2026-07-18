import {
  poissonProbability,
  predictScoreDistribution,
  type DixonColesModel,
  type ScoreDistribution,
} from "../../theo/src/dixon-coles.js";
import { deriveThreeWay, scoreDistributionMass } from "../../theo/src/score-markets.js";
import type { SettledHistoricalFixture } from "../../theo/src/historical-data.js";

export type ChronologicalSplit = {
  training: SettledHistoricalFixture[];
  testing: SettledHistoricalFixture[];
  trainingCutoff: string;
};

export type ExpandingWindowConfig = {
  minimumTrainingFixtures: number;
  testWindowFixtures: number;
  stepFixtures: number;
};

export type ValidationForecast = {
  fixtureId: string;
  forecastTime: string;
  scoreDistribution: ScoreDistribution;
  actualHomeGoals: number;
  actualAwayGoals: number;
};

export type CalibrationBin = {
  lower: number;
  upper: number;
  count: number;
  meanForecast: number | null;
  observedFrequency: number | null;
};

export type FootballForecastMetrics = {
  fixtureCount: number;
  oneXTwoLogLoss: number | null;
  oneXTwoBrierScore: number | null;
  rankedProbabilityScore: number | null;
  scorelineLogLoss: number | null;
  calibration: CalibrationBin[];
};

function sortFixtures(fixtures: SettledHistoricalFixture[]): SettledHistoricalFixture[] {
  const seen = new Set<string>();
  for (const fixture of fixtures) {
    if (seen.has(fixture.fixtureId)) throw new Error("DUPLICATE_FIXTURE_REJECTED");
    seen.add(fixture.fixtureId);
  }
  return [...fixtures].sort((a, b) => {
    const kickoff = a.kickoffTime.localeCompare(b.kickoffTime);
    return kickoff !== 0 ? kickoff : a.fixtureId.localeCompare(b.fixtureId);
  });
}

export function chronologicalTrainTestSplit(
  fixtures: SettledHistoricalFixture[],
  testFraction: number,
): ChronologicalSplit {
  if (!(testFraction > 0 && testFraction < 1)) throw new Error("INVALID_TEST_FRACTION");
  const ordered = sortFixtures(fixtures);
  if (ordered.length < 2) throw new Error("INSUFFICIENT_FIXTURES_FOR_SPLIT");
  const testCount = Math.max(1, Math.ceil(ordered.length * testFraction));
  const splitIndex = ordered.length - testCount;
  const firstTest = ordered[splitIndex];
  if (!firstTest) throw new Error("INSUFFICIENT_FIXTURES_FOR_SPLIT");
  const cutoffMs = Date.parse(firstTest.kickoffTime) - 1;
  const training = ordered.slice(0, splitIndex).filter(
    (fixture) => Date.parse(fixture.availableAt) <= cutoffMs,
  );
  return {
    training,
    testing: ordered.slice(splitIndex),
    trainingCutoff: new Date(cutoffMs).toISOString(),
  };
}

export function expandingWindowFolds(
  fixtures: SettledHistoricalFixture[],
  config: ExpandingWindowConfig,
): ChronologicalSplit[] {
  if (
    config.minimumTrainingFixtures < 1
    || config.testWindowFixtures < 1
    || config.stepFixtures < 1
  ) {
    throw new Error("INVALID_EXPANDING_WINDOW_CONFIG");
  }
  const ordered = sortFixtures(fixtures);
  const folds: ChronologicalSplit[] = [];
  for (
    let testStart = config.minimumTrainingFixtures;
    testStart < ordered.length;
    testStart += config.stepFixtures
  ) {
    const firstTest = ordered[testStart];
    if (!firstTest) break;
    const cutoffMs = Date.parse(firstTest.kickoffTime) - 1;
    const training = ordered.slice(0, testStart).filter(
      (fixture) => Date.parse(fixture.kickoffTime) <= cutoffMs
        && Date.parse(fixture.availableAt) <= cutoffMs,
    );
    if (training.length < config.minimumTrainingFixtures) continue;
    const testing = ordered.slice(testStart, testStart + config.testWindowFixtures);
    if (testing.length === 0) break;
    folds.push({
      training,
      testing,
      trainingCutoff: new Date(cutoffMs).toISOString(),
    });
  }
  return folds;
}

export function unconditionalScoreFrequencyBaseline(
  fixtures: SettledHistoricalFixture[],
  maximumGoals: number,
  smoothing = 0.5,
): ScoreDistribution {
  if (fixtures.length === 0) throw new Error("EMPTY_BASELINE_TRAINING_SET");
  if (!Number.isInteger(maximumGoals) || maximumGoals < 1 || smoothing < 0) {
    throw new Error("INVALID_SCORE_FREQUENCY_BASELINE_CONFIG");
  }
  const cells = (maximumGoals + 1) ** 2;
  const counts = Array.from(
    { length: maximumGoals + 1 },
    () => Array.from({ length: maximumGoals + 1 }, () => smoothing),
  );
  let overflowCount = smoothing;
  for (const fixture of fixtures) {
    if (fixture.homeGoals > maximumGoals || fixture.awayGoals > maximumGoals) {
      overflowCount += 1;
    } else {
      counts[fixture.homeGoals]![fixture.awayGoals] = (counts[fixture.homeGoals]![fixture.awayGoals] ?? 0) + 1;
    }
  }
  const denominator = fixtures.length + smoothing * (cells + 1);
  const rawPi = counts.map((row) => row.map((count) => count / denominator));
  const retainedMass = rawPi.flat().reduce((sum, probability) => sum + probability, 0);
  const pi = rawPi.map((row) => row.map((probability) => probability / retainedMass));
  return {
    pi,
    rawPi,
    maximumGoals,
    retainedMass,
    truncatedTailProbability: overflowCount / denominator,
    homeExpectedGoals: fixtures.reduce((sum, fixture) => sum + fixture.homeGoals, 0) / fixtures.length,
    awayExpectedGoals: fixtures.reduce((sum, fixture) => sum + fixture.awayGoals, 0) / fixtures.length,
    fittedRho: 0,
    uncertainty: {
      method: "NOT_ESTIMATED_BASELINE",
      meanParameterStandardError: null,
    },
    reasonCodes: ["UNCONDITIONAL_SCORE_FREQUENCY_BASELINE", "TEST_OR_RESEARCH_ONLY"],
  };
}

export function independentPoissonBaseline(
  fixtures: SettledHistoricalFixture[],
  maximumGoals: number,
): ScoreDistribution {
  if (fixtures.length === 0) throw new Error("EMPTY_BASELINE_TRAINING_SET");
  if (!Number.isInteger(maximumGoals) || maximumGoals < 1) {
    throw new Error("INVALID_INDEPENDENT_POISSON_BASELINE_CONFIG");
  }
  const homeRate = Math.max(
    1e-6,
    fixtures.reduce((sum, fixture) => sum + fixture.homeGoals, 0) / fixtures.length,
  );
  const awayRate = Math.max(
    1e-6,
    fixtures.reduce((sum, fixture) => sum + fixture.awayGoals, 0) / fixtures.length,
  );
  const raw = Array.from({ length: maximumGoals + 1 }, (_, homeGoals) =>
    Array.from(
      { length: maximumGoals + 1 },
      (_, awayGoals) => poissonProbability(homeGoals, homeRate) * poissonProbability(awayGoals, awayRate),
    ),
  );
  const retainedMass = raw.flat().reduce((sum, probability) => sum + probability, 0);
  return {
    pi: raw.map((row) => row.map((probability) => probability / retainedMass)),
    rawPi: raw,
    maximumGoals,
    retainedMass,
    truncatedTailProbability: Math.max(0, 1 - retainedMass),
    homeExpectedGoals: homeRate,
    awayExpectedGoals: awayRate,
    fittedRho: 0,
    uncertainty: {
      method: "NOT_ESTIMATED_BASELINE",
      meanParameterStandardError: null,
    },
    reasonCodes: ["SIMPLE_INDEPENDENT_POISSON_BASELINE", "TEST_OR_RESEARCH_ONLY"],
  };
}

export function forecastFromModel(
  model: DixonColesModel,
  fixture: SettledHistoricalFixture,
  forecastTime: string,
): ValidationForecast {
  const forecastMs = Date.parse(forecastTime);
  const cutoffMs = Date.parse(model.trainingCutoff);
  const kickoffMs = Date.parse(fixture.kickoffTime);
  if (![forecastMs, cutoffMs, kickoffMs].every(Number.isFinite)) {
    throw new Error("INVALID_VALIDATION_TIMESTAMP");
  }
  if (forecastMs < cutoffMs) {
    throw new Error("TRAINING_CUTOFF_AFTER_FORECAST_TIME");
  }
  if (forecastMs > kickoffMs) {
    throw new Error("POST_KICKOFF_FORECAST_REJECTED");
  }
  return {
    fixtureId: fixture.fixtureId,
    forecastTime,
    scoreDistribution: predictScoreDistribution(
      model,
      fixture.homeTeamId,
      fixture.awayTeamId,
      fixture.neutralVenue,
    ),
    actualHomeGoals: fixture.homeGoals,
    actualAwayGoals: fixture.awayGoals,
  };
}

export function evaluateFootballForecasts(
  forecasts: ValidationForecast[],
  calibrationBinCount = 10,
): FootballForecastMetrics {
  if (!Number.isInteger(calibrationBinCount) || calibrationBinCount < 2) {
    throw new Error("INVALID_CALIBRATION_BIN_COUNT");
  }
  if (forecasts.length === 0) {
    return {
      fixtureCount: 0,
      oneXTwoLogLoss: null,
      oneXTwoBrierScore: null,
      rankedProbabilityScore: null,
      scorelineLogLoss: null,
      calibration: emptyCalibration(calibrationBinCount),
    };
  }
  let oneXTwoLogLoss = 0;
  let oneXTwoBrier = 0;
  let rankedProbabilityScore = 0;
  let scorelineLogLoss = 0;
  const calibrationPoints: Array<{ probability: number; observed: number }> = [];
  for (const forecast of forecasts) {
    if (Math.abs(scoreDistributionMass(forecast.scoreDistribution) - 1) > 1e-9) {
      throw new Error("INCOHERENT_SCORE_DISTRIBUTION");
    }
    const probabilities = deriveThreeWay(forecast.scoreDistribution);
    const vector = [probabilities.homeWin, probabilities.draw, probabilities.awayWin];
    const actualIndex = forecast.actualHomeGoals > forecast.actualAwayGoals
      ? 0
      : forecast.actualHomeGoals === forecast.actualAwayGoals ? 1 : 2;
    oneXTwoLogLoss -= Math.log(Math.max(vector[actualIndex] ?? 0, 1e-15));
    oneXTwoBrier += vector.reduce(
      (sum, probability, index) => sum + (probability - (index === actualIndex ? 1 : 0)) ** 2,
      0,
    );
    const cumulativeForecast = [vector[0] ?? 0, (vector[0] ?? 0) + (vector[1] ?? 0)];
    const cumulativeActual = [actualIndex === 0 ? 1 : 0, actualIndex <= 1 ? 1 : 0];
    rankedProbabilityScore += cumulativeForecast.reduce(
      (sum, probability, index) => sum + (probability - (cumulativeActual[index] ?? 0)) ** 2,
      0,
    );
    const scoreProbability = forecast.actualHomeGoals <= forecast.scoreDistribution.maximumGoals
      && forecast.actualAwayGoals <= forecast.scoreDistribution.maximumGoals
      ? forecast.scoreDistribution.rawPi[forecast.actualHomeGoals]?.[forecast.actualAwayGoals] ?? 0
      : forecast.scoreDistribution.truncatedTailProbability;
    scorelineLogLoss -= Math.log(Math.max(scoreProbability, 1e-15));
    vector.forEach((probability, index) => {
      calibrationPoints.push({ probability, observed: index === actualIndex ? 1 : 0 });
    });
  }
  return {
    fixtureCount: forecasts.length,
    oneXTwoLogLoss: oneXTwoLogLoss / forecasts.length,
    oneXTwoBrierScore: oneXTwoBrier / forecasts.length,
    rankedProbabilityScore: rankedProbabilityScore / forecasts.length,
    scorelineLogLoss: scorelineLogLoss / forecasts.length,
    calibration: buildCalibration(calibrationPoints, calibrationBinCount),
  };
}

function emptyCalibration(binCount: number): CalibrationBin[] {
  return Array.from({ length: binCount }, (_, index) => ({
    lower: index / binCount,
    upper: (index + 1) / binCount,
    count: 0,
    meanForecast: null,
    observedFrequency: null,
  }));
}

function buildCalibration(
  points: Array<{ probability: number; observed: number }>,
  binCount: number,
): CalibrationBin[] {
  const bins = emptyCalibration(binCount);
  const totals = Array.from({ length: binCount }, () => ({ probability: 0, observed: 0 }));
  for (const point of points) {
    const index = Math.min(binCount - 1, Math.floor(point.probability * binCount));
    const bin = bins[index]!;
    bin.count += 1;
    totals[index]!.probability += point.probability;
    totals[index]!.observed += point.observed;
  }
  bins.forEach((bin, index) => {
    if (bin.count > 0) {
      bin.meanForecast = totals[index]!.probability / bin.count;
      bin.observedFrequency = totals[index]!.observed / bin.count;
    }
  });
  return bins;
}
