import type { TheoEstimate } from "../../contracts/src/index.js";

export type BenchmarkTheoInput = {
  marketId: string;
  selectionId: string;
  observedProbability: number;
  previousTheo: number | null;
  eventType?: string;
  dataMode: "synthetic" | "replay" | "txline";
  demoMode: boolean;
};

export class BenchmarkStateSpaceTheoProvider {
  readonly modelVersion = "benchmark-state-space-demo/0.1.0";

  getTheo(input: BenchmarkTheoInput): TheoEstimate {
    if (!input.demoMode || input.dataMode === "txline") {
      return {
        marketId: input.marketId,
        probabilities: null,
        uncertainty: null,
        modelVersion: null,
        generatedAt: new Date().toISOString(),
        source: null,
        status: "AWAITING_TXODDS_API",
        reasonCodes: ["APPROVED_RESEARCH_MODEL_NOT_CONNECTED"],
      };
    }

    const smoothing = input.eventType === "INFO_SHOCK" || input.eventType === "GOAL" ? 0.55 : 0.22;
    const previous = input.previousTheo ?? input.observedProbability;
    const theo = clamp(previous + smoothing * (input.observedProbability - previous), 0.02, 0.98);
    const innovation = Math.abs(input.observedProbability - previous);
    const uncertainty = clamp(0.035 + innovation * 0.8, 0.025, 0.22);

    return {
      marketId: input.marketId,
      probabilities: { [input.selectionId]: theo },
      uncertainty,
      modelVersion: this.modelVersion,
      generatedAt: new Date().toISOString(),
      source: "BENCHMARK_THEO",
      status: "AVAILABLE",
      reasonCodes: ["DEMO_ONLY_BENCHMARK_THEO"],
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
