import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketDefinition } from "../packages/contracts/src/index.js";
import {
  HistoricalDataError,
  HistoricalScorePriorProvider,
  assessHistoricalDataSufficiency,
  deriveBinaryHandicap,
  deriveBothTeamsToScore,
  deriveStandardMarkets,
  deriveTeamTotal,
  deriveThreeWay,
  deriveTotalGoals,
  dixonColesTau,
  expectedGoals,
  exponentialTimeWeight,
  fitDixonColes,
  predictScoreDistribution,
  scoreDistributionMass,
  validateHistoricalFixtures,
  type DixonColesConfig,
  type DixonColesFitResult,
  type DixonColesModel,
  type ScoreDistribution,
  type SettledHistoricalFixture,
} from "../packages/theo/src/index.js";
import {
  chronologicalTrainTestSplit,
  evaluateFootballForecasts,
  expandingWindowFolds,
  independentPoissonBaseline,
  unconditionalScoreFrequencyBaseline,
} from "../packages/evaluation/src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(
  here,
  "../data/samples/historical/test-only/dixon-coles-fixtures.json",
);
const trainingCutoff = "2025-07-01T00:00:00.000Z";

function loadFixtures(): SettledHistoricalFixture[] {
  const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
    fixtures: Array<[string, string, string, string, number, number]>;
    defaults: Omit<SettledHistoricalFixture, "fixtureId" | "homeTeamId" | "awayTeamId" | "kickoffTime" | "homeGoals" | "awayGoals" | "availableAt">;
  };
  return raw.fixtures.map(([fixtureId, homeTeamId, awayTeamId, kickoffTime, homeGoals, awayGoals]) => ({
    ...raw.defaults,
    fixtureId,
    homeTeamId,
    awayTeamId,
    kickoffTime,
    homeGoals,
    awayGoals,
    availableAt: new Date(Date.parse(kickoffTime) + 86_400_000).toISOString(),
  }));
}

const testConfig: Partial<DixonColesConfig> = {
  halfLifeDays: 120,
  maximumGoals: 8,
  minimumEffectiveFixtureWeight: 10,
  minimumEffectiveWeightPerTeam: 4,
  minimumEffectiveWeightPerParameter: 1,
  dataRequirements: {
    minimumSettledFixtures: 20,
    minimumTeams: 4,
    minimumFixturesPerTeam: 10,
    minimumCoverageDays: 100,
    minimumCompetitions: 1,
  },
  optimization: {
    maximumIterations: 250,
    learningRate: 0.025,
    patience: 20,
    gradientTolerance: 0.2,
  } as DixonColesConfig["optimization"],
};

let fixtures: SettledHistoricalFixture[];
let fit: Extract<DixonColesFitResult, { status: "FITTED" }>;

beforeAll(() => {
  fixtures = loadFixtures();
  const result = fitDixonColes(fixtures, trainingCutoff, testConfig);
  expect(result.status).toBe("FITTED");
  fit = result as Extract<DixonColesFitResult, { status: "FITTED" }>;
});

function simpleDistribution(): ScoreDistribution {
  return {
    pi: [
      [0.1, 0.2],
      [0.3, 0.4],
    ],
    rawPi: [
      [0.1, 0.2],
      [0.3, 0.4],
    ],
    maximumGoals: 1,
    retainedMass: 1,
    truncatedTailProbability: 0,
    homeExpectedGoals: 0.7,
    awayExpectedGoals: 0.6,
    fittedRho: 0,
    uncertainty: {
      method: "DIAGONAL_PENALIZED_HESSIAN_APPROXIMATION",
      meanParameterStandardError: null,
    },
    reasonCodes: ["TEST_FIXTURE_ONLY"],
  };
}

function market(
  marketType: MarketDefinition["marketType"],
  outcomes: Array<MarketDefinition["selections"][number]["outcomeType"]>,
  parameters: MarketDefinition["parameters"] = { period: "FULL_MATCH" },
): MarketDefinition {
  const marketId = `prediction:${marketType}:${parameters.line ?? ""}:${parameters.teamId ?? ""}`;
  const createdAt = "2025-07-01T00:00:00.000Z";
  return {
    marketId,
    fixtureId: "prediction-1",
    competitionId: "TEST-COMPETITION",
    marketType,
    title: marketType,
    description: "Test-only historical prior market.",
    parameters,
    period: "FULL_MATCH",
    selections: outcomes.map((outcomeType, index) => ({
      marketId,
      selectionId: `${marketId}:${index}`,
      label: outcomeType,
      outcomeType,
      provenance: { source: "TEST_FIXTURE" },
    })),
    settlementRules: [{
      ruleId: `${marketId}:rule`,
      marketType,
      parameters,
      description: "Test settlement.",
      provenance: { source: "TEST_FIXTURE" },
    }],
    status: "OPEN",
    provenance: { source: "TEST_FIXTURE" },
    createdAt,
    updatedAt: createdAt,
  };
}

describe("historical fixture contract and sufficiency gate", () => {
  it("reports the required sufficiency audit before fitting", () => {
    const result = assessHistoricalDataSufficiency(fixtures, trainingCutoff, testConfig.dataRequirements);
    expect(result.status).toBe("SUFFICIENT_REAL_DATA");
    expect(result.audit.settledFixtureCount).toBe(24);
    expect(result.audit.numberOfTeams).toBe(4);
    expect(result.audit.competitionsRepresented).toEqual(["TEST-COMPETITION"]);
    expect(Math.min(...Object.values(result.audit.fixturesPerTeam))).toBeGreaterThanOrEqual(10);
    expect(result.audit.missingValueRate).toBe(0);
    expect(result.audit.duplicateRate).toBe(0);
  });

  it("returns INSUFFICIENT_REAL_DATA instead of fitting an underidentified model", () => {
    const result = fitDixonColes(fixtures.slice(0, 4), trainingCutoff);
    expect(result.status).toBe("INSUFFICIENT_REAL_DATA");
    expect(result.model).toBeNull();
    expect(result.reasonCodes).toContain("MODEL_NOT_FIT");
  });

  it("rejects duplicate fixtures", () => {
    expect(() => validateHistoricalFixtures(
      [...fixtures, { ...fixtures[0]! }],
      trainingCutoff,
    )).toThrowError(HistoricalDataError);
    try {
      validateHistoricalFixtures([...fixtures, { ...fixtures[0]! }], trainingCutoff);
    } catch (error) {
      expect((error as HistoricalDataError).code).toBe("DUPLICATE_FIXTURE_REJECTED");
    }
  });

  it("enforces training cutoff and availability-time no-lookahead", () => {
    const unavailable = [{
      ...fixtures[0]!,
      availableAt: "2025-07-02T00:00:00.000Z",
    }];
    expect(() => validateHistoricalFixtures(unavailable, trainingCutoff)).toThrow(
      "OBSERVATION_UNAVAILABLE_AT_TRAINING_CUTOFF",
    );
    const future = [{
      ...fixtures[0]!,
      kickoffTime: "2025-07-02T00:00:00.000Z",
      availableAt: "2025-07-03T00:00:00.000Z",
    }];
    expect(() => validateHistoricalFixtures(future, trainingCutoff)).toThrow(
      "FIXTURE_AFTER_TRAINING_CUTOFF",
    );
  });

  it("rejects unsettled fixtures and missing scores", () => {
    expect(() => validateHistoricalFixtures(
      [{ ...fixtures[0]!, status: "SCHEDULED" }],
      trainingCutoff,
    )).toThrow("UNSETTLED_FIXTURE_REJECTED");
    const missing = { ...fixtures[0] } as Partial<SettledHistoricalFixture>;
    delete missing.homeGoals;
    expect(() => validateHistoricalFixtures([missing], trainingCutoff)).toThrow("MISSING_SCORE_REJECTED");
  });
});

describe("Dixon-Coles equations and fitting", () => {
  it("enforces zero-sum attack and defence identifiability constraints", () => {
    expect(Object.values(fit.model.parameters.attack).reduce((sum, value) => sum + value, 0)).toBeCloseTo(0, 12);
    expect(Object.values(fit.model.parameters.defence).reduce((sum, value) => sum + value, 0)).toBeCloseTo(0, 12);
    expect(fit.model.diagnostics.parameterCount).toBe(9);
  });

  it("applies home advantage only at non-neutral venues", () => {
    const parameters: DixonColesModel["parameters"] = {
      teams: ["A", "B"],
      attack: { A: 0, B: 0 },
      defence: { A: 0, B: 0 },
      intercept: Math.log(1.2),
      homeAdvantage: 0.25,
      rho: 0,
    };
    const home = expectedGoals(parameters, "A", "B", false);
    const neutral = expectedGoals(parameters, "A", "B", true);
    expect(home.home).toBeGreaterThan(neutral.home);
    expect(home.away).toBeCloseTo(neutral.away, 12);
  });

  it("implements configurable exponential half-life weighting", () => {
    expect(exponentialTimeWeight(0, 30)).toBe(1);
    expect(exponentialTimeWeight(30, 30)).toBeCloseTo(0.5, 12);
    expect(exponentialTimeWeight(60, 30)).toBeCloseTo(0.25, 12);
    expect(exponentialTimeWeight(30, 60)).not.toBeCloseTo(exponentialTimeWeight(30, 30), 6);
  });

  it("applies the Dixon-Coles correction only to low scores", () => {
    const lambda = 1.4;
    const mu = 1.1;
    const rho = -0.08;
    expect(dixonColesTau(0, 0, lambda, mu, rho)).not.toBe(1);
    expect(dixonColesTau(0, 1, lambda, mu, rho)).not.toBe(1);
    expect(dixonColesTau(1, 0, lambda, mu, rho)).not.toBe(1);
    expect(dixonColesTau(1, 1, lambda, mu, rho)).not.toBe(1);
    expect(dixonColesTau(2, 1, lambda, mu, rho)).toBe(1);
  });

  it("produces a normalized nonnegative score matrix and reports truncated tail mass", () => {
    const distribution = predictScoreDistribution(fit.model, "A", "B", false);
    expect(distribution.pi).toHaveLength(9);
    expect(distribution.pi.every((row) => row.every((probability) => probability >= 0))).toBe(true);
    expect(scoreDistributionMass(distribution)).toBeCloseTo(1, 12);
    expect(distribution.truncatedTailProbability).toBeGreaterThanOrEqual(0);
    expect(distribution.retainedMass + distribution.truncatedTailProbability).toBeCloseTo(1, 12);
  });

  it("reports more omitted tail mass under tighter truncation", () => {
    const tight = predictScoreDistribution(fit.model, "A", "B", false, 3);
    const wide = predictScoreDistribution(fit.model, "A", "B", false, 8);
    expect(tight.truncatedTailProbability).toBeGreaterThan(wide.truncatedTailProbability);
  });

  it("fits deterministically for a fixed configuration", () => {
    const second = fitDixonColes(fixtures, trainingCutoff, testConfig);
    expect(second.status).toBe("FITTED");
    expect((second as Extract<DixonColesFitResult, { status: "FITTED" }>).model).toEqual(fit.model);
  });
});

describe("coherent market derivation", () => {
  it("derives 1X2, totals, BTTS, team totals, and binary handicap from one matrix", () => {
    const distribution = simpleDistribution();
    const threeWay = deriveThreeWay(distribution);
    expect(threeWay.homeWin).toBeCloseTo(0.3, 12);
    expect(threeWay.draw).toBeCloseTo(0.5, 12);
    expect(threeWay.awayWin).toBeCloseTo(0.2, 12);
    const totals = deriveTotalGoals(distribution, 1.5);
    expect(totals.over).toBeCloseTo(0.4, 12);
    expect(totals.under).toBeCloseTo(0.6, 12);
    expect(totals.push).toBeCloseTo(0, 12);
    const btts = deriveBothTeamsToScore(distribution);
    expect(btts.yes).toBeCloseTo(0.4, 12);
    expect(btts.no).toBeCloseTo(0.6, 12);
    const homeTotal = deriveTeamTotal(distribution, "HOME", 0.5);
    expect(homeTotal.over).toBeCloseTo(0.7, 12);
    expect(homeTotal.under).toBeCloseTo(0.3, 12);
    expect(homeTotal.push).toBeCloseTo(0, 12);
    const awayTotal = deriveTeamTotal(distribution, "AWAY", 0.5);
    expect(awayTotal.over).toBeCloseTo(0.6, 12);
    expect(awayTotal.under).toBeCloseTo(0.4, 12);
    expect(awayTotal.push).toBeCloseTo(0, 12);
    const handicap = deriveBinaryHandicap(distribution, -0.5);
    expect(handicap.homeCovers).toBeCloseTo(0.3, 12);
    expect(handicap.awayCovers).toBeCloseTo(0.7, 12);
    expect(handicap.line).toBeCloseTo(-0.5, 12);
  });

  it("keeps all standard cross-market partitions coherent", () => {
    const derived = deriveStandardMarkets(predictScoreDistribution(fit.model, "A", "C", false));
    expect(derived.threeWay.homeWin + derived.threeWay.draw + derived.threeWay.awayWin).toBeCloseTo(1, 12);
    for (const total of Object.values(derived.totals)) {
      expect(total.over + total.under + total.push).toBeCloseTo(1, 12);
    }
    expect(derived.bothTeamsToScore.yes + derived.bothTeamsToScore.no).toBeCloseTo(1, 12);
    for (const handicap of Object.values(derived.binaryHandicaps)) {
      expect(handicap.homeCovers + handicap.awayCovers).toBeCloseTo(1, 12);
    }
  });

  it("rejects ambiguous integer handicaps", () => {
    expect(() => deriveBinaryHandicap(simpleDistribution(), 0)).toThrow(
      "BINARY_HANDICAP_REQUIRES_HALF_GOAL_LINE",
    );
  });
});

describe("HistoricalScorePriorProvider boundary", () => {
  it("is explicit RESEARCH/REPLAY only and returns independent historical provenance", async () => {
    const provider = new HistoricalScorePriorProvider("RESEARCH", testConfig);
    expect(provider.fit(fixtures, trainingCutoff).status).toBe("FITTED");
    provider.registerPredictionFixture({
      fixtureId: "prediction-1",
      homeTeamId: "A",
      awayTeamId: "B",
      kickoffTime: "2025-07-15T12:00:00.000Z",
      neutralVenue: false,
    });
    const estimate = await provider.getTheo({
      market: market("THREE_WAY_MATCH_RESULT", ["HOME", "DRAW", "AWAY"]),
      asOf: "2025-07-10T12:00:00.000Z",
    });
    expect(estimate.status).toBe("AVAILABLE");
    expect(estimate.historicalProvenance).toBe("HISTORICAL_DIXON_COLES");
    expect(estimate.researchStatus).toBe("RESEARCH_ONLY");
    expect(estimate.reasonCodes).toContain("INDEPENDENT_HISTORICAL_PRIOR");
    expect(Object.values(estimate.probabilities!).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
  });

  it("rejects post-kickoff prediction requests", async () => {
    const provider = new HistoricalScorePriorProvider("REPLAY", testConfig);
    provider.fit(fixtures, trainingCutoff);
    provider.registerPredictionFixture({
      fixtureId: "prediction-1",
      homeTeamId: "A",
      awayTeamId: "B",
      kickoffTime: "2025-07-15T12:00:00.000Z",
      neutralVenue: false,
    });
    const estimate = await provider.getTheo({
      market: market("TOTALS", ["OVER", "UNDER"], { line: 2.5, period: "FULL_MATCH" }),
      asOf: "2025-07-15T12:00:00.001Z",
    });
    expect(estimate.status).toBe("MODEL_ERROR");
    expect(estimate.reasonCodes).toContain("POST_KICKOFF_FORECAST_REJECTED");
  });
});

describe("chronological validation infrastructure", () => {
  it("uses chronological, fixture-grouped, expanding windows without shuffling", () => {
    const split = chronologicalTrainTestSplit(fixtures, 0.25);
    expect(split.training).toHaveLength(18);
    expect(split.testing).toHaveLength(6);
    expect(split.training.every((fixture) => fixture.kickoffTime < split.testing[0]!.kickoffTime)).toBe(true);
    expect(new Set([...split.training, ...split.testing].map((fixture) => fixture.fixtureId)).size).toBe(24);
    const folds = expandingWindowFolds(fixtures, {
      minimumTrainingFixtures: 12,
      testWindowFixtures: 4,
      stepFixtures: 4,
    });
    expect(folds.length).toBeGreaterThan(1);
    expect(folds.every((fold) =>
      fold.training.every((fixture) => fixture.availableAt <= fold.trainingCutoff)
      && fold.testing.every((fixture) => fixture.kickoffTime > fold.trainingCutoff)
    )).toBe(true);
  });

  it("provides unconditional and independent-Poisson baselines and proper metrics", () => {
    const frequency = unconditionalScoreFrequencyBaseline(fixtures.slice(0, 18), 8);
    const poisson = independentPoissonBaseline(fixtures.slice(0, 18), 8);
    expect(scoreDistributionMass(frequency)).toBeCloseTo(1, 12);
    expect(scoreDistributionMass(poisson)).toBeCloseTo(1, 12);
    const metrics = evaluateFootballForecasts([{
      fixtureId: fixtures[18]!.fixtureId,
      forecastTime: fixtures[18]!.kickoffTime,
      scoreDistribution: poisson,
      actualHomeGoals: fixtures[18]!.homeGoals,
      actualAwayGoals: fixtures[18]!.awayGoals,
    }], 5);
    expect(metrics.fixtureCount).toBe(1);
    expect(metrics.oneXTwoLogLoss).toBeGreaterThanOrEqual(0);
    expect(metrics.oneXTwoBrierScore).toBeGreaterThanOrEqual(0);
    expect(metrics.rankedProbabilityScore).toBeGreaterThanOrEqual(0);
    expect(metrics.scorelineLogLoss).toBeGreaterThanOrEqual(0);
    expect(metrics.calibration).toHaveLength(5);
  });
});
