import type { MarketDefinition, TheoEstimate } from "../../contracts/src/index.js";

export type TheoRequest = {
  market: MarketDefinition;
  asOf?: string;
};

export interface TheoProvider {
  getTheo(input: TheoRequest): Promise<TheoEstimate>;
}

export class NullTheoProvider implements TheoProvider {
  async getTheo(input: TheoRequest): Promise<TheoEstimate> {
    return {
      marketId: input.market.marketId,
      probabilities: null,
      uncertainty: null,
      status: "AWAITING_TXODDS_API",
      modelVersion: null,
      generatedAt: new Date().toISOString(),
      source: null,
      reasonCodes: ["TXODDS_API_NOT_CONNECTED"],
    };
  }
}

export interface TxoddsTheoProvider extends TheoProvider {}
export interface HistoricalTheoProvider extends TheoProvider {}
export interface LearnedResidualTheoProvider extends TheoProvider {}
export interface EnsembleTheoProvider extends TheoProvider {}

export * from "./devig.js";
export * from "./market-baseline.js";
