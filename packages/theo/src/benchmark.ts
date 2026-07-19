import type { TheoEstimate } from "../../contracts/src/index.js";

export type MarketFilterDiagnostics = {
  filteredConsensus: number;
  uncertainty: number;
  innovation: number;
  standardizedInnovation: number;
  volatility: number;
  predictedVariance: number;
  observationVariance: number;
};

type FilterState = {
  mean: number;
  variance: number;
  volatility: number;
};

export class MarketConsensusFilter {
  private readonly states = new Map<string, FilterState>();

  constructor(
    private readonly processVariance = 0.0004,
    private readonly observationVariance = 0.0016,
  ) {}

  reset(): void {
    this.states.clear();
  }

  update(key: string, observedProbability: number): MarketFilterDiagnostics {
    const observed = logit(clamp(observedProbability, 0.01, 0.99));
    const prior = this.states.get(key) ?? {
      mean: observed,
      variance: this.observationVariance,
      volatility: 0,
    };
    const predictedMean = prior.mean;
    const predictedVariance = prior.variance + this.processVariance;
    const innovation = observed - predictedMean;
    const innovationVariance = predictedVariance + this.observationVariance;
    const standardizedInnovation = innovation / Math.sqrt(innovationVariance);
    const gain = predictedVariance / innovationVariance;
    const mean = predictedMean + gain * innovation;
    const variance = Math.max(1e-9, (1 - gain) * predictedVariance);
    const volatility = Math.sqrt(0.9 * prior.volatility ** 2 + 0.1 * innovation ** 2);
    this.states.set(key, { mean, variance, volatility });
    return {
      filteredConsensus: logistic(mean),
      uncertainty: Math.sqrt(variance),
      innovation,
      standardizedInnovation,
      volatility,
      predictedVariance,
      observationVariance: this.observationVariance,
    };
  }
}

export type BenchmarkTheoInput = {
  marketId: string;
  selectionId: string;
  observedProbability: number;
  previousTheo: number | null;
  eventType?: string;
  dataMode: "synthetic" | "replay" | "txline";
  demoMode: boolean;
  asOf?: string;
};

export class BenchmarkStateSpaceTheoProvider {
  readonly modelVersion = "market-consensus-filter/1.0.0";
  readonly filter = new MarketConsensusFilter();
  private diagnostics = new Map<string, MarketFilterDiagnostics>();

  reset(): void {
    this.filter.reset();
    this.diagnostics.clear();
  }

  getDiagnostics(marketId: string, selectionId: string): MarketFilterDiagnostics | null {
    return this.diagnostics.get(`${marketId}|${selectionId}`) ?? null;
  }

  getTheo(input: BenchmarkTheoInput): TheoEstimate {
    if (!input.demoMode || input.dataMode === "txline") {
      return {
        marketId: input.marketId,
        probabilities: null,
        uncertainty: null,
        modelVersion: null,
        generatedAt: input.asOf ?? new Date(0).toISOString(),
        source: null,
        status: "AWAITING_TXODDS_API",
        reasonCodes: ["TXODDS_MARKET_BASELINE_UNAVAILABLE", "DIRECTIONAL_TRADING_DISABLED", "KELLY_DISABLED"],
        provenance: "TXODDS_MARKET_BASELINE",
        independentAlpha: false,
      };
    }

    const diagnostics = this.filter.update(`${input.marketId}|${input.selectionId}`, input.observedProbability);
    this.diagnostics.set(`${input.marketId}|${input.selectionId}`, diagnostics);
    return {
      marketId: input.marketId,
      probabilities: { [input.selectionId]: diagnostics.filteredConsensus },
      uncertainty: diagnostics.uncertainty,
      modelVersion: this.modelVersion,
      generatedAt: input.asOf ?? new Date(0).toISOString(),
      source: "REPLAY",
      status: "AVAILABLE_BENCHMARK",
      reasonCodes: ["TXODDS_MARKET_BASELINE", "MARKET_CONSENSUS", "NOT_PROPRIETARY_THEO", "NOT_PROVEN_ALPHA"],
      provenance: "TXODDS_MARKET_BASELINE",
      independentAlpha: false,
      probabilityField: "PRICES_DECIMAL",
    };
  }
}

function logit(value: number): number {
  return Math.log(value / (1 - value));
}

function logistic(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
