import { createHash } from "node:crypto";

export type DecisionAction =
  | "PLACE_PAPER_QUOTE"
  | "REPLACE_PAPER_QUOTE"
  | "CANCEL_PAPER_QUOTE"
  | "OPEN_PAPER_POSITION"
  | "REDUCE_PAPER_POSITION"
  | "CLOSE_PAPER_POSITION"
  | "SUSPEND"
  | "RESUME"
  | "NO_TRADE";

export type DecisionSide = "BUY" | "SELL" | "NONE";
export type DecisionStatus = "PENDING" | "OPEN" | "FILLED" | "CANCELLED" | "NO_TRADE" | "SUSPENDED" | "SETTLED";
export type NoLookaheadVerificationStatus = "VERIFIED" | "FAILED";

export type DecisionRecord = {
  decisionId: string;
  fixtureId: string;
  marketId: string;
  selectionId: string;
  sourceEventId: string;
  sourceEventTime: string;
  receiveTime: string;
  dataCutoffTime: string;
  decisionTime: string;
  earliestExecutableTime: string;
  strategy: string;
  action: DecisionAction;
  side: DecisionSide;
  proposedPrice: number | null;
  proposedSize: number;
  reasonCodes: string[];
  status: DecisionStatus;
  fillEventId: string | null;
  fillTime: string | null;
  fillPrice: number | null;
  fees: number;
  slippage: number;
  realizedPnl: number;
  unrealizedPnl: number;
  noLookaheadVerificationStatus: NoLookaheadVerificationStatus;
  provenance: string;
};

export type FeatureReference = {
  eventId: string;
  availableAt: string;
  kind: "MARKET_OBSERVATION" | "COMPARABLE_MARKET_OBSERVATION" | "FINAL_RESULT" | "SCORE_EVENT" | "FUTURE_SCORE_EVENT";
};

export type RecordDecisionInput = Omit<DecisionRecord,
  | "decisionId"
  | "earliestExecutableTime"
  | "fillEventId"
  | "fillTime"
  | "fillPrice"
  | "fees"
  | "slippage"
  | "realizedPnl"
  | "unrealizedPnl"
  | "noLookaheadVerificationStatus"
> & {
  configuredLatencyMs: number;
  featureReferences: FeatureReference[];
};

export type ExecutableMarketEvent = {
  eventId: string;
  fixtureId: string;
  marketId: string;
  selectionId: string;
  sourceEventTime: string;
  availableAt: string;
  receiveTime: string;
  bid: number;
  ask: number;
};

export type SettlementEvent = {
  eventId: string;
  fixtureId: string;
  sourceEventTime: string;
  availableAt: string;
  isFinal: boolean;
  selectionPayouts: Record<string, number>;
};

function epoch(value: string, field: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`INVALID_DECISION_TIMESTAMP:${field}`);
  return result;
}

function round(value: number): number {
  return Number(value.toFixed(12));
}

function decisionIdentity(input: RecordDecisionInput): string {
  const material = [
    input.fixtureId,
    input.marketId,
    input.selectionId,
    input.sourceEventId,
    input.strategy,
    input.action,
    input.side,
    input.decisionTime,
  ].join("|");
  return `hive-${createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
}

function assertCausalInput(input: RecordDecisionInput): void {
  const decisionTime = epoch(input.decisionTime, "decisionTime");
  const sourceEventTime = epoch(input.sourceEventTime, "sourceEventTime");
  const receiveTime = epoch(input.receiveTime, "receiveTime");
  const cutoffTime = epoch(input.dataCutoffTime, "dataCutoffTime");
  if (sourceEventTime > cutoffTime || sourceEventTime > decisionTime || receiveTime > decisionTime || cutoffTime > decisionTime) {
    throw new Error("NO_LOOKAHEAD_VIOLATION:DECISION_REFERENCES_FUTURE_TIME");
  }
  if (!Number.isFinite(input.configuredLatencyMs) || input.configuredLatencyMs < 0) {
    throw new Error("INVALID_CONFIGURED_LATENCY");
  }
  if (!Number.isFinite(input.proposedSize) || input.proposedSize < 0) throw new Error("INVALID_PROPOSED_SIZE");
  if (input.proposedPrice !== null && (!Number.isFinite(input.proposedPrice) || input.proposedPrice <= 0 || input.proposedPrice >= 1)) {
    throw new Error("INVALID_PROPOSED_PRICE");
  }
  for (const feature of input.featureReferences) {
    if (feature.kind === "FINAL_RESULT" || feature.kind === "FUTURE_SCORE_EVENT") {
      throw new Error("NO_LOOKAHEAD_VIOLATION:PROHIBITED_FEATURE");
    }
    if (epoch(feature.availableAt, "feature.availableAt") > decisionTime) {
      throw new Error("NO_LOOKAHEAD_VIOLATION:FUTURE_FEATURE");
    }
  }
}

export class DecisionBook {
  private readonly records = new Map<string, DecisionRecord>();

  constructor(initialRecords: DecisionRecord[] = []) {
    for (const record of initialRecords) this.records.set(record.decisionId, { ...record, reasonCodes: [...record.reasonCodes] });
    this.assertNoLookahead();
  }

  record(input: RecordDecisionInput): DecisionRecord {
    assertCausalInput(input);
    const decisionId = decisionIdentity(input);
    const existing = this.records.get(decisionId);
    if (existing) return this.copy(existing);
    const decisionTime = epoch(input.decisionTime, "decisionTime");
    const status: DecisionStatus = input.action === "NO_TRADE"
      ? "NO_TRADE"
      : input.action === "SUSPEND"
        ? "SUSPENDED"
        : input.action === "CANCEL_PAPER_QUOTE"
          ? "CANCELLED"
          : input.status;
    const record: DecisionRecord = {
      decisionId,
      fixtureId: input.fixtureId,
      marketId: input.marketId,
      selectionId: input.selectionId,
      sourceEventId: input.sourceEventId,
      sourceEventTime: input.sourceEventTime,
      receiveTime: input.receiveTime,
      dataCutoffTime: input.dataCutoffTime,
      decisionTime: input.decisionTime,
      earliestExecutableTime: new Date(decisionTime + input.configuredLatencyMs).toISOString(),
      strategy: input.strategy,
      action: input.action,
      side: input.side,
      proposedPrice: input.proposedPrice,
      proposedSize: round(input.proposedSize),
      reasonCodes: [...input.reasonCodes],
      status,
      fillEventId: null,
      fillTime: null,
      fillPrice: null,
      fees: 0,
      slippage: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      noLookaheadVerificationStatus: "VERIFIED",
      provenance: input.provenance,
    };
    this.records.set(decisionId, record);
    return this.copy(record);
  }

  update(decisionId: string, update: Partial<Pick<DecisionRecord,
    "status" | "fillEventId" | "fillTime" | "fillPrice" | "fees" | "slippage" | "realizedPnl" | "unrealizedPnl"
  >>): DecisionRecord {
    const current = this.records.get(decisionId);
    if (!current) throw new Error(`UNKNOWN_DECISION:${decisionId}`);
    const next = { ...current, ...update };
    this.records.set(decisionId, next);
    return this.copy(next);
  }

  get(decisionId: string): DecisionRecord | null {
    const record = this.records.get(decisionId);
    return record ? this.copy(record) : null;
  }

  all(): DecisionRecord[] {
    return [...this.records.values()].map((record) => this.copy(record));
  }

  cancelPendingQuotes(marketId: string, selectionId: string): DecisionRecord[] {
    const cancelled: DecisionRecord[] = [];
    for (const record of this.records.values()) {
      if (record.strategy !== "maker" || record.marketId !== marketId || record.selectionId !== selectionId || record.status !== "PENDING") continue;
      cancelled.push(this.update(record.decisionId, { status: "CANCELLED" }));
    }
    return cancelled;
  }

  assertNoLookahead(): void {
    for (const record of this.records.values()) {
      if (epoch(record.sourceEventTime, "sourceEventTime") > epoch(record.dataCutoffTime, "dataCutoffTime")
        || epoch(record.dataCutoffTime, "dataCutoffTime") > epoch(record.decisionTime, "decisionTime")) {
        record.noLookaheadVerificationStatus = "FAILED";
        throw new Error(`NO_LOOKAHEAD_VIOLATION:${record.decisionId}`);
      }
      if (record.fillEventId === record.sourceEventId) {
        record.noLookaheadVerificationStatus = "FAILED";
        throw new Error(`SAME_EVENT_FILL_VIOLATION:${record.decisionId}`);
      }
      if (record.fillTime && epoch(record.fillTime, "fillTime") < epoch(record.earliestExecutableTime, "earliestExecutableTime")) {
        record.noLookaheadVerificationStatus = "FAILED";
        throw new Error(`LATENCY_VIOLATION:${record.decisionId}`);
      }
      record.noLookaheadVerificationStatus = "VERIFIED";
    }
  }

  status() {
    return {
      displayName: "Hive Decision Book",
      enabled: true,
      persistence: "IN_MEMORY_AND_REPLAY_SERIALIZABLE",
      executionMode: "SHADOW",
      decisionCount: this.records.size,
      noLookaheadVerificationStatus: this.all().every((record) => record.noLookaheadVerificationStatus === "VERIFIED") ? "VERIFIED" : "FAILED",
      realFundsEnabled: false,
    };
  }

  private copy(record: DecisionRecord): DecisionRecord {
    return { ...record, reasonCodes: [...record.reasonCodes] };
  }
}

type Position = {
  fixtureId: string;
  marketId: string;
  selectionId: string;
  quantity: number;
  averagePrice: number;
  fees: number;
  slippage: number;
};

export type ShadowExecutionConfig = {
  configuredLatencyMs: number;
  feeRate: number;
  slippageBps: number;
};

export class ShadowExecutionEngine {
  private readonly positions = new Map<string, Position>();

  constructor(readonly book: DecisionBook, readonly config: ShadowExecutionConfig) {
    if (config.configuredLatencyMs < 0 || config.feeRate < 0 || config.slippageBps < 0) throw new Error("INVALID_SHADOW_EXECUTION_CONFIG");
  }

  processMarketEvent(event: ExecutableMarketEvent): DecisionRecord[] {
    const filled: DecisionRecord[] = [];
    const eventTime = epoch(event.availableAt, "event.availableAt");
    for (const decision of this.book.all()) {
      if (decision.status !== "PENDING") continue;
      if (decision.marketId !== event.marketId || decision.selectionId !== event.selectionId) continue;
      if (decision.sourceEventId === event.eventId) continue;
      if (eventTime <= epoch(decision.decisionTime, "decisionTime")) continue;
      if (eventTime < epoch(decision.earliestExecutableTime, "earliestExecutableTime")) continue;
      const isMaker = decision.strategy === "maker";
      if (isMaker && !this.makerCrossed(decision, event)) continue;
      if (decision.side === "NONE" || decision.proposedPrice === null || decision.proposedSize <= 0) continue;
      const executable = decision.side === "BUY" ? event.ask : event.bid;
      const impact = executable * this.config.slippageBps / 10_000;
      const fillPrice = round(decision.side === "BUY" ? Math.min(0.999999, executable + impact) : Math.max(0.000001, executable - impact));
      const fees = round(fillPrice * decision.proposedSize * this.config.feeRate);
      const slippage = round(Math.abs(fillPrice - executable) * decision.proposedSize);
      this.applyFill(decision, fillPrice, fees, slippage);
      filled.push(this.book.update(decision.decisionId, {
        status: "FILLED",
        fillEventId: event.eventId,
        fillTime: event.availableAt,
        fillPrice,
        fees,
        slippage,
        realizedPnl: round(-fees - slippage),
        unrealizedPnl: round(-fees - slippage),
      }));
    }
    this.mark(event);
    this.book.assertNoLookahead();
    return filled;
  }

  settle(event: SettlementEvent): DecisionRecord[] {
    if (!event.isFinal) return [];
    const settled: DecisionRecord[] = [];
    for (const decision of this.book.all()) {
      if (decision.fixtureId !== event.fixtureId || decision.status !== "FILLED" || decision.fillPrice === null) continue;
      if (epoch(event.availableAt, "settlement.availableAt") <= epoch(decision.decisionTime, "decisionTime")) continue;
      const payout = event.selectionPayouts[decision.selectionId];
      if (!Number.isFinite(payout)) continue;
      const direction = decision.side === "BUY" ? 1 : -1;
      const realized = direction * decision.proposedSize * (payout! - decision.fillPrice) - decision.fees - decision.slippage;
      settled.push(this.book.update(decision.decisionId, {
        status: "SETTLED",
        realizedPnl: round(realized),
        unrealizedPnl: 0,
      }));
    }
    return settled;
  }

  position(marketId: string, selectionId: string): number {
    return this.positions.get(`${marketId}|${selectionId}`)?.quantity ?? 0;
  }

  grossExposure(): number {
    return [...this.positions.values()].reduce((sum, position) => sum + Math.abs(position.quantity), 0);
  }

  marketExposure(marketId: string): number {
    return [...this.positions.values()].filter((position) => position.marketId === marketId)
      .reduce((sum, position) => sum + Math.abs(position.quantity), 0);
  }

  fixtureExposure(fixtureId: string): number {
    return [...this.positions.values()].filter((position) => position.fixtureId === fixtureId)
      .reduce((sum, position) => sum + Math.abs(position.quantity), 0);
  }

  private makerCrossed(decision: DecisionRecord, event: ExecutableMarketEvent): boolean {
    if (decision.proposedPrice === null) return false;
    return decision.side === "BUY" ? event.ask <= decision.proposedPrice : event.bid >= decision.proposedPrice;
  }

  private applyFill(decision: DecisionRecord, fillPrice: number, fees: number, slippage: number): void {
    const key = `${decision.marketId}|${decision.selectionId}`;
    const current = this.positions.get(key) ?? {
      fixtureId: decision.fixtureId,
      marketId: decision.marketId,
      selectionId: decision.selectionId,
      quantity: 0,
      averagePrice: fillPrice,
      fees: 0,
      slippage: 0,
    };
    const signedSize = decision.side === "BUY" ? decision.proposedSize : -decision.proposedSize;
    const nextQuantity = current.quantity + signedSize;
    const sameDirection = current.quantity === 0 || Math.sign(current.quantity) === Math.sign(signedSize);
    const averagePrice = sameDirection && nextQuantity !== 0
      ? (Math.abs(current.quantity) * current.averagePrice + Math.abs(signedSize) * fillPrice) / (Math.abs(current.quantity) + Math.abs(signedSize))
      : current.averagePrice;
    this.positions.set(key, {
      ...current,
      quantity: round(nextQuantity),
      averagePrice: round(averagePrice),
      fees: round(current.fees + fees),
      slippage: round(current.slippage + slippage),
    });
  }

  private mark(event: ExecutableMarketEvent): void {
    const position = this.positions.get(`${event.marketId}|${event.selectionId}`);
    if (!position) return;
    const mid = (event.bid + event.ask) / 2;
    for (const decision of this.book.all()) {
      if (decision.status !== "FILLED" || decision.marketId !== event.marketId || decision.selectionId !== event.selectionId || decision.fillPrice === null) continue;
      const direction = decision.side === "BUY" ? 1 : -1;
      this.book.update(decision.decisionId, {
        unrealizedPnl: round(direction * decision.proposedSize * (mid - decision.fillPrice) - decision.fees - decision.slippage),
      });
    }
  }
}
