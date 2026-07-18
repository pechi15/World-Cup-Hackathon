import type { MarketDefinition, Quote, RiskLimit, TheoEstimate, TradingSignal } from "../../contracts/src/index.js";
import type { Position } from "../../contracts/src/index.js";

export type QuoteConfig = {
  baseWidth: number;
  uncertaintyCoefficient: number;
  volatilityCoefficient: number;
  movementCoefficient: number;
  stalenessCoefficient: number;
  feedLatencyCoefficient: number;
  executionLatencyCoefficient: number;
  adverseSelectionCoefficient: number;
  concentrationCoefficient: number;
  inventoryCoefficient: number;
  minimumWidth: number;
  maximumWidth: number;
  baseSize: number;
};

export type QuoteInput = {
  market: MarketDefinition;
  selectionId: string;
  theo: TheoEstimate;
  inventory?: Position;
  recentVolatility: number;
  sharpMovementSignal: number;
  dataAgeMs: number;
  feedLatencyMs?: number;
  executionLatencyMs?: number;
  adverseSelectionEstimate?: number;
  marketConcentration: number;
  remainingMarketRiskBudget: number;
  remainingFixtureRiskBudget: number;
  remainingPortfolioRiskBudget: number;
  worstCaseMarginalLiability: number;
  directionalSignal?: TradingSignal | null;
  quoteMode?: "STANDARD" | "MARKET_BASELINE_MAKER_ONLY";
  riskLimits: RiskLimit;
  config: QuoteConfig;
};

export const defaultQuoteConfig: QuoteConfig = {
  baseWidth: 0.02,
  uncertaintyCoefficient: 0.5,
  volatilityCoefficient: 0.4,
  movementCoefficient: 0.25,
  stalenessCoefficient: 0.000001,
  feedLatencyCoefficient: 0.000001,
  executionLatencyCoefficient: 0.000001,
  adverseSelectionCoefficient: 0.25,
  concentrationCoefficient: 0.05,
  inventoryCoefficient: 0.02,
  minimumWidth: 0.01,
  maximumWidth: 0.2,
  baseSize: 100,
};

export function calculateHalfWidth(input: QuoteInput): number {
  const uncertainty = input.theo.uncertainty ?? 0;
  const raw =
    input.config.baseWidth +
    input.config.uncertaintyCoefficient * uncertainty +
    input.config.volatilityCoefficient * input.recentVolatility +
    input.config.movementCoefficient * Math.abs(input.sharpMovementSignal) +
    input.config.stalenessCoefficient * input.dataAgeMs +
    input.config.feedLatencyCoefficient * (input.feedLatencyMs ?? 0) +
    input.config.executionLatencyCoefficient * (input.executionLatencyMs ?? 0) +
    input.config.adverseSelectionCoefficient * Math.abs(input.adverseSelectionEstimate ?? 0) +
    input.config.concentrationCoefficient * input.marketConcentration +
    input.config.inventoryCoefficient * Math.abs(input.inventory?.quantity ?? 0) / Math.max(input.config.baseSize, 1);
  return Math.min(input.config.maximumWidth, Math.max(input.config.minimumWidth, raw));
}

export function calculateInventoryLean(position: Position | undefined, config: QuoteConfig): number {
  if (!position) return 0;
  return -Math.max(-0.15, Math.min(0.15, (position.quantity / Math.max(config.baseSize, 1)) * config.inventoryCoefficient));
}

export function calculateDirectionalLean(signal: TradingSignal | null | undefined): number {
  if (!signal || signal.status !== "AVAILABLE") return 0;
  return signal.directionalLean * signal.confidence;
}

export function calculateQuoteHeight(input: QuoteInput, width: number): { bidSize: number; askSize: number } {
  const remainingBudget = Math.max(0, Math.min(input.remainingMarketRiskBudget, input.remainingFixtureRiskBudget, input.remainingPortfolioRiskBudget));
  const liabilityUnit = Math.max(input.worstCaseMarginalLiability, 0.01);
  const uncertaintyPenalty = 1 - Math.min(input.theo.uncertainty ?? 0, 0.9);
  const concentrationPenalty = 1 - Math.min(input.marketConcentration, 0.9);
  const widthPenalty = 1 - Math.min(width, input.riskLimits.maxQuoteWidth) / Math.max(input.riskLimits.maxQuoteWidth, 0.01) * 0.25;
  const latencyPenalty = 1 / (1 + Math.max(0, (input.feedLatencyMs ?? 0) + (input.executionLatencyMs ?? 0)) / 1000);
  const inventoryPenalty = 1 / (1 + Math.abs(input.inventory?.quantity ?? 0) / Math.max(input.config.baseSize, 1));
  const size = Math.max(0, Math.min(input.config.baseSize, (remainingBudget / liabilityUnit) * uncertaintyPenalty * concentrationPenalty * widthPenalty * latencyPenalty * inventoryPenalty));
  return { bidSize: size, askSize: size };
}

export function generateQuote(input: QuoteInput): Quote {
  if (input.riskLimits.killSwitch || input.riskLimits.quoteSuspension) {
    return disabledQuote(input, ["KILL_SWITCH_OR_QUOTE_SUSPENSION"]);
  }
  if ((input.theo.status !== "AVAILABLE" && input.theo.status !== "AVAILABLE_BENCHMARK") || input.theo.probabilities === null || input.theo.uncertainty === null) {
    return disabledQuote(input, ["THEO_UNAVAILABLE", "TXODDS_API_NOT_CONNECTED"]);
  }
  const probability = input.theo.probabilities[input.selectionId];
  if (probability === undefined) return disabledQuote(input, ["UNKNOWN_SELECTION_THEO"]);

  const width = calculateHalfWidth(input);
  if (width > input.riskLimits.maxQuoteWidth) return disabledQuote(input, ["WIDTH_LIMIT_EXCEEDED"]);
  const inventoryLean = calculateInventoryLean(input.inventory, input.config);
  const marketBaselineMode = input.quoteMode === "MARKET_BASELINE_MAKER_ONLY" || input.theo.independentAlpha === false;
  const directionalLean = marketBaselineMode ? 0 : calculateDirectionalLean(input.directionalSignal);
  const totalLean = inventoryLean + directionalLean;
  const center = Math.min(0.99, Math.max(0.01, probability + totalLean));
  const bid = Math.max(0.01, center - width);
  const ask = Math.min(0.99, center + width);
  const height = calculateQuoteHeight(input, width);
  return {
    quoteId: `quote-${input.market.marketId}-${input.selectionId}-${Date.now()}`,
    marketId: input.market.marketId,
    selectionId: input.selectionId,
    bid,
    ask,
    width,
    inventoryLean,
    directionalLean,
    totalLean,
    bidSize: height.bidSize,
    askSize: height.askSize,
    status: "LIVE",
    reasonCodes: marketBaselineMode
      ? ["MARKET_CONSENSUS_BENCHMARK", "NOT_PROPRIETARY_THEO", "NOT_PROVEN_ALPHA", "DIRECTIONAL_TRADING_DISABLED", "KELLY_DISABLED"]
      : [],
    generatedAt: new Date().toISOString(),
    provenance: marketBaselineMode
      ? { source: input.theo.source === "TXODDS" ? "TXODDS" : "REPLAY", notes: "Paper maker quote centred on non-independent market consensus; not proprietary alpha." }
      : { source: "SYNTHETIC", notes: "Deterministic quote from injected theo; not live production data." },
  };
}

function disabledQuote(input: QuoteInput, reasonCodes: string[]): Quote {
  return {
    quoteId: `quote-disabled-${input.market.marketId}-${input.selectionId}-${Date.now()}`,
    marketId: input.market.marketId,
    selectionId: input.selectionId,
    bid: null,
    ask: null,
    width: null,
    inventoryLean: 0,
    directionalLean: 0,
    totalLean: 0,
    bidSize: null,
    askSize: null,
    status: "QUOTING_DISABLED",
    reasonCodes,
    generatedAt: new Date().toISOString(),
    provenance: { source: "SYNTHETIC", notes: "Quote disabled; no fake production bid/ask emitted." },
  };
}
