import type { MarketDefinition, StrategyDecision, TheoEstimate } from "../../contracts/src/index.js";

export * from "./fractional-kelly.js";

export type StrategyInput = {
  market: MarketDefinition;
  selectionId: string;
  theo: TheoEstimate;
  marketProbability: number | null;
};

export interface DirectionalStrategy {
  evaluate(input: StrategyInput): Promise<StrategyDecision>;
}

export class NoTheoNoActionStrategy implements DirectionalStrategy {
  async evaluate(input: StrategyInput): Promise<StrategyDecision> {
    if (input.theo.status === "AVAILABLE_BENCHMARK" || input.theo.independentAlpha === false) {
      return {
        action: "NO_ACTION",
        marketId: input.market.marketId,
        selectionId: input.selectionId,
        proposedSize: null,
        theo: input.theo,
        marketProbability: input.marketProbability,
        estimatedEdge: null,
        confidence: null,
        reasonCodes: ["NON_INDEPENDENT_MARKET_BASELINE", "DIRECTIONAL_TRADING_DISABLED", "KELLY_DISABLED"],
        strategyVersion: "no-theo-no-action/0.1.0",
        status: "DISABLED",
      };
    }
    if (input.theo.status !== "AVAILABLE" || input.theo.probabilities === null) {
      return {
        action: "NO_ACTION",
        marketId: input.market.marketId,
        selectionId: input.selectionId,
        proposedSize: null,
        theo: input.theo,
        marketProbability: input.marketProbability,
        estimatedEdge: null,
        confidence: null,
        reasonCodes: ["THEO_UNAVAILABLE"],
        strategyVersion: "no-theo-no-action/0.1.0",
        status: "THEO_UNAVAILABLE",
      };
    }
    return {
      action: "HOLD",
      marketId: input.market.marketId,
      selectionId: input.selectionId,
      proposedSize: 0,
      theo: input.theo,
      marketProbability: input.marketProbability,
      estimatedEdge: null,
      confidence: 0,
      reasonCodes: ["NO_APPROVED_DIRECTIONAL_MODEL"],
      strategyVersion: "no-theo-no-action/0.1.0",
      status: "READY",
    };
  }
}
