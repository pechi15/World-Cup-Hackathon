import type { MarketDefinition, StrategyDecision, TheoEstimate } from "../../contracts/src/index.js";

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

export type KellyInput = {
  modelProbability: number | null;
  offeredPrice: number;
  bankroll: number;
  kellyFraction: number;
  maxPosition: number;
  maxFixtureExposure: number;
  maxPortfolioExposure: number;
};

export type KellyResult = {
  size: number | null;
  fraction: number | null;
  estimatedEdge: number | null;
  status: "AVAILABLE" | "NO_EDGE" | "THEO_UNAVAILABLE" | "INVALID_INPUT";
  reasonCodes: string[];
};

export function fractionalKelly(input: KellyInput): KellyResult {
  if (input.modelProbability === null) {
    return { size: null, fraction: null, estimatedEdge: null, status: "THEO_UNAVAILABLE", reasonCodes: ["THEO_UNAVAILABLE"] };
  }
  const p = input.modelProbability;
  const price = input.offeredPrice;
  if (p <= 0 || p >= 1 || price <= 0 || price >= 1 || input.bankroll <= 0 || input.kellyFraction < 0) {
    return { size: 0, fraction: null, estimatedEdge: null, status: "INVALID_INPUT", reasonCodes: ["INVALID_KELLY_INPUT"] };
  }
  const edge = p - price;
  if (edge <= 0) {
    return { size: 0, fraction: 0, estimatedEdge: edge, status: "NO_EDGE", reasonCodes: ["NON_POSITIVE_EDGE"] };
  }
  const fullKelly = edge / (1 - price);
  const fraction = Math.max(0, fullKelly * input.kellyFraction);
  const uncapped = input.bankroll * fraction;
  const cap = Math.min(input.maxPosition, input.maxFixtureExposure, input.maxPortfolioExposure);
  return { size: Math.max(0, Math.min(uncapped, cap)), fraction, estimatedEdge: edge, status: "AVAILABLE", reasonCodes: [] };
}
