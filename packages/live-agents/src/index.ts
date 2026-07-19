import type { MarketDefinition, Portfolio, RiskLimit } from "../../contracts/src/index.js";
import { PaperExecutionEngine } from "../../execution/src/index.js";
import { createEmptyPortfolio } from "../../portfolio/src/index.js";
import type { SanitizedMarketEvent } from "./fixture-discovery.js";
import { AdaptiveQuoteGuard, type QuoteGuardLookup } from "./quote-guard.js";

export * from "./fixture-discovery.js";
export * from "./quote-guard.js";

export type MakerAction = "PLACE_QUOTES" | "REPLACE_QUOTES" | "WIDEN_QUOTES" | "REDUCE_SIZE" | "CANCEL_QUOTES" | "SUSPEND" | "RESUME";
export type HawkAction = "NO_TRADE" | "PAPER_BUY" | "PAPER_SELL";
export type IndependentTheoInput = {
  probability: number;
  source: "INDEPENDENT_MODEL";
  sourceId: string;
};

export type AgentObservation = {
  timestamp: string;
  fixtureId: string;
  marketId: string;
  selectionId: string;
  marketProbability: number;
  uncertainty: number;
  volatility: number;
  standardizedInnovation: number;
  latencyMs: number;
  stalenessMs: number;
  inventory: number;
  executionCost?: number;
  comparableMarket?: { marketId: string; probability: number } | null;
};

export type MakerStatus = {
  agent: "MakerAgent";
  state: "IDLE" | "QUOTING" | "SUSPENDED";
  latestAction: MakerAction | null;
  marketId: string | null;
  selectionId: string | null;
  marketConsensusCentre: number | null;
  quoteCentre: number | null;
  bid: number | null;
  ask: number | null;
  width: number | null;
  size: number | null;
  inventoryLean: number;
  quoteGuardRiskScore: number | null;
  reasonCodes: string[];
};

export type HawkStatus = {
  agent: "HawkAgent";
  state: "MONITORING" | "PAPER_SIGNAL";
  latestAction: HawkAction;
  signalType: "NONE" | "INDEPENDENT_THEO" | "LAGGED_MOVEMENT_INNOVATION";
  signalConfidence: number;
  edge: number | null;
  paperPosition: number;
  labels: string[];
  reasonCodes: string[];
};

export class SharedPaperExecutionRisk {
  readonly execution = new PaperExecutionEngine();
  portfolio: Portfolio;

  constructor(readonly limits: RiskLimit, bankroll = 100_000) {
    this.portfolio = createEmptyPortfolio("maker-hawk-shared-paper", bankroll);
  }

  grossExposure(): number {
    return this.portfolio.positions.reduce((sum, position) => sum + Math.abs(position.quantity), 0);
  }

  capacity(): number {
    if (this.limits.killSwitch || this.limits.quoteSuspension) return 0;
    return Math.max(0, this.limits.maxWorstCaseLoss - this.grossExposure());
  }

  paperPosition(marketId: string, selectionId: string): number {
    return this.portfolio.positions.find((position) => position.marketId === marketId && position.selectionId === selectionId)?.quantity ?? 0;
  }

  submitHawkPaperOrder(input: {
    market: MarketDefinition;
    selectionId: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
    timestamp: string;
  }): { accepted: boolean; reasonCodes: string[] } {
    const size = Math.min(input.size, this.capacity(), this.limits.maxOrderSize);
    if (size <= 0 || this.limits.directionalTradingSuspension) return { accepted: false, reasonCodes: ["SHARED_RISK_CAPACITY_UNAVAILABLE"] };
    const order = {
      orderId: `hawk-paper-${input.timestamp}-${input.market.marketId}-${input.selectionId}`,
      marketId: input.market.marketId,
      selectionId: input.selectionId,
      side: input.side,
      price: input.price,
      size,
      status: "NEW" as const,
      executionStyle: "TAKER" as const,
      strategyId: "replay-hawk-heuristic-paper",
      createdAt: input.timestamp,
      provenance: { source: "REPLAY" as const, notes: "Paper-only replay heuristic; no real execution path." },
    };
    const result = this.execution.submitOrder(this.portfolio, input.market, order, this.limits);
    this.portfolio = result.portfolio;
    return { accepted: result.order.status !== "REJECTED", reasonCodes: result.reasonCodes };
  }

  status() {
    return {
      mode: "PAPER",
      sharedBy: ["MakerAgent", "HawkAgent"],
      grossExposure: this.grossExposure(),
      remainingCapacity: this.capacity(),
      killSwitch: this.limits.killSwitch,
      realExecution: "DISABLED",
      walletRuntime: "ABSENT",
    };
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Number(value.toFixed(12));
}

export class MakerAgent {
  private latest: MakerStatus = {
    agent: "MakerAgent",
    state: "IDLE",
    latestAction: null,
    marketId: null,
    selectionId: null,
    marketConsensusCentre: null,
    quoteCentre: null,
    bid: null,
    ask: null,
    width: null,
    size: null,
    inventoryLean: 0,
    quoteGuardRiskScore: null,
    reasonCodes: ["AWAITING_MARKET_OBSERVATION"],
  };
  private readonly previous = new Map<string, MakerStatus>();
  private suspended = false;

  constructor(private readonly shared: SharedPaperExecutionRisk) {}

  onObservation(observation: AgentObservation, guard: QuoteGuardLookup): MakerStatus {
    const key = `${observation.marketId}|${observation.selectionId}`;
    const prior = this.previous.get(key);
    const guardAction = guard.available ? guard.row.recommendedAction : null;
    const riskBlocked = this.shared.limits.killSwitch || this.shared.limits.quoteSuspension || this.shared.capacity() <= 0;
    if (riskBlocked || guardAction === "SUSPEND" || guardAction === "HOLD_SUSPENDED") this.suspended = true;
    if (guardAction === "RESUME" && !riskBlocked) this.suspended = false;
    if (this.suspended) {
      this.latest = {
        agent: "MakerAgent",
        state: "SUSPENDED",
        latestAction: guardAction === "SUSPEND" || guardAction === "HOLD_SUSPENDED" ? "SUSPEND" : "CANCEL_QUOTES",
        marketId: observation.marketId,
        selectionId: observation.selectionId,
        marketConsensusCentre: observation.marketProbability,
        quoteCentre: observation.marketProbability,
        bid: null,
        ask: null,
        width: null,
        size: null,
        inventoryLean: 0,
        quoteGuardRiskScore: guard.available ? guard.row.riskScore : null,
        reasonCodes: [...guard.reasonCodes, riskBlocked ? "SHARED_RISK_LIMIT_BLOCK" : "QUOTE_GUARD_PAPER_SUSPENSION"],
      };
      this.previous.set(key, this.latest);
      return this.status();
    }

    const baseHalfWidth = clamp(
      0.01
        + 0.5 * observation.uncertainty
        + 0.4 * observation.volatility
        + 0.0025 * Math.abs(observation.standardizedInnovation)
        + 0.000001 * (observation.latencyMs + observation.stalenessMs),
      0.01,
      Math.min(0.2, this.shared.limits.maxQuoteWidth),
    );
    const inventoryLean = clamp(
      -(observation.inventory / Math.max(this.shared.limits.maxPositionPerSelection, 1)) * 0.02,
      -0.05,
      0.05,
    );
    const quoteCentre = clamp(observation.marketProbability + inventoryLean, 0.01, 0.99);
    const widthMultiplier = guard.available ? guard.row.widthMultiplier : 1;
    const sizeMultiplier = guard.available ? guard.row.sizeMultiplier : 1;
    const halfWidth = clamp(baseHalfWidth * widthMultiplier, 0.01, this.shared.limits.maxQuoteWidth);
    const size = Math.max(0, Math.min(100, this.shared.capacity(), this.shared.limits.maxOrderSize) * sizeMultiplier);
    const bid = clamp(quoteCentre - halfWidth, 0.01, 0.99);
    const ask = clamp(quoteCentre + halfWidth, 0.01, 0.99);
    let latestAction: MakerAction = prior ? "REPLACE_QUOTES" : "PLACE_QUOTES";
    if (guardAction === "RESUME") latestAction = "RESUME";
    else if (guard.available && widthMultiplier > 1) latestAction = "WIDEN_QUOTES";
    else if (guard.available && sizeMultiplier < 1) latestAction = "REDUCE_SIZE";
    this.latest = {
      agent: "MakerAgent",
      state: "QUOTING",
      latestAction,
      marketId: observation.marketId,
      selectionId: observation.selectionId,
      marketConsensusCentre: observation.marketProbability,
      quoteCentre: round(quoteCentre),
      bid: round(bid),
      ask: round(ask),
      width: round(ask - bid),
      size: round(size),
      inventoryLean: round(inventoryLean),
      quoteGuardRiskScore: guard.available ? guard.row.riskScore : null,
      reasonCodes: [
        "MARKET_CONSENSUS_QUOTE_CENTRE",
        "STATE_SPACE_UNCERTAINTY_INPUT",
        "VOLATILITY_INPUT",
        "INVENTORY_LEAN_APPLIED",
        "LATENCY_AND_STALENESS_INPUT",
        "SHARED_RISK_LIMITS_APPLIED",
        "PAPER_ONLY",
        "DIRECTIONAL_TRADING_DISABLED",
        "KELLY_DISABLED",
        ...guard.reasonCodes,
      ],
    };
    this.previous.set(key, this.latest);
    return this.status();
  }

  status(): MakerStatus {
    return { ...this.latest, reasonCodes: [...this.latest.reasonCodes] };
  }
}

export class HawkAgent {
  private latest: HawkStatus = {
    agent: "HawkAgent",
    state: "MONITORING",
    latestAction: "NO_TRADE",
    signalType: "NONE",
    signalConfidence: 0,
    edge: null,
    paperPosition: 0,
    labels: ["PAPER_ONLY", "NOT_PROVEN_ALPHA"],
    reasonCodes: ["INDEPENDENT_THEO_UNAVAILABLE"],
  };

  constructor(private readonly shared: SharedPaperExecutionRisk) {}

  monitorLive(observation: AgentObservation, independentTheo: IndependentTheoInput | null = null): HawkStatus {
    if (independentTheo === null) {
      const comparable = observation.comparableMarket;
      const comparableReasons = comparable?.marketId === observation.marketId
        ? ["SELF_MARKET_COMPARISON_REJECTED"]
        : comparable
          ? ["CROSS_MARKET_INCONSISTENCY_MONITORED"]
          : ["NO_COMPARABLE_CROSS_MARKET_INPUT"];
      this.latest = {
        agent: "HawkAgent",
        state: "MONITORING",
        latestAction: "NO_TRADE",
        signalType: "NONE",
        signalConfidence: 0,
        edge: null,
        paperPosition: this.shared.paperPosition(observation.marketId, observation.selectionId),
        labels: ["PAPER_ONLY", "NOT_PROVEN_ALPHA"],
        reasonCodes: [
          "INDEPENDENT_THEO_UNAVAILABLE",
          "MARKET_MOVEMENT_MONITORED",
          "STANDARDIZED_INNOVATION_MONITORED",
          "DATA_FRESHNESS_MONITORED",
          "EXECUTION_COST_MONITORED",
          "SHARED_RISK_CAPACITY_MONITORED",
          ...comparableReasons,
        ],
      };
      return this.status();
    }
    if (independentTheo.source !== "INDEPENDENT_MODEL" || independentTheo.sourceId.trim() === "") {
      return this.monitorLive(observation, null);
    }
    const edge = independentTheo.probability - observation.marketProbability;
    this.latest = {
      agent: "HawkAgent",
      state: "MONITORING",
      latestAction: "NO_TRADE",
      signalType: "INDEPENDENT_THEO",
      signalConfidence: 0,
      edge,
      paperPosition: this.shared.paperPosition(observation.marketId, observation.selectionId),
      labels: ["PAPER_ONLY", "NOT_PROVEN_ALPHA"],
      reasonCodes: ["INDEPENDENT_THEO_EXECUTION_NOT_ENABLED"],
    };
    return this.status();
  }

  onReplayHeuristic(observation: AgentObservation, market: MarketDefinition, laggedMovement: number): HawkStatus {
    const signal = Math.abs(laggedMovement) >= 0.005 && Math.abs(observation.standardizedInnovation) >= 1;
    if (!signal) return this.monitorLive(observation, null);
    const side = laggedMovement > 0 ? "BUY" : "SELL";
    const confidence = clamp(Math.abs(observation.standardizedInnovation) / 5, 0, 1);
    const result = this.shared.submitHawkPaperOrder({
      market,
      selectionId: observation.selectionId,
      side,
      price: observation.marketProbability,
      size: Math.max(1, confidence * 10),
      timestamp: observation.timestamp,
    });
    this.latest = {
      agent: "HawkAgent",
      state: result.accepted ? "PAPER_SIGNAL" : "MONITORING",
      latestAction: result.accepted ? (side === "BUY" ? "PAPER_BUY" : "PAPER_SELL") : "NO_TRADE",
      signalType: "LAGGED_MOVEMENT_INNOVATION",
      signalConfidence: round(confidence),
      edge: null,
      paperPosition: this.shared.paperPosition(observation.marketId, observation.selectionId),
      labels: ["REPLAY_HAWK_HEURISTIC", "PAPER_ONLY", "NOT_PROVEN_ALPHA"],
      reasonCodes: result.accepted
        ? ["LAGGED_MOVEMENT", "STANDARDIZED_INNOVATION", "PAPER_EXECUTION_ONLY"]
        : [...result.reasonCodes, "PAPER_EXECUTION_ONLY"],
    };
    return this.status();
  }

  status(): HawkStatus {
    return { ...this.latest, labels: [...this.latest.labels], reasonCodes: [...this.latest.reasonCodes] };
  }
}

type FeatureState = { previous: number | null; movements: number[]; variance: number };

export class DualStrategyController {
  readonly shared: SharedPaperExecutionRisk;
  readonly maker: MakerAgent;
  readonly hawk: HawkAgent;
  readonly audit: Array<Record<string, unknown>> = [];
  private readonly features = new Map<string, FeatureState>();

  constructor(readonly quoteGuard: AdaptiveQuoteGuard, limits: RiskLimit) {
    this.shared = new SharedPaperExecutionRisk(limits);
    this.maker = new MakerAgent(this.shared);
    this.hawk = new HawkAgent(this.shared);
  }

  private observation(event: SanitizedMarketEvent, selectionIndex: number): { observation: AgentObservation; movement: number } {
    const selectionId = event.selectionIds[selectionIndex]!;
    const probability = event.marketProbabilities[selectionIndex]!;
    const key = `${event.marketId}|${selectionId}`;
    const state = this.features.get(key) ?? { previous: null, movements: [], variance: 0.0001 };
    const movement = state.previous === null ? 0 : probability - state.previous;
    const priorMean = state.movements.length ? state.movements.reduce((sum, value) => sum + value, 0) / state.movements.length : 0;
    const priorVariance = state.movements.length > 1
      ? state.movements.reduce((sum, value) => sum + (value - priorMean) ** 2, 0) / state.movements.length
      : state.variance;
    const innovation = state.previous === null ? 0 : (movement - priorMean) / Math.max(Math.sqrt(priorVariance), 0.0025);
    state.variance = 0.9 * state.variance + 0.1 * movement ** 2;
    state.movements = [...state.movements.slice(-19), movement];
    state.previous = probability;
    this.features.set(key, state);
    return {
      movement,
      observation: {
        timestamp: event.timestamp,
        fixtureId: event.fixtureId,
        marketId: event.marketId,
        selectionId,
        marketProbability: probability,
        uncertainty: Math.sqrt(state.variance),
        volatility: Math.sqrt(state.variance),
        standardizedInnovation: innovation,
        latencyMs: 0,
        stalenessMs: 0,
        inventory: this.shared.paperPosition(event.marketId, selectionId),
        executionCost: 0.001,
        comparableMarket: null,
      },
    };
  }

  ingest(event: SanitizedMarketEvent, mode: "LIVE" | "REPLAY", market?: MarketDefinition): void {
    for (let selectionIndex = 0; selectionIndex < event.selectionIds.length; selectionIndex += 1) {
      const next = this.observation(event, selectionIndex);
      const guard = this.quoteGuard.lookup(next.observation);
      const maker = this.maker.onObservation(next.observation, guard);
      const hawk = mode === "REPLAY" && market
        ? this.hawk.onReplayHeuristic(next.observation, market, next.movement)
        : this.hawk.monitorLive(next.observation, null);
      this.audit.push({
        timestamp: event.timestamp,
        mode,
        fixtureId: event.fixtureId,
        marketId: event.marketId,
        selectionId: next.observation.selectionId,
        makerAction: maker.latestAction,
        hawkAction: hawk.latestAction,
        quoteGuardAvailable: guard.available,
        quoteGuardChangedCentre: maker.quoteCentre !== null
          && round(maker.quoteCentre - maker.inventoryLean) !== round(maker.marketConsensusCentre ?? 0),
        realExecution: false,
      });
    }
  }

  status() {
    return {
      controller: "MakerHawkController",
      mode: "PAPER_ONLY",
      maker: this.maker.status(),
      hawk: this.hawk.status(),
      sharedRisk: this.shared.status(),
      quoteGuard: this.quoteGuard.status(),
      security: {
        network: "devnet",
        walletRuntime: "ABSENT",
        realExecution: false,
        mainnet: false,
        subscriptionActivation: false,
        directionalActions: "PAPER_ONLY",
        kelly: false,
      },
    };
  }
}
