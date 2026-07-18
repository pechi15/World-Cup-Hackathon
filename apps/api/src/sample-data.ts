import type { Competition, Fixture, MarketDefinition, MarketPrice, RiskLimit, Team } from "../../../packages/contracts/src/index.js";

const now = new Date().toISOString();
const provenance = { source: "TEST_FIXTURE" as const, notes: "Synthetic fixture for backend and risk-engine development; not live data." };

export const competition: Competition = {
  competitionId: "world-cup-2026-test",
  name: "World Cup Test Competition",
  season: "2026",
  provenance,
};

export const teams: Team[] = [
  { teamId: "home", name: "Home XI", countryCode: "HOM", provenance },
  { teamId: "away", name: "Away XI", countryCode: "AWY", provenance },
];

export const fixtures: Fixture[] = [
  {
    fixtureId: "fixture-test-001",
    competitionId: competition.competitionId,
    homeTeamId: "home",
    awayTeamId: "away",
    startTime: new Date(Date.now() + 86400000).toISOString(),
    status: "SCHEDULED",
    provenance,
  },
];

function selection(marketId: string, selectionId: string, label: string, outcomeType: MarketDefinition["selections"][number]["outcomeType"]) {
  return { marketId, selectionId, label, outcomeType, provenance };
}

function rule(marketType: MarketDefinition["marketType"], parameters: MarketDefinition["parameters"], description: string) {
  return { ruleId: `${marketType}-rule`, marketType, parameters, description, provenance };
}

export const markets: MarketDefinition[] = [
  {
    marketId: "m-three-way-001",
    fixtureId: "fixture-test-001",
    competitionId: competition.competitionId,
    marketType: "THREE_WAY_MATCH_RESULT",
    title: "Home XI vs Away XI - Match Result",
    description: "Three-way full-time result market.",
    parameters: { period: "FULL_MATCH" },
    period: "FULL_MATCH",
    selections: [
      selection("m-three-way-001", "home", "Home XI", "HOME"),
      selection("m-three-way-001", "draw", "Draw", "DRAW"),
      selection("m-three-way-001", "away", "Away XI", "AWAY"),
    ],
    settlementRules: [rule("THREE_WAY_MATCH_RESULT", { period: "FULL_MATCH" }, "Pays 1 to home, draw, or away based on terminal score.")],
    status: "OPEN",
    provenance,
    createdAt: now,
    updatedAt: now,
  },
  {
    marketId: "m-total-001",
    fixtureId: "fixture-test-001",
    competitionId: competition.competitionId,
    marketType: "TOTALS",
    title: "Home XI vs Away XI - Total Goals 2.5",
    description: "Binary total goals market.",
    parameters: { line: 2.5, period: "FULL_MATCH" },
    period: "FULL_MATCH",
    selections: [
      selection("m-total-001", "over-2-5", "Over 2.5", "OVER"),
      selection("m-total-001", "under-2-5", "Under 2.5", "UNDER"),
    ],
    settlementRules: [rule("TOTALS", { line: 2.5, period: "FULL_MATCH" }, "Pays 1 to over if total goals exceed line; otherwise under.")],
    status: "OPEN",
    provenance,
    createdAt: now,
    updatedAt: now,
  },
  {
    marketId: "m-handicap-001",
    fixtureId: "fixture-test-001",
    competitionId: competition.competitionId,
    marketType: "HANDICAP",
    title: "Home XI +0.5",
    description: "Binary handicap market.",
    parameters: { line: 0.5, period: "FULL_MATCH" },
    period: "FULL_MATCH",
    selections: [
      selection("m-handicap-001", "home-plus-0-5", "Home XI +0.5", "HOME"),
      selection("m-handicap-001", "away-minus-0-5", "Away XI -0.5", "AWAY"),
    ],
    settlementRules: [rule("HANDICAP", { line: 0.5, period: "FULL_MATCH" }, "Applies handicap to home score, then settles home or away.")],
    status: "OPEN",
    provenance,
    createdAt: now,
    updatedAt: now,
  },
  {
    marketId: "m-tournament-winner-001",
    competitionId: competition.competitionId,
    marketType: "TOURNAMENT_WINNER",
    title: "World Cup Winner",
    description: "Tournament winner market with many possible teams.",
    parameters: { period: "TOURNAMENT" },
    period: "TOURNAMENT",
    selections: [
      { ...selection("m-tournament-winner-001", "team-home", "Home XI", "TEAM"), externalIds: { teamId: "home" } },
      { ...selection("m-tournament-winner-001", "team-away", "Away XI", "TEAM"), externalIds: { teamId: "away" } },
    ],
    settlementRules: [rule("TOURNAMENT_WINNER", { period: "TOURNAMENT" }, "Pays 1 to the tournament-winning team.")],
    status: "OPEN",
    provenance,
    createdAt: now,
    updatedAt: now,
  },
  {
    marketId: "m-combination-schema-001",
    fixtureId: "fixture-test-001",
    competitionId: competition.competitionId,
    marketType: "COMBINATION",
    title: "Combination Schema Placeholder",
    description: "Schema support only. Pricing and risk aggregation require explicit correlated settlement rules.",
    parameters: { combinationLegs: ["m-three-way-001:home", "m-total-001:over-2-5"], period: "FULL_MATCH" },
    period: "FULL_MATCH",
    selections: [
      selection("m-combination-schema-001", "combo-yes", "Home XI and Over 2.5", "YES"),
      selection("m-combination-schema-001", "combo-no", "Not both", "NO"),
    ],
    settlementRules: [rule("COMBINATION", { combinationLegs: ["m-three-way-001:home", "m-total-001:over-2-5"], period: "FULL_MATCH" }, "Not active for automated pricing or risk aggregation in MVP.")],
    status: "SUSPENDED",
    provenance,
    createdAt: now,
    updatedAt: now,
  },
];

export const marketPrices: MarketPrice[] = markets.flatMap((market) =>
  market.selections.map((marketSelection, index) => ({
    marketId: market.marketId,
    selectionId: marketSelection.selectionId,
    bid: market.marketType === "COMBINATION" ? null : Math.max(0.01, 0.45 - index * 0.1),
    ask: market.marketType === "COMBINATION" ? null : Math.min(0.99, 0.55 - index * 0.1),
    mid: market.marketType === "COMBINATION" ? null : Math.min(0.99, Math.max(0.01, 0.5 - index * 0.1)),
    last: null,
    timestamp: now,
    sequenceId: null,
    provenance,
  })),
);

export const defaultRiskLimits: RiskLimit = {
  maxPositionPerSelection: 1000,
  maxExposurePerMarket: 2500,
  maxExposurePerFixture: 5000,
  maxExposurePerTeam: 5000,
  maxWorstCaseLoss: 10000,
  maxDailyDrawdown: 5000,
  maxOrderSize: 500,
  maxQuoteWidth: 0.25,
  minDataFreshnessMs: 60000,
  killSwitch: false,
  quoteSuspension: false,
  directionalTradingSuspension: false,
};
