import type { TheoEstimate } from "../../contracts/src/index.js";
import type { NormalizedMarketObservation } from "../../market-data/src/event-store.js";
import type { TheoProvider, TheoRequest } from "./types.js";
import { softmax } from "./devig.js";

export type StateSpaceConfig = {
  processVariance: number;
  observationVariance: number;
  initialVariance: number;
  processIntervalMs: number;
  staleAfterMs: number;
  staleObservationVarianceMultiplier: number;
  informationShockProcessVariance: number;
  maximumUncertainty: number;
};

const defaultConfig: StateSpaceConfig = {
  processVariance: 0.002,
  observationVariance: 0.03,
  initialVariance: 0.03,
  processIntervalMs: 15_000,
  staleAfterMs: 60_000,
  staleObservationVarianceMultiplier: 4,
  informationShockProcessVariance: 0.05,
  maximumUncertainty: 2,
};

export type StateSpaceEstimate = TheoEstimate & {
  /** Alias making clear that `probabilities` are the filtered posterior. */
  posteriorProbabilities: Record<string, number> | null;
  /** Innovations are in additive log-ratio coordinates; the reference outcome is zero. */
  innovation: Record<string, number> | null;
  standardizedInnovation: Record<string, number> | null;
  standardizedInnovationMagnitude: number | null;
  posteriorLogOddsVariance: Record<string, number> | null;
};

type FilterState = {
  latentLogOdds: number[];
  variance: number[];
  stateTimeMs: number;
  lastObservedAtMs: number;
  lastObservationId: string;
  source: "TXODDS" | "REPLAY";
};

type InnovationDiagnostics = {
  innovation: number[];
  standardized: number[];
  magnitude: number;
};

function toAdditiveLogOdds(probabilities: number[]): number[] {
  const clipped = probabilities.map((probability) => Math.min(1 - 1e-9, Math.max(1e-9, probability)));
  const reference = clipped.at(-1) ?? 1;
  return clipped.slice(0, -1).map((probability) => Math.log(probability / reference));
}

function fromAdditiveLogOdds(latentLogOdds: number[]): number[] {
  return softmax([...latentLogOdds, 0]);
}

/**
 * Diagonal Kalman filter for latent fair additive log-odds.
 *
 * Random-walk transition and observation equations:
 *   x_t = x_{t-1} + w_t,       w_t ~ N(0, Q_t)
 *   y_t = x_t + v_t,           v_t ~ N(0, R_t)
 *   P^-_t = P_{t-1} + Q_t
 *   K_t = P^-_t / (P^-_t + R_t)
 *   x_t = x^-_t + K_t (y_t - x^-_t)
 *   P_t = (1 - K_t) P^-_t
 *
 * Reference: Kalman (1960), DOI 10.1115/1.3662552. The implementation adapts
 * the linear-Gaussian filter to bounded mutually-exclusive outcomes using
 * additive log-ratios and softmax. It is research infrastructure, not proven alpha.
 */
export class StateSpaceTheoProvider implements TheoProvider {
  private readonly state = new Map<string, FilterState>();
  private readonly observations = new Map<string, NormalizedMarketObservation>();
  private readonly pendingInformationShocks = new Set<string>();
  private readonly lastInnovation = new Map<string, number>();
  private readonly lastDiagnostics = new Map<string, InnovationDiagnostics>();
  readonly config: StateSpaceConfig;

  constructor(config: Partial<StateSpaceConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
    if (
      this.config.processVariance < 0
      || this.config.observationVariance <= 0
      || this.config.initialVariance < 0
      || this.config.processIntervalMs <= 0
      || this.config.staleAfterMs < 0
      || this.config.staleObservationVarianceMultiplier < 1
      || this.config.informationShockProcessVariance < 0
      || this.config.maximumUncertainty <= 0
    ) {
      throw new Error("INVALID_STATE_SPACE_CONFIG");
    }
  }

  clear(): void {
    this.state.clear();
    this.observations.clear();
    this.pendingInformationShocks.clear();
    this.lastInnovation.clear();
    this.lastDiagnostics.clear();
  }

  ingestObservation(observation: NormalizedMarketObservation): void {
    this.observations.set(observation.marketId, observation);
  }

  getInnovation(marketId: string): number {
    return this.lastInnovation.get(marketId) ?? 0;
  }

  signalInformationShock(marketId: string): void {
    this.pendingInformationShocks.add(marketId);
  }

  /** Compatibility alias for the replay loop. The bump is applied once at the next prediction. */
  bumpProcessNoise(marketId: string): void {
    this.signalInformationShock(marketId);
  }

  async getTheo(input: TheoRequest): Promise<StateSpaceEstimate> {
    const observation = this.observations.get(input.market.marketId);
    const generatedAt = input.asOf ?? observation?.eventTime ?? new Date().toISOString();
    const asOfMs = Date.parse(generatedAt);
    if (!Number.isFinite(asOfMs)) {
      return this.unavailable(input.market.marketId, generatedAt, "MODEL_ERROR", ["INVALID_AS_OF"]);
    }
    const selectionIds = input.market.selections.map((s) => s.selectionId);
    let entry = this.state.get(input.market.marketId);
    let diagnostics: InnovationDiagnostics | null = null;
    const reasonCodes = ["RESEARCH_ONLY", "NOT_PROVEN_ALPHA", "KALMAN_1960_LOG_ODDS"];

    if (
      observation
      && (Date.parse(observation.eventTime) > asOfMs || Date.parse(observation.receiveTime) > asOfMs)
    ) {
      return this.unavailable(
        input.market.marketId,
        generatedAt,
        "MODEL_ERROR",
        [...reasonCodes, "LOOKAHEAD_OBSERVATION_REJECTED"],
      );
    }

    if (!entry && !observation) {
      return this.unavailable(
        input.market.marketId,
        generatedAt,
        "INSUFFICIENT_DATA",
        [...reasonCodes, "MISSING_OBSERVATION", "STATE_SPACE_AWAITING_OBSERVATION"],
      );
    }

    if (!entry && observation) {
      if (!this.matchesMarket(selectionIds, observation)) {
        return this.unavailable(input.market.marketId, generatedAt, "MODEL_ERROR", [...reasonCodes, "OBSERVATION_SELECTION_MISMATCH"]);
      }
      const observedAtMs = Date.parse(observation.eventTime);
      entry = {
        latentLogOdds: toAdditiveLogOdds(observation.probabilities),
        variance: Array.from({ length: Math.max(selectionIds.length - 1, 0) }, () => this.config.initialVariance),
        stateTimeMs: observedAtMs,
        lastObservedAtMs: observedAtMs,
        lastObservationId: observation.observationId,
        source: observation.provenance.source === "TXODDS" ? "TXODDS" : "REPLAY",
      };
      this.state.set(input.market.marketId, entry);
      this.lastInnovation.set(input.market.marketId, 0);
      diagnostics = {
        innovation: entry.latentLogOdds.map(() => 0),
        standardized: entry.latentLogOdds.map(() => 0),
        magnitude: 0,
      };
      this.lastDiagnostics.set(input.market.marketId, diagnostics);
      reasonCodes.push("FILTER_INITIALIZED");
    } else if (entry && observation && observation.observationId !== entry.lastObservationId) {
      if (!this.matchesMarket(selectionIds, observation)) {
        return this.unavailable(input.market.marketId, generatedAt, "MODEL_ERROR", [...reasonCodes, "OBSERVATION_SELECTION_MISMATCH"]);
      }
      const observedAtMs = Date.parse(observation.eventTime);
      if (observedAtMs < entry.lastObservedAtMs || observedAtMs < entry.stateTimeMs) {
        return this.unavailable(input.market.marketId, generatedAt, "MODEL_ERROR", [...reasonCodes, "OUT_OF_ORDER_OBSERVATION_REJECTED"]);
      }
      entry = this.predict(input.market.marketId, entry, observedAtMs, true);
      const observedLogOdds = toAdditiveLogOdds(observation.probabilities);
      const staleOnArrival = asOfMs - observedAtMs > this.config.staleAfterMs;
      const observationVariance = this.config.observationVariance
        * (staleOnArrival ? this.config.staleObservationVarianceMultiplier : 1);
      const innovation = observedLogOdds.map((value, index) => value - (entry!.latentLogOdds[index] ?? 0));
      const standardized = innovation.map(
        (value, index) => value / Math.sqrt((entry!.variance[index] ?? 0) + observationVariance),
      );
      const nextLogOdds = innovation.map((value, index) => {
        const predictedVariance = entry!.variance[index] ?? 0;
        const gain = predictedVariance / (predictedVariance + observationVariance);
        return (entry!.latentLogOdds[index] ?? 0) + gain * value;
      });
      const nextVariance = entry.variance.map((predictedVariance) => {
        const gain = predictedVariance / (predictedVariance + observationVariance);
        return (1 - gain) * predictedVariance;
      });
      const magnitude = standardized.length === 0
        ? 0
        : standardized.reduce((sum, value) => sum + Math.abs(value), 0) / standardized.length;
      entry = {
        latentLogOdds: nextLogOdds,
        variance: nextVariance,
        stateTimeMs: observedAtMs,
        lastObservedAtMs: observedAtMs,
        lastObservationId: observation.observationId,
        source: observation.provenance.source === "TXODDS" ? "TXODDS" : "REPLAY",
      };
      diagnostics = { innovation, standardized, magnitude };
      this.lastDiagnostics.set(input.market.marketId, diagnostics);
      this.lastInnovation.set(input.market.marketId, magnitude);
      reasonCodes.push(staleOnArrival ? "STALE_OBSERVATION_DOWNWEIGHTED" : "FILTER_UPDATED");
    }

    if (!entry) {
      return this.unavailable(input.market.marketId, generatedAt, "INSUFFICIENT_DATA", [...reasonCodes, "MISSING_OBSERVATION"]);
    }
    diagnostics ??= this.lastDiagnostics.get(input.market.marketId) ?? null;
    this.state.set(input.market.marketId, entry);
    let estimateEntry = entry;
    if (asOfMs > entry.stateTimeMs) {
      estimateEntry = this.predict(input.market.marketId, entry, asOfMs, false);
      reasonCodes.push("MISSING_OBSERVATION_PREDICTION_ONLY");
    }
    const ageMs = Math.max(0, asOfMs - estimateEntry.lastObservedAtMs);
    const stale = ageMs > this.config.staleAfterMs;
    if (stale) reasonCodes.push("STALE_OBSERVATION");
    return this.toEstimate(input.market.marketId, selectionIds, estimateEntry, diagnostics, stale, generatedAt, reasonCodes);
  }

  private predict(
    marketId: string,
    entry: FilterState,
    targetTimeMs: number,
    consumeInformationShock: boolean,
  ): FilterState {
    const elapsedMs = Math.max(0, targetTimeMs - entry.stateTimeMs);
    if (elapsedMs === 0) return entry;
    const intervals = Math.max(1, elapsedMs / this.config.processIntervalMs);
    const shockVariance = this.pendingInformationShocks.has(marketId)
      ? this.config.informationShockProcessVariance
      : 0;
    if (consumeInformationShock) this.pendingInformationShocks.delete(marketId);
    return {
      ...entry,
      variance: entry.variance.map(
        (variance) => variance + this.config.processVariance * intervals + shockVariance,
      ),
      stateTimeMs: targetTimeMs,
    };
  }

  private matchesMarket(selectionIds: string[], observation: NormalizedMarketObservation): boolean {
    const probabilityMass = observation.probabilities.reduce((sum, probability) => sum + probability, 0);
    return selectionIds.length === observation.selectionIds.length
      && selectionIds.every((selectionId, index) => selectionId === observation.selectionIds[index])
      && observation.probabilities.length === selectionIds.length
      && observation.probabilities.every((probability) => Number.isFinite(probability) && probability >= 0 && probability <= 1)
      && Math.abs(probabilityMass - 1) <= 1e-8;
  }

  private toEstimate(
    marketId: string,
    selectionIds: string[],
    entry: FilterState,
    diagnostics: InnovationDiagnostics | null,
    stale: boolean,
    generatedAt: string,
    reasonCodes: string[],
  ): StateSpaceEstimate {
    const probs = fromAdditiveLogOdds(entry.latentLogOdds);
    const probabilities = Object.fromEntries(selectionIds.map((id, i) => [id, probs[i] ?? 0]));
    const uncertainty = entry.variance.length === 0
      ? 0
      : Math.min(
          this.config.maximumUncertainty,
          Math.sqrt(entry.variance.reduce((sum, variance) => sum + variance, 0) / entry.variance.length),
        );
    const vectorRecord = (values: number[] | null): Record<string, number> | null => values === null
      ? null
      : Object.fromEntries(selectionIds.map((selectionId, index) => [selectionId, values[index] ?? 0]));
    return {
      marketId,
      probabilities,
      posteriorProbabilities: probabilities,
      uncertainty,
      innovation: vectorRecord(diagnostics ? [...diagnostics.innovation, 0] : null),
      standardizedInnovation: vectorRecord(diagnostics ? [...diagnostics.standardized, 0] : null),
      standardizedInnovationMagnitude: diagnostics?.magnitude ?? null,
      posteriorLogOddsVariance: vectorRecord([...entry.variance, 0]),
      modelVersion: "STATE_SPACE_LOG_ODDS/1.0.0",
      generatedAt,
      source: entry.source,
      status: stale ? "STALE" : "AVAILABLE",
      reasonCodes: [...new Set([...reasonCodes, "MARKET_BASELINE_IS_BENCHMARK_ONLY"])],
    };
  }

  private unavailable(
    marketId: string,
    generatedAt: string,
    status: "INSUFFICIENT_DATA" | "MODEL_ERROR",
    reasonCodes: string[],
  ): StateSpaceEstimate {
    return {
      marketId,
      probabilities: null,
      posteriorProbabilities: null,
      uncertainty: null,
      innovation: null,
      standardizedInnovation: null,
      standardizedInnovationMagnitude: null,
      posteriorLogOddsVariance: null,
      modelVersion: "STATE_SPACE_LOG_ODDS/1.0.0",
      generatedAt,
      source: null,
      status,
      reasonCodes,
    };
  }
}

/** Convenience helper for diagnostics using the same additive-log-ratio basis. */
export function probsFromLogits(latentLogOdds: number[]): number[] {
  return fromAdditiveLogOdds(latentLogOdds);
}
