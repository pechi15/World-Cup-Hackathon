import type { TheoEstimate } from "../../contracts/src/index.js";
import {
  toNormalizedMarketObservation,
  type NormalizedEvent,
  type NormalizedMarketObservation,
} from "../../market-data/src/event-store.js";
import type { TheoProvider, TheoRequest } from "./types.js";
import { MarketBaselineTheoProvider } from "./market-baseline.js";
import {
  StateSpaceTheoProvider,
  type StateSpaceConfig,
  type StateSpaceEstimate,
} from "./state-space.js";

export type ResearchTheoMode = "REPLAY" | "RESEARCH";

export function resolveResearchTheoMode(value: string | undefined): ResearchTheoMode | null {
  const normalized = value?.trim().toUpperCase();
  return normalized === "REPLAY" || normalized === "RESEARCH" ? normalized : null;
}

/**
 * Research-only pipeline: normalized replay observation → unchanged market
 * baseline and latent-log-odds StateSpace posterior.
 */
export class PipelineTheoProvider implements TheoProvider {
  readonly baseline: MarketBaselineTheoProvider;
  readonly stateSpace: StateSpaceTheoProvider;

  constructor(
    readonly mode: ResearchTheoMode,
    stateSpaceConfig: Partial<StateSpaceConfig> = {},
  ) {
    this.baseline = new MarketBaselineTheoProvider();
    this.stateSpace = new StateSpaceTheoProvider(stateSpaceConfig);
  }

  clear(): void {
    this.baseline.clear();
    this.stateSpace.clear();
  }

  ingestEvent(event: NormalizedEvent): NormalizedMarketObservation {
    if (this.mode === "REPLAY" && event.dataMode !== "REPLAY") {
      throw new Error("REPLAY_MODE_REJECTS_NON_REPLAY_OBSERVATION");
    }
    const observation = toNormalizedMarketObservation(event);
    this.ingestObservation(observation);
    return observation;
  }

  ingestObservation(observation: NormalizedMarketObservation): void {
    if (this.mode === "REPLAY" && observation.provenance.dataMode !== "REPLAY") {
      throw new Error("REPLAY_MODE_REJECTS_NON_REPLAY_OBSERVATION");
    }
    this.baseline.ingestObservation(observation);
    this.stateSpace.ingestObservation(observation);
  }

  signalEventShock(marketId: string): void {
    this.stateSpace.bumpProcessNoise(marketId);
  }

  getInnovation(marketId: string): number {
    return this.stateSpace.getInnovation(marketId);
  }

  async getTheo(input: TheoRequest): Promise<StateSpaceEstimate> {
    return this.stateSpace.getTheo(input);
  }

  async getBaseline(input: TheoRequest): Promise<TheoEstimate> {
    return this.baseline.getTheo(input);
  }
}
