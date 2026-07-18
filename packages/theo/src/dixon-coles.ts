import {
  assessHistoricalDataSufficiency,
  validateHistoricalFixtures,
  type HistoricalDataSufficiency,
  type HistoricalDataSufficiencyRequirements,
  type SettledHistoricalFixture,
} from "./historical-data.js";

export type DixonColesOptimizationConfig = {
  maximumIterations: number;
  learningRate: number;
  finiteDifferenceStep: number;
  gradientTolerance: number;
  objectiveTolerance: number;
  patience: number;
  l2Penalty: number;
  maximumAbsoluteRho: number;
  seed: number;
};

export type DixonColesConfig = {
  halfLifeDays: number;
  maximumGoals: number;
  minimumEffectiveFixtureWeight: number;
  minimumEffectiveWeightPerTeam: number;
  minimumEffectiveWeightPerParameter: number;
  optimization: DixonColesOptimizationConfig;
  dataRequirements: Partial<HistoricalDataSufficiencyRequirements>;
};

export const defaultDixonColesConfig: DixonColesConfig = {
  halfLifeDays: 365,
  maximumGoals: 8,
  minimumEffectiveFixtureWeight: 50,
  minimumEffectiveWeightPerTeam: 5,
  minimumEffectiveWeightPerParameter: 2,
  optimization: {
    maximumIterations: 350,
    learningRate: 0.03,
    finiteDifferenceStep: 1e-5,
    gradientTolerance: 1e-5,
    objectiveTolerance: 1e-8,
    patience: 30,
    l2Penalty: 0.002,
    maximumAbsoluteRho: 0.2,
    seed: 0,
  },
  dataRequirements: {},
};

export type DixonColesParameters = {
  teams: string[];
  attack: Record<string, number>;
  defence: Record<string, number>;
  intercept: number;
  homeAdvantage: number;
  rho: number;
};

export type DixonColesDiagnostics = {
  convergenceStatus: "CONVERGED" | "MAX_ITERATIONS" | "NUMERICAL_ERROR";
  converged: boolean;
  iterations: number;
  objective: number;
  gradientNorm: number;
  weightedLogLikelihood: number;
  effectiveFixtureWeight: number;
  parameterCount: number;
  attackConstraintSum: number;
  defenceConstraintSum: number;
  approximateStandardErrors: Record<string, number | null>;
  uncertaintyMethod: "DIAGONAL_PENALIZED_HESSIAN_APPROXIMATION";
  optimizer: "DETERMINISTIC_FINITE_DIFFERENCE_ADAM";
  seed: number;
};

export type DixonColesModel = {
  modelVersion: "DIXON_COLES/1.0.0";
  trainingCutoff: string;
  halfLifeDays: number;
  maximumGoals: number;
  parameters: DixonColesParameters;
  diagnostics: DixonColesDiagnostics;
  provenance: "HISTORICAL_DIXON_COLES";
  researchStatus: "RESEARCH_ONLY";
};

export type DixonColesFitResult =
  | {
      status: "INSUFFICIENT_REAL_DATA";
      sufficiency: HistoricalDataSufficiency;
      model: null;
      reasonCodes: string[];
    }
  | {
      status: "OPTIMIZATION_FAILED";
      sufficiency: HistoricalDataSufficiency;
      model: null;
      reasonCodes: string[];
    }
  | {
      status: "FITTED";
      sufficiency: HistoricalDataSufficiency;
      model: DixonColesModel;
      reasonCodes: string[];
    };

export type ScoreDistribution = {
  /** Conditional-on-retained-grid matrix used for coherent market derivation. */
  pi: number[][];
  /** Unconditional cell probabilities used for scoreline likelihood. */
  rawPi: number[][];
  maximumGoals: number;
  retainedMass: number;
  truncatedTailProbability: number;
  homeExpectedGoals: number;
  awayExpectedGoals: number;
  fittedRho: number;
  uncertainty: {
    method: "DIAGONAL_PENALIZED_HESSIAN_APPROXIMATION" | "NOT_ESTIMATED_BASELINE";
    meanParameterStandardError: number | null;
  };
  reasonCodes: string[];
};

type OptimizationContext = {
  fixtures: SettledHistoricalFixture[];
  teams: string[];
  teamIndex: Map<string, number>;
  cutoffMs: number;
  config: DixonColesConfig;
};

type DecodedVector = {
  parameters: DixonColesParameters;
  rhoRaw: number;
};

const DAY_MS = 86_400_000;
const LOG_TWO = Math.log(2);

export function exponentialTimeWeight(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays < 0) throw new Error("INVALID_FIXTURE_AGE");
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) throw new Error("INVALID_HALF_LIFE");
  return Math.exp(-LOG_TWO * ageDays / halfLifeDays);
}

export function poissonProbability(goals: number, rate: number): number {
  if (!Number.isInteger(goals) || goals < 0 || !Number.isFinite(rate) || rate <= 0) return 0;
  return Math.exp(-rate + goals * Math.log(rate) - logFactorial(goals));
}

export function dixonColesTau(homeGoals: number, awayGoals: number, lambda: number, mu: number, rho: number): number {
  if (homeGoals === 0 && awayGoals === 0) return 1 - lambda * mu * rho;
  if (homeGoals === 0 && awayGoals === 1) return 1 + lambda * rho;
  if (homeGoals === 1 && awayGoals === 0) return 1 + mu * rho;
  if (homeGoals === 1 && awayGoals === 1) return 1 - rho;
  return 1;
}

function logFactorial(value: number): number {
  let result = 0;
  for (let i = 2; i <= value; i += 1) result += Math.log(i);
  return result;
}

function mergeConfig(config: Partial<DixonColesConfig>): DixonColesConfig {
  return {
    ...defaultDixonColesConfig,
    ...config,
    optimization: { ...defaultDixonColesConfig.optimization, ...config.optimization },
    dataRequirements: { ...defaultDixonColesConfig.dataRequirements, ...config.dataRequirements },
  };
}

function assertConfig(config: DixonColesConfig): void {
  const optimization = config.optimization;
  if (
    !Number.isFinite(config.halfLifeDays)
    || config.halfLifeDays <= 0
    || !Number.isInteger(config.maximumGoals)
    || config.maximumGoals < 1
    || !Number.isFinite(config.minimumEffectiveFixtureWeight)
    || config.minimumEffectiveFixtureWeight <= 0
    || !Number.isFinite(config.minimumEffectiveWeightPerTeam)
    || config.minimumEffectiveWeightPerTeam <= 0
    || !Number.isFinite(config.minimumEffectiveWeightPerParameter)
    || config.minimumEffectiveWeightPerParameter <= 0
    || optimization.maximumIterations < 1
    || !Number.isInteger(optimization.maximumIterations)
    || optimization.learningRate <= 0
    || optimization.finiteDifferenceStep <= 0
    || optimization.gradientTolerance <= 0
    || optimization.objectiveTolerance <= 0
    || optimization.patience < 1
    || optimization.l2Penalty < 0
    || optimization.maximumAbsoluteRho <= 0
    || optimization.maximumAbsoluteRho >= 1
    || !Object.values(optimization).every((value) => Number.isFinite(value))
  ) {
    throw new Error("INVALID_DIXON_COLES_CONFIG");
  }
}

function decodeVector(vector: number[], teams: string[], maximumAbsoluteRho: number): DecodedVector {
  const freeCount = Math.max(teams.length - 1, 0);
  const attackValues = vector.slice(0, freeCount);
  attackValues.push(-attackValues.reduce((sum, value) => sum + value, 0));
  const defenceValues = vector.slice(freeCount, freeCount * 2);
  defenceValues.push(-defenceValues.reduce((sum, value) => sum + value, 0));
  const intercept = vector[freeCount * 2] ?? 0;
  const homeAdvantage = vector[freeCount * 2 + 1] ?? 0;
  const rhoRaw = vector[freeCount * 2 + 2] ?? 0;
  const rho = maximumAbsoluteRho * Math.tanh(rhoRaw);
  return {
    parameters: {
      teams,
      attack: Object.fromEntries(teams.map((team, index) => [team, attackValues[index] ?? 0])),
      defence: Object.fromEntries(teams.map((team, index) => [team, defenceValues[index] ?? 0])),
      intercept,
      homeAdvantage,
      rho,
    },
    rhoRaw,
  };
}

export function expectedGoals(
  parameters: DixonColesParameters,
  homeTeamId: string,
  awayTeamId: string,
  neutralVenue: boolean,
): { home: number; away: number } {
  const homeAttack = parameters.attack[homeTeamId];
  const awayAttack = parameters.attack[awayTeamId];
  const homeDefence = parameters.defence[homeTeamId];
  const awayDefence = parameters.defence[awayTeamId];
  if ([homeAttack, awayAttack, homeDefence, awayDefence].some((value) => value === undefined)) {
    throw new Error("UNKNOWN_TEAM_IN_DIXON_COLES_MODEL");
  }
  const homeLogRate = parameters.intercept + homeAttack! - awayDefence!
    + (neutralVenue ? 0 : parameters.homeAdvantage);
  const awayLogRate = parameters.intercept + awayAttack! - homeDefence!;
  return {
    home: Math.exp(Math.max(-5, Math.min(5, homeLogRate))),
    away: Math.exp(Math.max(-5, Math.min(5, awayLogRate))),
  };
}

function objective(vector: number[], context: OptimizationContext): number {
  const decoded = decodeVector(vector, context.teams, context.config.optimization.maximumAbsoluteRho);
  let weightedLogLikelihood = 0;
  let totalWeight = 0;
  for (const fixture of context.fixtures) {
    const ageDays = Math.max(0, (context.cutoffMs - Date.parse(fixture.kickoffTime)) / DAY_MS);
    const weight = exponentialTimeWeight(ageDays, context.config.halfLifeDays);
    const rates = expectedGoals(
      decoded.parameters,
      fixture.homeTeamId,
      fixture.awayTeamId,
      fixture.neutralVenue,
    );
    const lowScoreTaus = [
      dixonColesTau(0, 0, rates.home, rates.away, decoded.parameters.rho),
      dixonColesTau(0, 1, rates.home, rates.away, decoded.parameters.rho),
      dixonColesTau(1, 0, rates.home, rates.away, decoded.parameters.rho),
      dixonColesTau(1, 1, rates.home, rates.away, decoded.parameters.rho),
    ];
    if (lowScoreTaus.some((value) => !Number.isFinite(value) || value <= 1e-12)) {
      return 1e12;
    }
    const tau = dixonColesTau(fixture.homeGoals, fixture.awayGoals, rates.home, rates.away, decoded.parameters.rho);
    if (!Number.isFinite(tau) || tau <= 1e-12) return 1e12 + Math.abs(tau) * 1e8;
    const logProbability = Math.log(tau)
      - rates.home + fixture.homeGoals * Math.log(rates.home) - logFactorial(fixture.homeGoals)
      - rates.away + fixture.awayGoals * Math.log(rates.away) - logFactorial(fixture.awayGoals);
    if (!Number.isFinite(logProbability)) return 1e12;
    weightedLogLikelihood += weight * logProbability;
    totalWeight += weight;
  }
  const regularized = [
    ...Object.values(decoded.parameters.attack),
    ...Object.values(decoded.parameters.defence),
    decoded.parameters.intercept,
    decoded.parameters.homeAdvantage,
  ];
  const penalty = context.config.optimization.l2Penalty
    * regularized.reduce((sum, value) => sum + value * value, 0);
  return -weightedLogLikelihood + penalty;
}

function finiteDifferenceGradient(vector: number[], context: OptimizationContext): number[] {
  const step = context.config.optimization.finiteDifferenceStep;
  return vector.map((_, index) => {
    const plus = [...vector];
    const minus = [...vector];
    plus[index] += step;
    minus[index] -= step;
    return (objective(plus, context) - objective(minus, context)) / (2 * step);
  });
}

function approximateStandardErrors(
  vector: number[],
  context: OptimizationContext,
  names: string[],
): Record<string, number | null> {
  const step = Math.max(1e-4, context.config.optimization.finiteDifferenceStep * 10);
  const center = objective(vector, context);
  return Object.fromEntries(vector.map((_, index) => {
    const plus = [...vector];
    const minus = [...vector];
    plus[index] += step;
    minus[index] -= step;
    const curvature = (objective(plus, context) - 2 * center + objective(minus, context)) / (step * step);
    const standardError = Number.isFinite(curvature) && curvature > 1e-10 ? Math.sqrt(1 / curvature) : null;
    return [names[index] ?? `parameter_${index}`, standardError];
  }));
}

function parameterNames(teams: string[]): string[] {
  const freeTeams = teams.slice(0, -1);
  return [
    ...freeTeams.map((team) => `attack:${team}`),
    ...freeTeams.map((team) => `defence:${team}`),
    "intercept",
    "homeAdvantage",
    "rhoRaw",
  ];
}

function weightedLogLikelihood(model: DixonColesModel, fixtures: SettledHistoricalFixture[]): {
  value: number;
  effectiveWeight: number;
} {
  const cutoffMs = Date.parse(model.trainingCutoff);
  let value = 0;
  let effectiveWeight = 0;
  for (const fixture of fixtures) {
    const weight = exponentialTimeWeight(
      Math.max(0, (cutoffMs - Date.parse(fixture.kickoffTime)) / DAY_MS),
      model.halfLifeDays,
    );
    const rates = expectedGoals(model.parameters, fixture.homeTeamId, fixture.awayTeamId, fixture.neutralVenue);
    const tau = dixonColesTau(fixture.homeGoals, fixture.awayGoals, rates.home, rates.away, model.parameters.rho);
    const logProbability = Math.log(tau)
      - rates.home + fixture.homeGoals * Math.log(rates.home) - logFactorial(fixture.homeGoals)
      - rates.away + fixture.awayGoals * Math.log(rates.away) - logFactorial(fixture.awayGoals);
    value += weight * logProbability;
    effectiveWeight += weight;
  }
  return { value, effectiveWeight };
}

export function fitDixonColes(
  rows: unknown[],
  trainingCutoff: string,
  partialConfig: Partial<DixonColesConfig> = {},
): DixonColesFitResult {
  const config = mergeConfig(partialConfig);
  assertConfig(config);
  const sufficiency = assessHistoricalDataSufficiency(rows, trainingCutoff, config.dataRequirements);
  if (sufficiency.status === "INSUFFICIENT_REAL_DATA") {
    return {
      status: "INSUFFICIENT_REAL_DATA",
      sufficiency,
      model: null,
      reasonCodes: [...sufficiency.reasonCodes, "MODEL_NOT_FIT", "RESEARCH_ONLY"],
    };
  }
  const fixtures = validateHistoricalFixtures(rows, trainingCutoff);
  const teams = [...new Set(fixtures.flatMap((fixture) => [fixture.homeTeamId, fixture.awayTeamId]))].sort();
  if (teams.length < 2) {
    return {
      status: "INSUFFICIENT_REAL_DATA",
      sufficiency,
      model: null,
      reasonCodes: ["AT_LEAST_TWO_TEAMS_REQUIRED", "MODEL_NOT_FIT", "RESEARCH_ONLY"],
    };
  }
  const averageGoals = fixtures.reduce(
    (sum, fixture) => sum + fixture.homeGoals + fixture.awayGoals,
    0,
  ) / Math.max(fixtures.length * 2, 1);
  const vectorLength = 2 * (teams.length - 1) + 3;
  const cutoffMs = Date.parse(trainingCutoff);
  const effectiveWeightByTeam = new Map(teams.map((team) => [team, 0]));
  let effectiveFixtureWeight = 0;
  for (const fixture of fixtures) {
    const weight = exponentialTimeWeight(
      Math.max(0, (cutoffMs - Date.parse(fixture.kickoffTime)) / DAY_MS),
      config.halfLifeDays,
    );
    effectiveFixtureWeight += weight;
    effectiveWeightByTeam.set(fixture.homeTeamId, (effectiveWeightByTeam.get(fixture.homeTeamId) ?? 0) + weight);
    effectiveWeightByTeam.set(fixture.awayTeamId, (effectiveWeightByTeam.get(fixture.awayTeamId) ?? 0) + weight);
  }
  const minimumTeamWeight = Math.min(...effectiveWeightByTeam.values());
  const effectiveReasonCodes: string[] = [];
  if (effectiveFixtureWeight < config.minimumEffectiveFixtureWeight) {
    effectiveReasonCodes.push("MINIMUM_EFFECTIVE_FIXTURE_WEIGHT_NOT_MET");
  }
  if (minimumTeamWeight < config.minimumEffectiveWeightPerTeam) {
    effectiveReasonCodes.push("MINIMUM_EFFECTIVE_WEIGHT_PER_TEAM_NOT_MET");
  }
  if (effectiveFixtureWeight / vectorLength < config.minimumEffectiveWeightPerParameter) {
    effectiveReasonCodes.push("MINIMUM_EFFECTIVE_WEIGHT_PER_PARAMETER_NOT_MET");
  }
  if (effectiveReasonCodes.length > 0) {
    const insufficientSufficiency: HistoricalDataSufficiency = {
      ...sufficiency,
      status: "INSUFFICIENT_REAL_DATA",
      reasonCodes: [...sufficiency.reasonCodes, ...effectiveReasonCodes],
    };
    return {
      status: "INSUFFICIENT_REAL_DATA",
      sufficiency: insufficientSufficiency,
      model: null,
      reasonCodes: [...effectiveReasonCodes, "MODEL_NOT_FIT", "RESEARCH_ONLY"],
    };
  }
  let vector = Array.from({ length: vectorLength }, () => 0);
  vector[vectorLength - 3] = Math.log(Math.max(averageGoals, 0.1));
  const context: OptimizationContext = {
    fixtures,
    teams,
    teamIndex: new Map(teams.map((team, index) => [team, index])),
    cutoffMs,
    config,
  };
  const firstMoment = Array.from({ length: vectorLength }, () => 0);
  const secondMoment = Array.from({ length: vectorLength }, () => 0);
  let currentObjective = objective(vector, context);
  let bestObjective = currentObjective;
  let bestVector = [...vector];
  let gradientNorm = Number.POSITIVE_INFINITY;
  let stagnant = 0;
  let convergenceStatus: DixonColesDiagnostics["convergenceStatus"] = "MAX_ITERATIONS";
  let iterations = 0;
  for (let iteration = 1; iteration <= config.optimization.maximumIterations; iteration += 1) {
    iterations = iteration;
    const gradient = finiteDifferenceGradient(vector, context);
    gradientNorm = Math.sqrt(gradient.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(gradientNorm)) {
      convergenceStatus = "NUMERICAL_ERROR";
      break;
    }
    if (gradientNorm <= config.optimization.gradientTolerance) {
      convergenceStatus = "CONVERGED";
      break;
    }
    for (let index = 0; index < vector.length; index += 1) {
      const clippedGradient = Math.max(-10, Math.min(10, gradient[index] ?? 0));
      firstMoment[index] = 0.9 * (firstMoment[index] ?? 0) + 0.1 * clippedGradient;
      secondMoment[index] = 0.999 * (secondMoment[index] ?? 0) + 0.001 * clippedGradient * clippedGradient;
      const correctedFirst = (firstMoment[index] ?? 0) / (1 - 0.9 ** iteration);
      const correctedSecond = (secondMoment[index] ?? 0) / (1 - 0.999 ** iteration);
      vector[index] = (vector[index] ?? 0)
        - config.optimization.learningRate * correctedFirst / (Math.sqrt(correctedSecond) + 1e-8);
    }
    currentObjective = objective(vector, context);
    if (!Number.isFinite(currentObjective)) {
      convergenceStatus = "NUMERICAL_ERROR";
      break;
    }
    if (bestObjective - currentObjective > config.optimization.objectiveTolerance) {
      bestObjective = currentObjective;
      bestVector = [...vector];
      stagnant = 0;
    } else {
      stagnant += 1;
    }
    if (stagnant >= config.optimization.patience) {
      if (gradientNorm <= config.optimization.gradientTolerance) {
        convergenceStatus = "CONVERGED";
        break;
      }
      stagnant = config.optimization.patience;
    }
  }
  const finalGradient = finiteDifferenceGradient(bestVector, context);
  gradientNorm = Math.sqrt(finalGradient.reduce((sum, value) => sum + value * value, 0));
  if (Number.isFinite(gradientNorm) && gradientNorm <= config.optimization.gradientTolerance) {
    convergenceStatus = "CONVERGED";
  } else if (convergenceStatus !== "NUMERICAL_ERROR") {
    convergenceStatus = "MAX_ITERATIONS";
  }
  if (convergenceStatus === "NUMERICAL_ERROR") {
    return {
      status: "OPTIMIZATION_FAILED",
      sufficiency,
      model: null,
      reasonCodes: ["NUMERICAL_OPTIMIZATION_FAILED", "MODEL_NOT_FIT", "RESEARCH_ONLY"],
    };
  }
  if (convergenceStatus !== "CONVERGED") {
    return {
      status: "OPTIMIZATION_FAILED",
      sufficiency,
      model: null,
      reasonCodes: ["OPTIMIZER_DID_NOT_CONVERGE", "MODEL_NOT_FIT", "RESEARCH_ONLY"],
    };
  }
  vector = bestVector;
  const decoded = decodeVector(vector, teams, config.optimization.maximumAbsoluteRho);
  const names = parameterNames(teams);
  const temporaryModel: DixonColesModel = {
    modelVersion: "DIXON_COLES/1.0.0",
    trainingCutoff,
    halfLifeDays: config.halfLifeDays,
    maximumGoals: config.maximumGoals,
    parameters: decoded.parameters,
    diagnostics: {} as DixonColesDiagnostics,
    provenance: "HISTORICAL_DIXON_COLES",
    researchStatus: "RESEARCH_ONLY",
  };
  const likelihood = weightedLogLikelihood(temporaryModel, fixtures);
  const standardErrors = approximateStandardErrors(vector, context, names);
  const model: DixonColesModel = {
    ...temporaryModel,
    diagnostics: {
      convergenceStatus,
      converged: convergenceStatus === "CONVERGED",
      iterations,
      objective: bestObjective,
      gradientNorm,
      weightedLogLikelihood: likelihood.value,
      effectiveFixtureWeight: likelihood.effectiveWeight,
      parameterCount: vector.length,
      attackConstraintSum: Object.values(decoded.parameters.attack).reduce((sum, value) => sum + value, 0),
      defenceConstraintSum: Object.values(decoded.parameters.defence).reduce((sum, value) => sum + value, 0),
      approximateStandardErrors: standardErrors,
      uncertaintyMethod: "DIAGONAL_PENALIZED_HESSIAN_APPROXIMATION",
      optimizer: "DETERMINISTIC_FINITE_DIFFERENCE_ADAM",
      seed: config.optimization.seed,
    },
  };
  return {
    status: "FITTED",
    sufficiency,
    model,
    reasonCodes: [
      "RESEARCH_ONLY",
      "NOT_PROVEN_ALPHA",
      "OPTIMIZER_CONVERGED",
    ],
  };
}

export function predictScoreDistribution(
  model: DixonColesModel,
  homeTeamId: string,
  awayTeamId: string,
  neutralVenue: boolean,
  maximumGoals = model.maximumGoals,
): ScoreDistribution {
  if (!Number.isInteger(maximumGoals) || maximumGoals < 1) throw new Error("INVALID_MAXIMUM_GOALS");
  const rates = expectedGoals(model.parameters, homeTeamId, awayTeamId, neutralVenue);
  const raw = Array.from({ length: maximumGoals + 1 }, (_, homeGoals) =>
    Array.from({ length: maximumGoals + 1 }, (_, awayGoals) => {
      const tau = dixonColesTau(homeGoals, awayGoals, rates.home, rates.away, model.parameters.rho);
      if (tau <= 0) throw new Error("INVALID_DIXON_COLES_TAU_FOR_PREDICTION");
      return tau * poissonProbability(homeGoals, rates.home) * poissonProbability(awayGoals, rates.away);
    }),
  );
  const retainedMass = raw.reduce(
    (total, row) => total + row.reduce((rowTotal, probability) => rowTotal + probability, 0),
    0,
  );
  if (!Number.isFinite(retainedMass) || retainedMass <= 0) throw new Error("INVALID_SCORE_DISTRIBUTION_MASS");
  const pi = raw.map((row) => row.map((probability) => probability / retainedMass));
  const standardErrors = Object.values(model.diagnostics.approximateStandardErrors)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return {
    pi,
    rawPi: raw,
    maximumGoals,
    retainedMass,
    truncatedTailProbability: Math.max(0, 1 - retainedMass),
    homeExpectedGoals: rates.home,
    awayExpectedGoals: rates.away,
    fittedRho: model.parameters.rho,
    uncertainty: {
      method: "DIAGONAL_PENALIZED_HESSIAN_APPROXIMATION",
      meanParameterStandardError: standardErrors.length === 0
        ? null
        : standardErrors.reduce((sum, value) => sum + value, 0) / standardErrors.length,
    },
    reasonCodes: [
      "TRUNCATED_DISTRIBUTION_RENORMALIZED",
      "TAIL_PROBABILITY_REPORTED",
      "RESEARCH_ONLY",
      "NOT_PROVEN_ALPHA",
    ],
  };
}
