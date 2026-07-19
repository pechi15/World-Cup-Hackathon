import type { MarketDefinition, RiskLimit } from "../../contracts/src/index.js";
import type { SanitizedMarketEvent } from "./fixture-discovery.js";
import {
  DecisionBook,
  ShadowExecutionEngine,
  type DecisionAction,
  type DecisionRecord,
  type DecisionSide,
  type ExecutableMarketEvent,
  type FeatureReference,
  type RecordDecisionInput,
  type SettlementEvent,
  type ShadowExecutionConfig,
} from "./decision-book.js";
import { AdaptiveQuoteGuard, type QuoteGuardLookup } from "./quote-guard.js";

export * from "./decision-book.js";
export * from "./fixture-discovery.js";
export * from "./quote-guard.js";

export type MakerAction = "NONE" | "PLACE_QUOTES" | "REPLACE_QUOTES" | "HOLD_QUOTES" | "WIDEN_QUOTES" | "REDUCE_SIZE" | "CANCEL_QUOTES" | "SUSPEND" | "RESUME";
export type HawkAction = "NONE" | "MONITOR" | "FLAG_SIGNAL" | "OPEN_SHADOW_POSITION" | "REDUCE_SHADOW_POSITION" | "CLOSE_SHADOW_POSITION" | "NO_TRADE";
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

type PresentationFields = {
  agentId: "maker" | "hawk";
  displayName: "Maker Bee" | "Forager Bee";
  technicalRole: "AUTONOMOUS_MARKET_MAKER" | "RELATIVE_VALUE_SCOUT";
  technicalSubtitle: string;
  executionMode: "SHADOW";
};

export type MakerStatus = PresentationFields & {
  agent: "MakerAgent";
  agentId: "maker";
  displayName: "Maker Bee";
  technicalRole: "AUTONOMOUS_MARKET_MAKER";
  state: "IDLE" | "QUOTING" | "SUSPENDED";
  latestAction: MakerAction;
  latestDecisionId: string | null;
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
  quoteRiskScore: number | null;
  runId: string | null;
  eventIndex: number;
  sourceTimestamp: string | null;
  currentMarketObservation: {
    fixtureId: string;
    marketId: string;
    selectionId: string;
    marketReference: number;
    uncertainty: number;
    volatility: number;
    standardizedInnovation: number;
  } | null;
  activeQuote: {
    bid: number;
    ask: number;
    width: number;
    size: number;
    createdAtEventIndex: number;
    createdAtSourceTimestamp: string;
    validThroughEventIndex: number;
    fixtureId: string;
    marketId: string;
    selectionId: string;
    status: "ACTIVE" | "CANCELLED" | "SUSPENDED";
  } | null;
  latestDecision: {
    action: MakerAction;
    decisionTimestamp: string;
    decisionEventIndex: number;
    reasonCodes: string[];
    previousQuote: MakerStatus["activeQuote"];
    resultingQuote: MakerStatus["activeQuote"];
  } | null;
  reasonCodes: string[];
};

export type AgentEventContext = { runId: string; eventIndex: number; provenance?: string };

export type HawkStatus = PresentationFields & {
  agent: "HawkAgent";
  agentId: "hawk";
  displayName: "Forager Bee";
  agentType: "RELATIVE_VALUE_SCOUT";
  technicalRole: "RELATIVE_VALUE_SCOUT";
  state: "READY" | "MONITORING" | "SIGNAL_FLAGGED" | "SHADOW_POSITION";
  latestAction: HawkAction;
  latestDecisionId: string | null;
  signalType: "NONE" | "INDEPENDENT_THEO" | "RELATIVE_VALUE_SIGNAL" | "MOVEMENT_SIGNAL" | "CROSS_MARKET_DISLOCATION";
  signalConfidence: number | null;
  edge: number | null;
  paperPosition: number;
  labels: string[];
  reasonCodes: string[];
};

export type HiveControlState = {
  manualKillSwitch: boolean;
  latencyKillSwitch: boolean;
  staleDataKillSwitch: boolean;
  sequenceGapKillSwitch: boolean;
  currentDrawdown: number;
};

const defaultShadowConfig: ShadowExecutionConfig = {
  configuredLatencyMs: 250,
  feeRate: 0.001,
  slippageBps: 5,
};

export class SharedPaperExecutionRisk {
  readonly decisionBook: DecisionBook;
  readonly shadowExecution: ShadowExecutionEngine;
  private controls: HiveControlState = {
    manualKillSwitch: false,
    latencyKillSwitch: false,
    staleDataKillSwitch: false,
    sequenceGapKillSwitch: false,
    currentDrawdown: 0,
  };

  constructor(readonly limits: RiskLimit, _bankroll = 100_000, shadowConfig: Partial<ShadowExecutionConfig> = {}) {
    this.decisionBook = new DecisionBook();
    this.shadowExecution = new ShadowExecutionEngine(this.decisionBook, { ...defaultShadowConfig, ...shadowConfig });
  }

  grossExposure(): number {
    return this.shadowExecution.grossExposure();
  }

  capacity(): number {
    if (this.isKilled()) return 0;
    return Math.max(0, Math.min(
      this.limits.maxWorstCaseLoss - this.grossExposure(),
      this.limits.maxDailyDrawdown - this.controls.currentDrawdown,
    ));
  }

  paperPosition(marketId: string, selectionId: string): number {
    return this.shadowExecution.position(marketId, selectionId);
  }

  evaluate(input: AgentObservation, requestedSize: number, directional: boolean): { accepted: boolean; size: number; reasonCodes: string[] } {
    const reasonCodes: string[] = [];
    if (this.limits.killSwitch || this.controls.manualKillSwitch) reasonCodes.push("MANUAL_KILL_SWITCH");
    if (this.controls.sequenceGapKillSwitch) reasonCodes.push("SEQUENCE_GAP_KILL_SWITCH");
    if (this.controls.latencyKillSwitch || input.latencyMs > this.limits.minDataFreshnessMs) reasonCodes.push("LATENCY_KILL_SWITCH");
    if (this.controls.staleDataKillSwitch || input.stalenessMs > this.limits.minDataFreshnessMs) reasonCodes.push("STALE_DATA_KILL_SWITCH");
    if (directional && this.limits.directionalTradingSuspension) reasonCodes.push("DIRECTIONAL_TRADING_SUSPENDED");
    if (!directional && this.limits.quoteSuspension) reasonCodes.push("QUOTE_SUSPENSION");
    const remainingMarket = this.limits.maxExposurePerMarket - this.shadowExecution.marketExposure(input.marketId);
    const remainingFixture = this.limits.maxExposurePerFixture - this.shadowExecution.fixtureExposure(input.fixtureId);
    const remainingSelection = this.limits.maxPositionPerSelection - Math.abs(this.paperPosition(input.marketId, input.selectionId));
    if (remainingMarket <= 0) reasonCodes.push("MARKET_EXPOSURE_LIMIT");
    if (remainingFixture <= 0) reasonCodes.push("FIXTURE_EXPOSURE_LIMIT");
    if (remainingSelection <= 0) reasonCodes.push("INVENTORY_LIMIT");
    if (this.grossExposure() >= this.limits.maxWorstCaseLoss) reasonCodes.push("WORST_CASE_LOSS_LIMIT");
    if (this.controls.currentDrawdown >= this.limits.maxDailyDrawdown) reasonCodes.push("DRAWDOWN_LIMIT");
    const size = Math.max(0, Math.min(
      requestedSize,
      this.limits.maxOrderSize,
      this.capacity(),
      remainingMarket,
      remainingFixture,
      remainingSelection,
    ));
    if (size <= 0) reasonCodes.push("SHARED_RISK_CAPACITY_UNAVAILABLE");
    return { accepted: reasonCodes.length === 0, size: round(size), reasonCodes };
  }

  setControlState(update: Partial<HiveControlState>): void {
    this.controls = { ...this.controls, ...update };
  }

  reset(): void {
    this.controls = {
      manualKillSwitch: false,
      latencyKillSwitch: false,
      staleDataKillSwitch: false,
      sequenceGapKillSwitch: false,
      currentDrawdown: 0,
    };
    this.decisionBook.clear();
    this.shadowExecution.reset();
  }

  processMarketEvent(event: ExecutableMarketEvent): DecisionRecord[] {
    return this.shadowExecution.processMarketEvent(event);
  }

  settle(event: SettlementEvent): DecisionRecord[] {
    return this.shadowExecution.settle(event);
  }

  status() {
    const killed = this.isKilled();
    return {
      displayName: "Hive Risk Engine",
      technicalRole: "SHARED_SHADOW_RISK_CONTROL",
      technicalSubtitle: "Shared inventory, latency, limits, and shadow-execution controls",
      mode: "PAPER",
      executionMode: "SHADOW",
      sharedBy: ["MakerAgent", "HawkAgent"],
      fixtureExposureLimit: this.limits.maxExposurePerFixture,
      marketExposureLimit: this.limits.maxExposurePerMarket,
      inventoryLimit: this.limits.maxPositionPerSelection,
      worstCaseLossLimit: this.limits.maxWorstCaseLoss,
      drawdownLimit: this.limits.maxDailyDrawdown,
      state: killed ? "HALTED" : "ARMED",
      exposure: this.grossExposure(),
      drawdown: this.controls.currentDrawdown,
      killSwitch: killed ? "ON" : "OFF",
      grossExposure: this.grossExposure(),
      remainingCapacity: this.capacity(),
      killSwitches: {
        manual: this.limits.killSwitch || this.controls.manualKillSwitch,
        latency: this.controls.latencyKillSwitch,
        staleData: this.controls.staleDataKillSwitch,
        sequenceGap: this.controls.sequenceGapKillSwitch,
      },
      realExecution: "DISABLED",
      realFunds: "DISABLED",
      walletRuntime: "ABSENT",
    };
  }

  private isKilled(): boolean {
    return this.limits.killSwitch
      || this.limits.quoteSuspension
      || this.controls.manualKillSwitch
      || this.controls.latencyKillSwitch
      || this.controls.staleDataKillSwitch
      || this.controls.sequenceGapKillSwitch;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Number(value.toFixed(12));
}

const makerPresentation = {
  agent: "MakerAgent" as const,
  agentId: "maker" as const,
  displayName: "Maker Bee" as const,
  technicalRole: "AUTONOMOUS_MARKET_MAKER" as const,
  technicalSubtitle: "Autonomous two-sided market-making agent",
  executionMode: "SHADOW" as const,
};

function initialMakerStatus(runId: string | null = null): MakerStatus {
  return {
    ...makerPresentation,
    state: "IDLE",
    latestAction: "NONE",
    latestDecisionId: null,
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
    quoteRiskScore: null,
    runId,
    eventIndex: 0,
    sourceTimestamp: null,
    currentMarketObservation: null,
    activeQuote: null,
    latestDecision: null,
    reasonCodes: ["WAITING_FOR_FIRST_MARKET_EVENT"],
  };
}

export class MakerAgent {
  private latest: MakerStatus = initialMakerStatus();
  private readonly previous = new Map<string, MakerStatus>();
  private suspended = false;

  constructor(private readonly shared: SharedPaperExecutionRisk) {}

  reset(runId: string | null = null): void {
    this.latest = initialMakerStatus(runId);
    this.previous.clear();
    this.suspended = false;
  }

  onObservation(observation: AgentObservation, guard: QuoteGuardLookup, context: AgentEventContext = { runId: "live", eventIndex: 0 }): MakerStatus {
    const key = `${observation.marketId}|${observation.selectionId}`;
    const prior = this.previous.get(key);
    const guardAction = guard.available ? guard.row.recommendedAction : null;
    const risk = this.shared.evaluate(observation, Math.min(100, this.shared.limits.maxOrderSize), false);
    if (!risk.accepted || guardAction === "SUSPEND" || guardAction === "HOLD_SUSPENDED") this.suspended = true;
    if (guardAction === "RESUME" && risk.accepted) this.suspended = false;
    if (this.suspended) {
      const previousQuote = prior?.activeQuote ?? null;
      const reasons = [...guard.reasonCodes, ...risk.reasonCodes, risk.accepted ? "QUOTE_GUARD_PAPER_SUSPENSION" : "HIVE_RISK_LIMIT_BLOCK"];
      this.latest = {
        ...makerPresentation,
        state: "SUSPENDED",
        latestAction: guardAction === "SUSPEND" || guardAction === "HOLD_SUSPENDED" ? "SUSPEND" : "CANCEL_QUOTES",
        latestDecisionId: this.latest.latestDecisionId,
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
        quoteRiskScore: guard.available ? guard.row.riskScore : null,
        runId: context.runId,
        eventIndex: context.eventIndex,
        sourceTimestamp: observation.timestamp,
        currentMarketObservation: marketObservation(observation),
        activeQuote: previousQuote ? { ...previousQuote, validThroughEventIndex: context.eventIndex, status: "SUSPENDED" } : null,
        latestDecision: {
          action: guardAction === "SUSPEND" || guardAction === "HOLD_SUSPENDED" ? "SUSPEND" : "CANCEL_QUOTES",
          decisionTimestamp: observation.timestamp,
          decisionEventIndex: context.eventIndex,
          reasonCodes: reasons,
          previousQuote,
          resultingQuote: null,
        },
        reasonCodes: reasons,
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
    const size = risk.size * sizeMultiplier;
    const bid = clamp(quoteCentre - halfWidth, 0.01, 0.99);
    const ask = clamp(quoteCentre + halfWidth, 0.01, 0.99);
    let latestAction: MakerAction = prior ? "REPLACE_QUOTES" : "PLACE_QUOTES";
    if (guardAction === "RESUME") latestAction = "RESUME";
    else if (guard.available && widthMultiplier > 1) latestAction = "WIDEN_QUOTES";
    else if (guard.available && sizeMultiplier < 1) latestAction = "REDUCE_SIZE";
    const proposedQuote: NonNullable<MakerStatus["activeQuote"]> = {
      bid: round(bid),
      ask: round(ask),
      width: round(ask - bid),
      size: round(size),
      createdAtEventIndex: context.eventIndex,
      createdAtSourceTimestamp: observation.timestamp,
      validThroughEventIndex: context.eventIndex,
      fixtureId: observation.fixtureId,
      marketId: observation.marketId,
      selectionId: observation.selectionId,
      status: "ACTIVE",
    };
    const priorQuote = prior?.activeQuote ?? null;
    const ordinaryReplacement = latestAction === "REPLACE_QUOTES";
    const materiallyChanged = !priorQuote
      || Math.abs(priorQuote.bid - proposedQuote.bid) >= 0.002
      || Math.abs(priorQuote.ask - proposedQuote.ask) >= 0.002
      || Math.abs(priorQuote.width - proposedQuote.width) >= 0.002
      || Math.abs(priorQuote.size - proposedQuote.size) >= 0.5;
    if (ordinaryReplacement && !materiallyChanged) latestAction = "HOLD_QUOTES";
    const activeQuote = latestAction === "HOLD_QUOTES"
      ? { ...priorQuote!, validThroughEventIndex: context.eventIndex }
      : proposedQuote;
    const reasons = [
      latestAction === "HOLD_QUOTES" ? "REPLACEMENT_THRESHOLD_NOT_MET" : prior ? "MARKET_REFERENCE_MOVED" : "FIRST_MARKET_EVENT",
      "MARKET_CONSENSUS_QUOTE_CENTRE",
      "STATE_SPACE_UNCERTAINTY_INPUT",
      "VOLATILITY_INPUT",
      "INVENTORY_LEAN_APPLIED",
      "LATENCY_AND_STALENESS_INPUT",
      "HIVE_RISK_LIMITS_APPLIED",
      "SHADOW_EXECUTION",
      "REAL_FUNDS_DISABLED",
      "DIRECTIONAL_TRADING_DISABLED",
      "KELLY_DISABLED",
      ...guard.reasonCodes,
    ];
    this.latest = {
      ...makerPresentation,
      state: "QUOTING",
      latestAction,
      latestDecisionId: this.latest.latestDecisionId,
      marketId: observation.marketId,
      selectionId: observation.selectionId,
      marketConsensusCentre: observation.marketProbability,
      quoteCentre: latestAction === "HOLD_QUOTES" ? prior!.quoteCentre : round(quoteCentre),
      bid: activeQuote.bid,
      ask: activeQuote.ask,
      width: activeQuote.width,
      size: activeQuote.size,
      inventoryLean: round(inventoryLean),
      quoteGuardRiskScore: guard.available ? guard.row.riskScore : null,
      quoteRiskScore: guard.available ? guard.row.riskScore : null,
      runId: context.runId,
      eventIndex: context.eventIndex,
      sourceTimestamp: observation.timestamp,
      currentMarketObservation: marketObservation(observation),
      activeQuote,
      latestDecision: {
        action: latestAction,
        decisionTimestamp: observation.timestamp,
        decisionEventIndex: context.eventIndex,
        reasonCodes: reasons,
        previousQuote: priorQuote,
        resultingQuote: activeQuote,
      },
      reasonCodes: reasons,
    };
    this.previous.set(key, this.latest);
    return this.status();
  }

  setLatestDecision(decisionId: string): void {
    this.latest = { ...this.latest, latestDecisionId: decisionId };
  }

  status(): MakerStatus {
    return { ...this.latest, reasonCodes: [...this.latest.reasonCodes] };
  }
}

const foragerLabels = [
  "AUTONOMOUS AGENT",
  "SHADOW EXECUTION",
  "PAPER POSITION",
  "REAL FUNDS DISABLED",
  "NOT PROVEN ALPHA",
  "PAPER_ONLY",
  "NOT_PROVEN_ALPHA",
];
const hawkPresentation = {
  agent: "HawkAgent" as const,
  agentId: "hawk" as const,
  displayName: "Forager Bee" as const,
  agentType: "RELATIVE_VALUE_SCOUT" as const,
  technicalRole: "RELATIVE_VALUE_SCOUT" as const,
  technicalSubtitle: "Relative-value and market-movement signal agent",
  executionMode: "SHADOW" as const,
};

function initialHawkStatus(): HawkStatus {
  return {
    ...hawkPresentation,
    state: "READY",
    latestAction: "NONE",
    latestDecisionId: null,
    signalType: "NONE",
    signalConfidence: null,
    edge: null,
    paperPosition: 0,
    labels: [...foragerLabels],
    reasonCodes: ["WAITING_FOR_FIRST_MARKET_EVENT"],
  };
}

function marketObservation(observation: AgentObservation): NonNullable<MakerStatus["currentMarketObservation"]> {
  return {
    fixtureId: observation.fixtureId,
    marketId: observation.marketId,
    selectionId: observation.selectionId,
    marketReference: observation.marketProbability,
    uncertainty: observation.uncertainty,
    volatility: observation.volatility,
    standardizedInnovation: observation.standardizedInnovation,
  };
}

export type HawkHeuristicConfig = {
  innovationThreshold: number;
  persistentUpdates: number;
  minimumMovement: number;
  fixedPaperSize: number;
};

const defaultHawkConfig: HawkHeuristicConfig = {
  innovationThreshold: 1,
  persistentUpdates: 2,
  minimumMovement: 0.005,
  fixedPaperSize: 10,
};

export class HawkAgent {
  private latest: HawkStatus = initialHawkStatus();

  constructor(private readonly shared: SharedPaperExecutionRisk, private readonly config: HawkHeuristicConfig = defaultHawkConfig) {}

  reset(): void {
    this.latest = initialHawkStatus();
  }

  monitorLive(observation: AgentObservation, independentTheo: IndependentTheoInput | null = null): HawkStatus {
    const comparable = observation.comparableMarket;
    const comparableReasons = comparable?.marketId === observation.marketId
      ? ["SELF_MARKET_COMPARISON_REJECTED"]
      : comparable
        ? ["CROSS_MARKET_INCONSISTENCY_MONITORED"]
        : ["NO_COMPARABLE_CROSS_MARKET_INPUT"];
    const validTheo = independentTheo?.source === "INDEPENDENT_MODEL" && independentTheo.sourceId.trim() !== "";
    this.latest = {
      ...hawkPresentation,
      state: "MONITORING",
      latestAction: "NO_TRADE",
      latestDecisionId: this.latest.latestDecisionId,
      signalType: validTheo ? "INDEPENDENT_THEO" : "NONE",
      signalConfidence: 0,
      edge: validTheo ? independentTheo.probability - observation.marketProbability : null,
      paperPosition: this.shared.paperPosition(observation.marketId, observation.selectionId),
      labels: [...foragerLabels],
      reasonCodes: [
        validTheo ? "INDEPENDENT_THEO_EXECUTION_NOT_ENABLED" : "INDEPENDENT_THEO_UNAVAILABLE",
        "MARKET_MOVEMENT_MONITORED",
        "STANDARDIZED_INNOVATION_MONITORED",
        "DATA_FRESHNESS_MONITORED",
        "EXECUTION_COST_MONITORED",
        "HIVE_RISK_CAPACITY_MONITORED",
        ...comparableReasons,
      ],
    };
    return this.status();
  }

  onMovementHeuristic(input: {
    observation: AgentObservation;
    movementHistory: number[];
    sourceEventId: string;
    receiveTime: string;
    provenance: string;
    mode: "LIVE" | "REPLAY";
  }): HawkStatus {
    const recent = input.movementHistory.slice(-this.config.persistentUpdates);
    const direction = Math.sign(recent.at(-1) ?? 0);
    const persistent = recent.length === this.config.persistentUpdates
      && direction !== 0
      && recent.every((movement) => Math.sign(movement) === direction && Math.abs(movement) >= this.config.minimumMovement);
    const innovative = Math.abs(input.observation.standardizedInnovation) > this.config.innovationThreshold;
    const risk = this.shared.evaluate(input.observation, this.config.fixedPaperSize, true);
    const signal = persistent && innovative && risk.accepted;
    const featureReferences: FeatureReference[] = [{
      eventId: input.sourceEventId,
      availableAt: input.receiveTime,
      kind: "MARKET_OBSERVATION",
    }];

    if (!signal) {
      const reasons = [
        ...(persistent ? [] : ["PERSISTENT_MOVEMENT_NOT_CONFIRMED"]),
        ...(innovative ? [] : ["INNOVATION_BELOW_THRESHOLD"]),
        ...risk.reasonCodes,
        "NO_VALID_SIGNAL",
        "INDEPENDENT_THEO_UNAVAILABLE",
      ];
      const decision = this.recordDecision(input, {
        action: "NO_TRADE",
        side: "NONE",
        proposedPrice: null,
        proposedSize: 0,
        status: "NO_TRADE",
        reasonCodes: reasons,
        featureReferences,
      });
      this.latest = {
        ...hawkPresentation,
        state: "MONITORING",
        latestAction: persistent && innovative ? "FLAG_SIGNAL" : "NO_TRADE",
        latestDecisionId: decision.decisionId,
        signalType: persistent && innovative ? "MOVEMENT_SIGNAL" : "NONE",
        signalConfidence: persistent ? round(clamp(Math.abs(input.observation.standardizedInnovation) / 5, 0, 1)) : 0,
        edge: null,
        paperPosition: this.shared.paperPosition(input.observation.marketId, input.observation.selectionId),
        labels: input.mode === "REPLAY" ? ["REPLAY_HAWK_HEURISTIC", ...foragerLabels] : [...foragerLabels],
        reasonCodes: reasons,
      };
      return this.status();
    }

    const side: DecisionSide = direction > 0 ? "BUY" : "SELL";
    const currentPosition = this.shared.paperPosition(input.observation.marketId, input.observation.selectionId);
    if (currentPosition !== 0 && Math.sign(currentPosition) === direction) {
      const decision = this.recordDecision(input, {
        action: "NO_TRADE",
        side: "NONE",
        proposedPrice: null,
        proposedSize: 0,
        status: "NO_TRADE",
        reasonCodes: ["EXISTING_DIRECTIONAL_PAPER_POSITION", "NO_VALID_INCREMENTAL_SIGNAL"],
        featureReferences,
      });
      this.latest = {
        ...hawkPresentation,
        state: "SHADOW_POSITION",
        latestAction: "NO_TRADE",
        latestDecisionId: decision.decisionId,
        signalType: "MOVEMENT_SIGNAL",
        signalConfidence: round(clamp(Math.abs(input.observation.standardizedInnovation) / 5, 0, 1)),
        edge: null,
        paperPosition: currentPosition,
        labels: input.mode === "REPLAY" ? ["REPLAY_HAWK_HEURISTIC", ...foragerLabels] : [...foragerLabels],
        reasonCodes: ["EXISTING_DIRECTIONAL_PAPER_POSITION", "KELLY_DISABLED_WITHOUT_INDEPENDENT_THEO"],
      };
      return this.status();
    }

    const decisionAction: DecisionAction = currentPosition === 0
      ? "OPEN_PAPER_POSITION"
      : Math.abs(currentPosition) <= risk.size
        ? "CLOSE_PAPER_POSITION"
        : "REDUCE_PAPER_POSITION";
    const presentationAction: HawkAction = decisionAction === "OPEN_PAPER_POSITION"
      ? "OPEN_SHADOW_POSITION"
      : decisionAction === "CLOSE_PAPER_POSITION"
        ? "CLOSE_SHADOW_POSITION"
        : "REDUCE_SHADOW_POSITION";
    const decision = this.recordDecision(input, {
      action: decisionAction,
      side,
      proposedPrice: input.observation.marketProbability,
      proposedSize: risk.size,
      status: "PENDING",
      reasonCodes: [
        "MOVEMENT_SIGNAL",
        "PERSISTENT_LAGGED_MOVEMENT",
        "STANDARDIZED_INNOVATION_THRESHOLD",
        "FRESH_DATA",
        "LATENCY_WITHIN_LIMIT",
        "HIVE_RISK_CAPACITY_AVAILABLE",
        "FIXED_RISK_PAPER_SIZE",
        "KELLY_DISABLED_WITHOUT_INDEPENDENT_THEO",
      ],
      featureReferences,
    });
    this.latest = {
      ...hawkPresentation,
      state: "SIGNAL_FLAGGED",
      latestAction: presentationAction,
      latestDecisionId: decision.decisionId,
      signalType: "MOVEMENT_SIGNAL",
      signalConfidence: round(clamp(Math.abs(input.observation.standardizedInnovation) / 5, 0, 1)),
      edge: null,
      paperPosition: currentPosition,
      labels: input.mode === "REPLAY" ? ["REPLAY_HAWK_HEURISTIC", ...foragerLabels] : [...foragerLabels],
      reasonCodes: [...decision.reasonCodes],
    };
    return this.status();
  }

  /** Compatibility method: still one Hawk implementation, now routed through the causal shadow heuristic. */
  onReplayHeuristic(observation: AgentObservation, _market: MarketDefinition, laggedMovement: number): HawkStatus {
    return this.onMovementHeuristic({
      observation,
      movementHistory: [laggedMovement, laggedMovement],
      sourceEventId: `${observation.timestamp}|${observation.marketId}|${observation.selectionId}`,
      receiveTime: observation.timestamp,
      provenance: "RECORDED_TXODDS_REPLAY",
      mode: "REPLAY",
    });
  }

  refreshPosition(marketId: string, selectionId: string): void {
    this.latest = { ...this.latest, paperPosition: this.shared.paperPosition(marketId, selectionId) };
  }

  status(): HawkStatus {
    return { ...this.latest, labels: [...this.latest.labels], reasonCodes: [...this.latest.reasonCodes] };
  }

  private recordDecision(
    input: Parameters<HawkAgent["onMovementHeuristic"]>[0],
    decision: Pick<RecordDecisionInput, "action" | "side" | "proposedPrice" | "proposedSize" | "status" | "reasonCodes" | "featureReferences">,
  ): DecisionRecord {
    return this.shared.decisionBook.record({
      fixtureId: input.observation.fixtureId,
      marketId: input.observation.marketId,
      selectionId: input.observation.selectionId,
      sourceEventId: input.sourceEventId,
      sourceEventTime: input.observation.timestamp,
      receiveTime: input.receiveTime,
      dataCutoffTime: input.receiveTime,
      decisionTime: input.receiveTime,
      configuredLatencyMs: this.shared.shadowExecution.config.configuredLatencyMs,
      strategy: "hawk",
      provenance: input.provenance,
      ...decision,
    });
  }
}

type FeatureState = { previous: number | null; movements: number[]; variance: number };

export class DualStrategyController {
  readonly shared: SharedPaperExecutionRisk;
  readonly maker: MakerAgent;
  readonly hawk: HawkAgent;
  readonly audit: Array<Record<string, unknown>> = [];
  private readonly features = new Map<string, FeatureState>();

  constructor(readonly quoteGuard: AdaptiveQuoteGuard, limits: RiskLimit, shadowConfig: Partial<ShadowExecutionConfig> = {}) {
    this.shared = new SharedPaperExecutionRisk(limits, 100_000, shadowConfig);
    this.maker = new MakerAgent(this.shared);
    this.hawk = new HawkAgent(this.shared);
  }

  reset(runId: string | null = null): void {
    this.features.clear();
    this.audit.length = 0;
    this.shared.reset();
    this.maker.reset(runId);
    this.hawk.reset();
  }

  private observation(event: SanitizedMarketEvent, selectionIndex: number): { observation: AgentObservation; movements: number[] } {
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
      movements: [...state.movements],
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

  ingest(
    event: SanitizedMarketEvent,
    mode: "LIVE" | "REPLAY",
    _market?: MarketDefinition,
    context: AgentEventContext = { runId: mode === "REPLAY" ? "replay" : "live", eventIndex: this.audit.length + 1 },
  ): void {
    const provenance = context.provenance ?? (mode === "REPLAY" ? "RECORDED_TXODDS_REPLAY" : "SANITIZED_TXODDS");
    for (let selectionIndex = 0; selectionIndex < event.selectionIds.length; selectionIndex += 1) {
      const next = this.observation(event, selectionIndex);
      const sourceEventId = `${event.messageId ?? event.timestamp}|${event.marketId}|${next.observation.selectionId}`;
      const executable: ExecutableMarketEvent = {
        eventId: sourceEventId,
        fixtureId: event.fixtureId,
        marketId: event.marketId,
        selectionId: next.observation.selectionId,
        sourceEventTime: event.timestamp,
        availableAt: event.timestamp,
        receiveTime: event.timestamp,
        bid: next.observation.marketProbability,
        ask: next.observation.marketProbability,
      };
      const fills = this.shared.processMarketEvent(executable);
      this.hawk.refreshPosition(event.marketId, next.observation.selectionId);
      const guard = this.quoteGuard.lookup(next.observation);
      const maker = this.maker.onObservation(next.observation, guard, context);
      this.recordMakerDecision(maker, next.observation, sourceEventId, provenance);
      const hawk = this.hawk.onMovementHeuristic({
        observation: next.observation,
        movementHistory: next.movements,
        sourceEventId,
        receiveTime: event.timestamp,
        provenance,
        mode,
      });
      this.audit.push({
        timestamp: event.timestamp,
        mode,
        fixtureId: event.fixtureId,
        marketId: event.marketId,
        selectionId: next.observation.selectionId,
        makerAction: maker.latestAction,
        hawkAction: hawk.latestAction,
        filledDecisionIds: fills.map((fill) => fill.decisionId),
        quoteGuardAvailable: guard.available,
        quoteGuardChangedCentre: maker.quoteCentre !== null
          && round(maker.quoteCentre - maker.inventoryLean) !== round(maker.marketConsensusCentre ?? 0),
        noLookaheadVerified: true,
        realExecution: false,
      });
    }
    this.shared.decisionBook.assertNoLookahead();
  }

  settle(event: SettlementEvent): DecisionRecord[] {
    return this.shared.settle(event);
  }

  status() {
    return {
      controller: "MakerHawkController",
      displayName: "Bee Agent Controller",
      agentAutonomous: true,
      executionMode: "SHADOW",
      maker: this.maker.status(),
      hawk: this.hawk.status(),
      sharedRisk: this.shared.status(),
      decisionBook: this.shared.decisionBook.status(),
      quoteGuard: this.quoteGuard.status(),
      security: {
        network: "devnet",
        walletRuntime: "ABSENT",
        shadowExecution: true,
        realExecution: false,
        realFunds: false,
        mainnet: false,
        subscriptionActivation: false,
        directionalActions: "PAPER_ONLY",
        kelly: false,
      },
    };
  }

  private recordMakerDecision(status: MakerStatus, observation: AgentObservation, sourceEventId: string, provenance: string): void {
    const common = {
      fixtureId: observation.fixtureId,
      marketId: observation.marketId,
      selectionId: observation.selectionId,
      sourceEventId,
      sourceEventTime: observation.timestamp,
      receiveTime: observation.timestamp,
      dataCutoffTime: observation.timestamp,
      decisionTime: observation.timestamp,
      configuredLatencyMs: this.shared.shadowExecution.config.configuredLatencyMs,
      strategy: "maker",
      provenance,
      reasonCodes: [...status.reasonCodes],
      featureReferences: [{ eventId: sourceEventId, availableAt: observation.timestamp, kind: "MARKET_OBSERVATION" as const }],
    };
    if (status.latestAction === "SUSPEND" || status.latestAction === "CANCEL_QUOTES") {
      this.shared.decisionBook.cancelPendingQuotes(observation.marketId, observation.selectionId);
      const decision = this.shared.decisionBook.record({
        ...common,
        action: status.latestAction === "SUSPEND" ? "SUSPEND" : "CANCEL_PAPER_QUOTE",
        side: "NONE",
        proposedPrice: null,
        proposedSize: 0,
        status: status.latestAction === "SUSPEND" ? "SUSPENDED" : "CANCELLED",
      });
      this.maker.setLatestDecision(decision.decisionId);
      return;
    }
    if (status.latestAction === "RESUME") {
      const decision = this.shared.decisionBook.record({
        ...common,
        action: "RESUME",
        side: "NONE",
        proposedPrice: null,
        proposedSize: 0,
        status: "OPEN",
      });
      this.maker.setLatestDecision(decision.decisionId);
      return;
    }
    if (status.latestAction === "HOLD_QUOTES") {
      const decision = this.shared.decisionBook.record({
        ...common,
        action: "NO_TRADE",
        side: "NONE",
        proposedPrice: null,
        proposedSize: 0,
        status: "NO_TRADE",
      });
      this.maker.setLatestDecision(decision.decisionId);
      return;
    }
    if (status.bid === null || status.ask === null || status.size === null || status.size <= 0) return;
    const action: DecisionAction = status.latestAction === "PLACE_QUOTES" ? "PLACE_PAPER_QUOTE" : "REPLACE_PAPER_QUOTE";
    if (action === "REPLACE_PAPER_QUOTE") this.shared.decisionBook.cancelPendingQuotes(observation.marketId, observation.selectionId);
    for (const [side, price] of [["BUY", status.bid], ["SELL", status.ask]] as const) {
      const decision = this.shared.decisionBook.record({
        ...common,
        action,
        side,
        proposedPrice: price,
        proposedSize: status.size,
        status: "PENDING",
      });
      this.maker.setLatestDecision(decision.decisionId);
    }
  }
}
