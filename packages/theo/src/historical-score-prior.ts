import type { MarketDefinition, TheoEstimate } from "../../contracts/src/index.js";
import type { TheoProvider, TheoRequest } from "./types.js";
import {
  fitDixonColes,
  predictScoreDistribution,
  type DixonColesConfig,
  type DixonColesFitResult,
  type DixonColesModel,
  type ScoreDistribution,
} from "./dixon-coles.js";
import {
  deriveBinaryHandicap,
  deriveBothTeamsToScore,
  deriveTeamTotal,
  deriveThreeWay,
  deriveTotalGoals,
} from "./score-markets.js";

export type HistoricalPriorMode = "RESEARCH" | "REPLAY";

export type HistoricalPredictionFixture = {
  fixtureId: string;
  homeTeamId: string;
  awayTeamId: string;
  kickoffTime: string;
  neutralVenue: boolean;
};

export type HistoricalScorePriorEstimate = TheoEstimate & {
  historicalProvenance: "HISTORICAL_DIXON_COLES";
  researchStatus: "RESEARCH_ONLY";
  fitStatus: DixonColesFitResult["status"] | "NOT_FIT";
  trainingCutoff: string | null;
  scoreDistribution: ScoreDistribution | null;
  convergenceStatus: DixonColesModel["diagnostics"]["convergenceStatus"] | null;
};

export class HistoricalScorePriorProvider implements TheoProvider {
  private fitResult: DixonColesFitResult | null = null;
  private readonly predictionFixtures = new Map<string, HistoricalPredictionFixture>();

  constructor(
    readonly mode: HistoricalPriorMode,
    private readonly config: Partial<DixonColesConfig> = {},
  ) {}

  fit(rows: unknown[], trainingCutoff: string): DixonColesFitResult {
    this.fitResult = fitDixonColes(rows, trainingCutoff, this.config);
    return this.fitResult;
  }

  registerPredictionFixture(fixture: HistoricalPredictionFixture): void {
    if (!fixture.fixtureId || fixture.homeTeamId === fixture.awayTeamId) {
      throw new Error("INVALID_HISTORICAL_PREDICTION_FIXTURE");
    }
    if (!Number.isFinite(Date.parse(fixture.kickoffTime))) {
      throw new Error("INVALID_HISTORICAL_PREDICTION_KICKOFF");
    }
    this.predictionFixtures.set(fixture.fixtureId, { ...fixture });
  }

  clear(): void {
    this.fitResult = null;
    this.predictionFixtures.clear();
  }

  getModel(): DixonColesModel | null {
    return this.fitResult?.status === "FITTED" ? this.fitResult.model : null;
  }

  async getTheo(input: TheoRequest): Promise<HistoricalScorePriorEstimate> {
    const fitStatus = this.fitResult?.status ?? "NOT_FIT";
    const model = this.getModel();
    const generatedAt = input.asOf ?? model?.trainingCutoff ?? new Date().toISOString();
    if (!model) {
      return this.unavailable(input.market.marketId, generatedAt, fitStatus, [
        fitStatus === "INSUFFICIENT_REAL_DATA" ? "INSUFFICIENT_REAL_DATA" : "HISTORICAL_MODEL_NOT_FIT",
        ...(this.fitResult?.reasonCodes ?? []),
      ]);
    }
    const fixtureId = input.market.fixtureId;
    const fixture = fixtureId ? this.predictionFixtures.get(fixtureId) : undefined;
    if (!fixture) {
      return this.unavailable(input.market.marketId, generatedAt, fitStatus, ["HISTORICAL_PREDICTION_FIXTURE_NOT_REGISTERED"]);
    }
    const asOfMs = Date.parse(generatedAt);
    if (!Number.isFinite(asOfMs)) {
      return this.unavailable(input.market.marketId, generatedAt, fitStatus, ["INVALID_AS_OF"]);
    }
    if (asOfMs < Date.parse(model.trainingCutoff)) {
      return this.unavailable(input.market.marketId, generatedAt, fitStatus, ["TRAINING_CUTOFF_AFTER_FORECAST_TIME", "LOOKAHEAD_REJECTED"]);
    }
    if (asOfMs > Date.parse(fixture.kickoffTime)) {
      return this.unavailable(input.market.marketId, generatedAt, fitStatus, ["POST_KICKOFF_FORECAST_REJECTED", "NO_POST_MATCH_FEATURES"]);
    }
    if (input.market.period !== "FULL_MATCH" || input.market.parameters.period !== "FULL_MATCH") {
      return {
        ...this.unavailable(input.market.marketId, generatedAt, fitStatus, ["ONLY_FULL_MATCH_HISTORICAL_PRIOR_SUPPORTED"]),
        status: "UNSUPPORTED_MARKET",
      };
    }
    let distribution: ScoreDistribution;
    try {
      distribution = predictScoreDistribution(
        model,
        fixture.homeTeamId,
        fixture.awayTeamId,
        fixture.neutralVenue,
      );
    } catch (error) {
      return this.unavailable(input.market.marketId, generatedAt, fitStatus, [
        error instanceof Error ? error.message : "HISTORICAL_PREDICTION_FAILED",
      ]);
    }
    const probabilities = this.marketProbabilities(input.market, fixture, distribution);
    if (!probabilities) {
      return {
        ...this.unavailable(input.market.marketId, generatedAt, fitStatus, ["UNSUPPORTED_HISTORICAL_MARKET"]),
        status: "UNSUPPORTED_MARKET",
      };
    }
    const mass = Object.values(probabilities).reduce((sum, probability) => sum + probability, 0);
    if (Math.abs(mass - 1) > 1e-9) {
      return this.unavailable(input.market.marketId, generatedAt, fitStatus, ["INCOHERENT_DERIVED_MARKET_PROBABILITIES"]);
    }
    return {
      marketId: input.market.marketId,
      probabilities,
      uncertainty: distribution.uncertainty.meanParameterStandardError,
      modelVersion: model.modelVersion,
      generatedAt,
      source: "MANUAL_RESEARCH",
      status: "AVAILABLE",
      reasonCodes: [
        "RESEARCH_ONLY",
        "NOT_PROVEN_ALPHA",
        "INDEPENDENT_HISTORICAL_PRIOR",
        "NO_AUTOMATIC_PRODUCTION_REPLACEMENT",
        ...distribution.reasonCodes,
      ],
      historicalProvenance: "HISTORICAL_DIXON_COLES",
      researchStatus: "RESEARCH_ONLY",
      fitStatus,
      trainingCutoff: model.trainingCutoff,
      scoreDistribution: distribution,
      convergenceStatus: model.diagnostics.convergenceStatus,
    };
  }

  private marketProbabilities(
    market: MarketDefinition,
    fixture: HistoricalPredictionFixture,
    distribution: ScoreDistribution,
  ): Record<string, number> | null {
    if (market.marketType === "THREE_WAY_MATCH_RESULT") {
      const threeWay = deriveThreeWay(distribution);
      return this.mapSelections(market, {
        HOME: threeWay.homeWin,
        DRAW: threeWay.draw,
        AWAY: threeWay.awayWin,
      });
    }
    if (market.marketType === "TOTALS") {
      const line = market.parameters.line;
      if (line === undefined || line < 0 || !isHalfGoalLine(line)) return null;
      const totals = deriveTotalGoals(distribution, line);
      return this.mapSelections(market, { OVER: totals.over, UNDER: totals.under });
    }
    if (market.marketType === "BOTH_TEAMS_TO_SCORE") {
      const btts = deriveBothTeamsToScore(distribution);
      return this.mapSelections(market, { YES: btts.yes, NO: btts.no });
    }
    if (market.marketType === "TEAM_TOTALS") {
      const line = market.parameters.line;
      const teamId = market.parameters.teamId;
      if (line === undefined || line < 0 || !isHalfGoalLine(line) || !teamId) return null;
      const side = teamId === fixture.homeTeamId ? "HOME" : teamId === fixture.awayTeamId ? "AWAY" : null;
      if (!side) return null;
      const totals = deriveTeamTotal(distribution, side, line);
      return this.mapSelections(market, { OVER: totals.over, UNDER: totals.under });
    }
    if (market.marketType === "HANDICAP") {
      const line = market.parameters.line;
      if (line === undefined) return null;
      try {
        const handicap = deriveBinaryHandicap(distribution, line);
        return this.mapSelections(market, { HOME: handicap.homeCovers, AWAY: handicap.awayCovers });
      } catch {
        return null;
      }
    }
    return null;
  }

  private mapSelections(
    market: MarketDefinition,
    byOutcome: Partial<Record<MarketDefinition["selections"][number]["outcomeType"], number>>,
  ): Record<string, number> | null {
    const entries = market.selections.map((selection) => {
      const probability = byOutcome[selection.outcomeType];
      return probability === undefined ? null : [selection.selectionId, probability] as const;
    });
    if (entries.some((entry) => entry === null)) return null;
    return Object.fromEntries(entries as Array<readonly [string, number]>);
  }

  private unavailable(
    marketId: string,
    generatedAt: string,
    fitStatus: HistoricalScorePriorEstimate["fitStatus"],
    reasonCodes: string[],
  ): HistoricalScorePriorEstimate {
    return {
      marketId,
      probabilities: null,
      uncertainty: null,
      modelVersion: fitStatus === "NOT_FIT" ? null : "DIXON_COLES/1.0.0",
      generatedAt,
      source: null,
      status: fitStatus === "INSUFFICIENT_REAL_DATA" ? "INSUFFICIENT_DATA" : "MODEL_ERROR",
      reasonCodes: [...new Set(["RESEARCH_ONLY", "NOT_PROVEN_ALPHA", ...reasonCodes])],
      historicalProvenance: "HISTORICAL_DIXON_COLES",
      researchStatus: "RESEARCH_ONLY",
      fitStatus,
      trainingCutoff: this.getModel()?.trainingCutoff ?? null,
      scoreDistribution: null,
      convergenceStatus: this.getModel()?.diagnostics.convergenceStatus ?? null,
    };
  }
}

function isHalfGoalLine(line: number): boolean {
  return Number.isFinite(line)
    && !Number.isInteger(line)
    && Math.abs(line * 2 - Math.round(line * 2)) <= 1e-10;
}
