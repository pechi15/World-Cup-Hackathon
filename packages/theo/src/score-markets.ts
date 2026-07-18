import type { ScoreDistribution } from "./dixon-coles.js";

export type ThreeWayProbabilities = {
  homeWin: number;
  draw: number;
  awayWin: number;
};

export type TwoWayWithPushProbabilities = {
  over: number;
  under: number;
  push: number;
};

export type BothTeamsToScoreProbabilities = {
  yes: number;
  no: number;
};

export type BinaryHandicapProbabilities = {
  homeCovers: number;
  awayCovers: number;
  line: number;
};

function forEachScore(
  distribution: ScoreDistribution,
  visit: (homeGoals: number, awayGoals: number, probability: number) => void,
): void {
  distribution.pi.forEach((row, homeGoals) => {
    row.forEach((probability, awayGoals) => visit(homeGoals, awayGoals, probability));
  });
}

export function scoreDistributionMass(distribution: ScoreDistribution): number {
  return distribution.pi.reduce(
    (total, row) => total + row.reduce((rowTotal, probability) => rowTotal + probability, 0),
    0,
  );
}

export function deriveThreeWay(distribution: ScoreDistribution): ThreeWayProbabilities {
  const result: ThreeWayProbabilities = { homeWin: 0, draw: 0, awayWin: 0 };
  forEachScore(distribution, (homeGoals, awayGoals, probability) => {
    if (homeGoals > awayGoals) result.homeWin += probability;
    else if (homeGoals === awayGoals) result.draw += probability;
    else result.awayWin += probability;
  });
  return result;
}

export function deriveTotalGoals(
  distribution: ScoreDistribution,
  line: number,
): TwoWayWithPushProbabilities {
  if (!Number.isFinite(line) || line < 0) throw new Error("INVALID_TOTAL_GOALS_LINE");
  const result: TwoWayWithPushProbabilities = { over: 0, under: 0, push: 0 };
  forEachScore(distribution, (homeGoals, awayGoals, probability) => {
    const total = homeGoals + awayGoals;
    if (total > line) result.over += probability;
    else if (total < line) result.under += probability;
    else result.push += probability;
  });
  return result;
}

export function deriveBothTeamsToScore(
  distribution: ScoreDistribution,
): BothTeamsToScoreProbabilities {
  let yes = 0;
  forEachScore(distribution, (homeGoals, awayGoals, probability) => {
    if (homeGoals > 0 && awayGoals > 0) yes += probability;
  });
  return { yes, no: 1 - yes };
}

export function deriveTeamTotal(
  distribution: ScoreDistribution,
  team: "HOME" | "AWAY",
  line: number,
): TwoWayWithPushProbabilities {
  if (!Number.isFinite(line) || line < 0) throw new Error("INVALID_TEAM_TOTAL_LINE");
  const result: TwoWayWithPushProbabilities = { over: 0, under: 0, push: 0 };
  forEachScore(distribution, (homeGoals, awayGoals, probability) => {
    const goals = team === "HOME" ? homeGoals : awayGoals;
    if (goals > line) result.over += probability;
    else if (goals < line) result.under += probability;
    else result.push += probability;
  });
  return result;
}

/**
 * Half-goal two-way handicap, with `line` added to the home score.
 * Integer/quarter lines are rejected because pushes/split settlement would not
 * be an unambiguous binary contract.
 */
export function deriveBinaryHandicap(
  distribution: ScoreDistribution,
  line: number,
): BinaryHandicapProbabilities {
  if (!Number.isFinite(line) || Math.abs(line * 2 - Math.round(line * 2)) > 1e-10 || Number.isInteger(line)) {
    throw new Error("BINARY_HANDICAP_REQUIRES_HALF_GOAL_LINE");
  }
  let homeCovers = 0;
  let awayCovers = 0;
  forEachScore(distribution, (homeGoals, awayGoals, probability) => {
    if (homeGoals + line > awayGoals) homeCovers += probability;
    else awayCovers += probability;
  });
  return { homeCovers, awayCovers, line };
}

export function deriveStandardMarkets(
  distribution: ScoreDistribution,
  totalLines: number[] = [0.5, 1.5, 2.5, 3.5],
  handicapLines: number[] = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5],
): {
  threeWay: ThreeWayProbabilities;
  totals: Record<string, TwoWayWithPushProbabilities>;
  bothTeamsToScore: BothTeamsToScoreProbabilities;
  homeTeamTotals: Record<string, TwoWayWithPushProbabilities>;
  awayTeamTotals: Record<string, TwoWayWithPushProbabilities>;
  binaryHandicaps: Record<string, BinaryHandicapProbabilities>;
} {
  return {
    threeWay: deriveThreeWay(distribution),
    totals: Object.fromEntries(totalLines.map((line) => [String(line), deriveTotalGoals(distribution, line)])),
    bothTeamsToScore: deriveBothTeamsToScore(distribution),
    homeTeamTotals: Object.fromEntries(totalLines.map((line) => [String(line), deriveTeamTotal(distribution, "HOME", line)])),
    awayTeamTotals: Object.fromEntries(totalLines.map((line) => [String(line), deriveTeamTotal(distribution, "AWAY", line)])),
    binaryHandicaps: Object.fromEntries(handicapLines.map((line) => [String(line), deriveBinaryHandicap(distribution, line)])),
  };
}
