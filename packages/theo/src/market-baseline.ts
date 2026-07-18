import type { MarketDefinition, TheoEstimate } from "../../contracts/src/index.js";
import type { NormalizedMarketObservation } from "../../market-data/src/event-store.js";
import type { TheoProvider, TheoRequest } from "./types.js";
import { cleanDemarginedProbabilities, overround, proportionalDevig } from "./devig.js";

export type MarketProbabilityInput = {
  selectionIds: string[];
  /** Raw implied probs from decimal odds (may sum > 1). */
  implied: number[];
};

/**
 * MARKET_BASELINE — de-vigged market probability.
 * Benchmark only. Never present as proprietary alpha.
 */
export class MarketBaselineTheoProvider implements TheoProvider {
  constructor(private readonly probsByMarket = new Map<string, {
    probabilities: Record<string, number>;
    source: "TXODDS" | "REPLAY";
    reasonCodes: string[];
    eventTime: string | null;
    receiveTime: string | null;
  }>()) {}

  setMarketProbabilities(
    marketId: string,
    selectionIds: string[],
    values: number[],
    semantics: "RAW_BOOK_IMPLIED" | "ALREADY_DEMARGINED",
  ): void {
    const fair = semantics === "RAW_BOOK_IMPLIED"
      ? proportionalDevig(values, semantics)
      : cleanDemarginedProbabilities(values);
    const record: Record<string, number> = {};
    selectionIds.forEach((id, i) => {
      record[id] = fair[i] ?? 0;
    });
    this.probsByMarket.set(marketId, {
      probabilities: record,
      source: "REPLAY",
      reasonCodes: [
        semantics === "RAW_BOOK_IMPLIED" ? "DEVIG_APPLIED_ONCE" : "DOUBLE_DEVIG_SKIPPED",
        "BENCHMARK_ONLY",
        "NOT_PROPRIETARY_ALPHA",
      ],
      eventTime: null,
      receiveTime: null,
    });
  }

  fromSelectionMids(market: MarketDefinition, mids: Record<string, number | null>): void {
    const selectionIds = market.selections.map((s) => s.selectionId);
    const probabilities = selectionIds.map((id) => mids[id] ?? 0);
    this.setMarketProbabilities(market.marketId, selectionIds, probabilities, "ALREADY_DEMARGINED");
  }

  ingestObservation(observation: NormalizedMarketObservation): void {
    const probabilities = Object.fromEntries(
      observation.selectionIds.map((selectionId, index) => [selectionId, observation.probabilities[index] ?? 0]),
    );
    this.probsByMarket.set(observation.marketId, {
      probabilities,
      source: observation.provenance.source === "TXODDS" ? "TXODDS" : "REPLAY",
      reasonCodes: [
        ...observation.provenance.reasonCodes,
        "BENCHMARK_ONLY",
        "NOT_PROPRIETARY_ALPHA",
      ],
      eventTime: observation.eventTime,
      receiveTime: observation.receiveTime,
    });
  }

  clear(): void {
    this.probsByMarket.clear();
  }

  async getTheo(input: TheoRequest): Promise<TheoEstimate> {
    const entry = this.probsByMarket.get(input.market.marketId);
    if (!entry) {
      return {
        marketId: input.market.marketId,
        probabilities: null,
        uncertainty: null,
        modelVersion: null,
        generatedAt: input.asOf ?? new Date().toISOString(),
        source: null,
        status: "INSUFFICIENT_DATA",
        reasonCodes: ["MARKET_BASELINE_NO_PRICES", "BENCHMARK_ONLY"],
      };
    }
    const asOfMs = Date.parse(input.asOf ?? new Date().toISOString());
    if (
      (entry.eventTime && Date.parse(entry.eventTime) > asOfMs)
      || (entry.receiveTime && Date.parse(entry.receiveTime) > asOfMs)
    ) {
      return {
        marketId: input.market.marketId,
        probabilities: null,
        uncertainty: null,
        modelVersion: "MARKET_BASELINE/0.1.0",
        generatedAt: input.asOf ?? new Date().toISOString(),
        source: null,
        status: "MODEL_ERROR",
        reasonCodes: ["BENCHMARK_ONLY", "LOOKAHEAD_OBSERVATION_REJECTED"],
      };
    }
    const impliedSum = Object.values(entry.probabilities).reduce((a, b) => a + b, 0);
    return {
      marketId: input.market.marketId,
      probabilities: entry.probabilities,
      uncertainty: Math.max(0.01, Math.abs(overround(Object.values(entry.probabilities))) + 0.02),
      modelVersion: "MARKET_BASELINE/0.1.0",
      generatedAt: input.asOf ?? new Date().toISOString(),
      source: entry.source,
      status: "AVAILABLE",
      reasonCodes: [...entry.reasonCodes, `impliedMass≈${impliedSum.toFixed(4)}`],
    };
  }
}
