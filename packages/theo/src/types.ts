import type { MarketDefinition, TheoEstimate } from "../../contracts/src/index.js";

export type TheoRequest = {
  market: MarketDefinition;
  asOf?: string;
};

export interface TheoProvider {
  getTheo(input: TheoRequest): Promise<TheoEstimate>;
}
