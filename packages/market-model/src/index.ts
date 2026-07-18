import type { MarketDefinition, ScoreScenario, Source } from "../../contracts/src/index.js";

export type SettlementResult = {
  marketId: string;
  selectionPayouts: Record<string, number>;
  status: "SETTLED" | "UNSUPPORTED_MARKET";
  reasonCodes: string[];
};

function baseResult(market: MarketDefinition): SettlementResult {
  return {
    marketId: market.marketId,
    selectionPayouts: Object.fromEntries(market.selections.map((selection) => [selection.selectionId, 0])),
    status: "SETTLED",
    reasonCodes: [],
  };
}

export function settleScoreMarket(market: MarketDefinition, scenario: ScoreScenario): SettlementResult {
  const result = baseResult(market);
  const line = market.parameters.line ?? 0;
  const home = scenario.homeGoals;
  const away = scenario.awayGoals;
  const total = home + away;

  const winners = new Set<string>();
  switch (market.marketType) {
    case "BINARY_YES_NO":
      winners.add(home + away > 0 ? "YES" : "NO");
      break;
    case "THREE_WAY_MATCH_RESULT":
      winners.add(home > away ? "HOME" : home < away ? "AWAY" : "DRAW");
      break;
    case "TWO_WAY_MATCH_WINNER":
      if (home !== away) winners.add(home > away ? "HOME" : "AWAY");
      break;
    case "HANDICAP": {
      const adjustedHome = home + line;
      if (adjustedHome > away) winners.add("HOME");
      if (adjustedHome < away) winners.add("AWAY");
      if (adjustedHome === away) winners.add("PUSH");
      break;
    }
    case "TOTALS":
      winners.add(total > line ? "OVER" : total < line ? "UNDER" : "PUSH");
      break;
    case "TEAM_TOTALS": {
      const teamGoals = market.parameters.teamId === "away" ? away : home;
      winners.add(teamGoals > line ? "OVER" : teamGoals < line ? "UNDER" : "PUSH");
      break;
    }
    case "BOTH_TEAMS_TO_SCORE":
      winners.add(home > 0 && away > 0 ? "YES" : "NO");
      break;
    default:
      return { ...result, status: "UNSUPPORTED_MARKET", reasonCodes: ["UNSUPPORTED_MARKET_TYPE"] };
  }

  for (const selection of market.selections) {
    if (winners.has(selection.outcomeType)) result.selectionPayouts[selection.selectionId] = 1;
    if (winners.has("PUSH")) result.selectionPayouts[selection.selectionId] = 0.5;
  }
  return result;
}

export function settleTournamentWinner(market: MarketDefinition, winningTeamId: string): SettlementResult {
  const result = baseResult(market);
  if (market.marketType !== "TOURNAMENT_WINNER") {
    return { ...result, status: "UNSUPPORTED_MARKET", reasonCodes: ["UNSUPPORTED_MARKET_TYPE"] };
  }
  for (const selection of market.selections) {
    result.selectionPayouts[selection.selectionId] = selection.externalIds?.teamId === winningTeamId ? 1 : 0;
  }
  return result;
}

export function defaultScoreScenarios(fixtureId: string, source: Source = "SYNTHETIC"): ScoreScenario[] {
  const scores = [
    [0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [0, 2], [2, 1], [1, 2],
    [2, 2], [3, 0], [0, 3], [3, 1], [1, 3], [3, 2], [2, 3],
  ];
  return scores.map(([homeGoals, awayGoals]) => ({
    scenarioId: `${fixtureId}-${homeGoals}-${awayGoals}`,
    fixtureId,
    homeGoals,
    awayGoals,
    probability: null,
    provenance: { source },
  }));
}

export function validateMutuallyExclusiveProbabilities(probabilities: Record<string, number>, tolerance = 1e-9): boolean {
  const sum = Object.values(probabilities).reduce((acc, value) => acc + value, 0);
  return Math.abs(sum - 1) <= tolerance && Object.values(probabilities).every((value) => value >= 0 && value <= 1);
}
