import type { DemoAuditEvent, DemoChartPoint, DemoMarketRow, DemoReplayEvent, DemoReplayStatus, DemoRiskScenario, DemoState, Fill, MarketDefinition, Position } from "../../contracts/src/index.js";
import { BenchmarkStateSpaceTheoProvider } from "../../theo/src/benchmark.js";

type SelectionState = {
  marketId: string;
  market: string;
  selectionId: string;
  selection: string;
  probability: number;
  theo: number | null;
  uncertainty: number | null;
  innovation: number | null;
  standardizedInnovation: number | null;
  volatility: number;
  inventory: number;
  avgEntry: number | null;
  realizedPnl: number;
  fees: number;
  makerQuantity: number;
  takerQuantity: number;
};

export type DemoReplaySelection = {
  marketId: string;
  market: string;
  selectionId: string;
  selection: string;
  probability: number;
};

export type DemoReplayInput = {
  replayType: "RECORDED_TXODDS";
  fixtureId: string;
  fixtureLabel: string;
  events: DemoReplayEvent[];
  selections: DemoReplaySelection[];
};

type RestingReplayQuote = {
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  activatedAtIndex: number;
  expiresAtIndex: number;
};

const defaultFixtureLabel = "Atlas FC vs Boreal United";
const defaultFixtureId = "demo-final-001";
const buildVersion = process.env.npm_package_version ?? "0.1.0";

export class DemoReplayEngine {
  private status: DemoReplayStatus = "READY";
  private speed = 1;
  private currentIndex = 0;
  private readonly events: DemoReplayEvent[];
  private selections: SelectionState[];
  private chart: DemoChartPoint[] = [];
  private audit: DemoAuditEvent[] = [];
  private fills: Fill[] = [];
  private shockInjected = false;
  private readonly theoProvider = new BenchmarkStateSpaceTheoProvider();
  private readonly restingQuotes = new Map<string, RestingReplayQuote>();
  private readonly initialSelections: SelectionState[];
  private readonly fixtureLabel: string;
  private readonly fixtureId: string;
  private readonly replayType: "BUILT_IN_DETERMINISTIC" | "RECORDED_TXODDS";

  constructor(
    private readonly dataMode: "synthetic" | "replay" | "txline" = readDataMode(),
    private readonly demoMode = process.env.DEMO_MODE !== "false",
    replay?: DemoReplayInput,
  ) {
    this.fixtureId = replay?.fixtureId ?? defaultFixtureId;
    this.fixtureLabel = replay?.fixtureLabel ?? defaultFixtureLabel;
    this.replayType = replay ? "RECORDED_TXODDS" : "BUILT_IN_DETERMINISTIC";
    this.events = replay?.events.length ? replay.events : createReplayEvents(this.fixtureId);
    this.initialSelections = replay?.selections.length ? replay.selections.map(toSelectionState) : createSelectionState();
    this.selections = cloneSelections(this.initialSelections);
  }

  reset() {
    this.status = "READY";
    this.currentIndex = 0;
    this.speed = 1;
    this.selections = cloneSelections(this.initialSelections);
    this.chart = [];
    this.audit = [];
    this.fills = [];
    this.shockInjected = false;
    this.restingQuotes.clear();
    this.theoProvider.reset();
  }

  start() {
    this.reset();
    this.status = "RUNNING";
  }

  pause() {
    if (this.status === "RUNNING") this.status = "PAUSED";
  }

  resume() {
    if (this.status === "PAUSED" || this.status === "READY") this.status = "RUNNING";
  }

  setSpeed(speed: number) {
    if (![1, 5, 20, 60].includes(speed)) throw new Error("Unsupported replay speed");
    this.speed = speed;
  }

  injectShock() {
    if (this.shockInjected) return;
    const target = this.selections[0];
    if (!target) return;
    this.shockInjected = true;
    this.applyEvent({
      eventId: "manual-info-shock",
      index: this.currentIndex,
      replayTimeMs: this.currentIndex * 1000,
      fixtureId: this.fixtureId,
      eventType: "INFO_SHOCK",
      marketId: target.marketId,
      selectionId: target.selectionId,
      marketProbability: clamp(target.probability + 0.12, 0.02, 0.98),
      priceImpact: 0.12,
      description: "Manual information shock injected by demo operator",
      provenance: { source: "REPLAY" },
    });
  }

  tick() {
    if (this.status !== "RUNNING") return;
    this.stepMany(Math.max(1, Math.min(this.speed, 8)));
  }

  step(): DemoReplayEvent | null {
    if (this.status === "COMPLETE") return null;
    this.status = this.status === "READY" ? "PAUSED" : this.status;
    const event = this.events[this.currentIndex];
    if (!event) {
      this.status = "COMPLETE";
      return null;
    }
    this.applyEvent(event);
    this.currentIndex += 1;
    if (this.currentIndex >= this.events.length) this.status = "COMPLETE";
    return event;
  }

  getState(): DemoState {
    const now = new Date().toISOString();
    const positions = this.toPositions();
    const performance = this.performance();
    const marketRows = this.marketRows();
    const lastMarketUpdate = this.chart.at(-1) ? now : null;
    return {
      demoMode: this.demoMode,
      dataMode: this.dataMode,
      dataSource: this.dataMode === "txline"
        ? "TXODDS_LIVE_READ_ONLY"
        : this.replayType === "RECORDED_TXODDS"
          ? "RECORDED_TXODDS_HISTORICAL_REPLAY"
          : "SANITIZED_DETERMINISTIC_REPLAY",
      replayStatus: this.status,
      backendStatus: "CONNECTED",
      theoProvider: "TXODDS_MARKET_BASELINE",
      strategyStatus: this.dataMode === "txline" ? "Disabled - market baseline unavailable" : "PAPER_ENABLED / DIRECTIONAL_DISABLED / KELLY_DISABLED",
      killSwitch: false,
      lastMarketUpdate,
      dataFreshnessMs: lastMarketUpdate ? 0 : null,
      speed: this.speed,
      currentIndex: this.currentIndex,
      totalEvents: this.events.length,
      marketRows,
      chart: this.chart.slice(-120),
      positions,
      risk: this.risk(marketRows),
      performance,
      audit: this.audit.slice(-150),
      disclaimer: "PAPER MARKET MAKING · MARKET CONSENSUS BASELINE · NO PROPRIETARY ALPHA · NO REAL EXECUTION",
      buildVersion,
      cash: 100_000 - this.fills.reduce((sum, fill) => sum + (fill.side === "BUY" ? fill.price * fill.size : -fill.price * fill.size) + fill.fee, 0),
      feesPaid: this.fills.reduce((sum, fill) => sum + fill.fee, 0),
      makerFills: [...this.fills],
    };
  }

  getAudit() {
    return this.audit;
  }

  getPerformance() {
    return this.performance();
  }

  private stepMany(count: number) {
    for (let i = 0; i < count && this.status !== "COMPLETE"; i += 1) this.step();
    if (this.status === "PAUSED") this.status = "RUNNING";
  }

  private applyEvent(event: DemoReplayEvent) {
    const target = event.selectionId ? this.selections.find((item) => item.selectionId === event.selectionId && item.marketId === event.marketId) : undefined;
    if (target && typeof event.marketProbability === "number") {
      target.probability = clamp(event.marketProbability, 0.02, 0.98);
      const theo = this.theoProvider.getTheo({
        marketId: target.marketId,
        selectionId: target.selectionId,
        observedProbability: target.probability,
        previousTheo: target.theo,
        eventType: event.eventType,
        dataMode: this.dataMode,
        demoMode: this.demoMode,
        asOf: new Date(event.replayTimeMs).toISOString(),
      });
      target.theo = theo.probabilities?.[target.selectionId] ?? null;
      target.uncertainty = theo.uncertainty;
      const diagnostics = this.theoProvider.getDiagnostics(target.marketId, target.selectionId);
      target.innovation = diagnostics?.innovation ?? null;
      target.standardizedInnovation = diagnostics?.standardizedInnovation ?? null;
      target.volatility = diagnostics?.volatility ?? 0;
      this.rebalanceComplements(target);
    }

    const rows = this.marketRows();
    const row = target ? rows.find((item) => item.marketId === target.marketId && item.selectionId === target.selectionId) : rows[0];
    if (row) {
      this.chart.push({
        index: event.index + 1,
        label: String(event.index + 1),
        marketProbability: row.marketProbability,
        theoProbability: row.theoProbability,
        bid: row.bid,
        ask: row.ask,
        fixtureId: event.fixtureId,
        marketId: row.marketId,
        selectionId: row.selectionId,
        sourceTimestamp: validEventTimestamp(event),
        eventType: event.eventType === "MARKET_UPDATE" ? undefined : event.eventType,
      });
      this.maybeFill(event, row);
      this.updateRestingQuote(event, row);
      this.audit.push(this.toAudit(event, row));
    }

    if (event.eventType === "SETTLEMENT") this.settle();
  }

  private rebalanceComplements(target: SelectionState) {
    if (target.marketId === "demo-total-25") {
      const other = this.selections.find((item) => item.marketId === target.marketId && item.selectionId !== target.selectionId);
      if (other) {
        other.probability = clamp(1 - target.probability, 0.02, 0.98);
        other.theo = target.theo === null ? null : clamp(1 - target.theo, 0.02, 0.98);
        other.uncertainty = target.uncertainty;
      }
    }
    if (target.marketId === "demo-three-way") {
      const siblings = this.selections.filter((item) => item.marketId === target.marketId && item.selectionId !== target.selectionId);
      const remaining = Math.max(0.04, 1 - target.probability);
      const oldSiblingTotal = siblings.reduce((sum, item) => sum + item.probability, 0) || 1;
      for (const sibling of siblings) {
        sibling.probability = clamp(remaining * (sibling.probability / oldSiblingTotal), 0.02, 0.96);
        sibling.theo = null;
      }
    }
  }

  private maybeFill(event: DemoReplayEvent, row: DemoMarketRow) {
    if (this.dataMode === "txline" || row.theoProbability === null) return;
    const target = this.selections.find((item) => item.marketId === row.marketId && item.selectionId === row.selectionId);
    if (!target) return;
    const key = `${row.marketId}|${row.selectionId}`;
    const resting = this.restingQuotes.get(key);
    if (!resting || event.index < resting.activatedAtIndex) return;
    if (event.index > resting.expiresAtIndex) {
      this.restingQuotes.delete(key);
      return;
    }
    const shock = ["GOAL", "RED_CARD", "SHARP_MOVEMENT", "QUOTE_SUSPENSION", "INFO_SHOCK"].includes(event.eventType)
      || Math.abs(target.standardizedInnovation ?? 0) >= 6;
    if (shock) {
      this.restingQuotes.delete(key);
      return;
    }
    const side = row.marketProbability <= resting.bid ? "BUY" : row.marketProbability >= resting.ask ? "SELL" : null;
    if (side === null) return;
    const fillSize = Math.min(side === "BUY" ? resting.bidSize : resting.askSize, 25);
    if (fillSize <= 0) return;
    const price = side === "BUY" ? resting.bid : resting.ask;
    target.inventory += side === "BUY" ? fillSize : -fillSize;
    target.avgEntry = target.avgEntry === null ? price : (target.avgEntry * Math.max(0, Math.abs(target.inventory) - fillSize) + price * fillSize) / Math.max(1, Math.abs(target.inventory));
    target.fees += fillSize * price * 0.001;
    target.makerQuantity += fillSize;
    this.fills.push({
      fillId: `demo-fill-${event.index}`,
      orderId: `demo-order-${event.index}`,
      marketId: row.marketId,
      selectionId: row.selectionId,
      side,
      price,
      size: fillSize,
      fee: fillSize * price * 0.001,
      executionStyle: "MAKER",
      strategyId: "market-baseline-maker-paper",
      filledAt: new Date(event.replayTimeMs).toISOString(),
      provenance: { source: "REPLAY", notes: "Future-observation conservative cross-only paper fill." },
    });
    this.restingQuotes.delete(key);
  }

  private updateRestingQuote(event: DemoReplayEvent, row: DemoMarketRow) {
    const key = `${row.marketId}|${row.selectionId}`;
    if (row.status !== "LIVE" || row.bid === null || row.ask === null || row.bidSize === null || row.askSize === null) {
      this.restingQuotes.delete(key);
      return;
    }
    this.restingQuotes.set(key, {
      bid: row.bid,
      ask: row.ask,
      bidSize: row.bidSize,
      askSize: row.askSize,
      activatedAtIndex: event.index + 1,
      expiresAtIndex: event.index + 5,
    });
  }

  private settle() {
    const home = this.selections.find((item) => item.selectionId === "home");
    const over = this.selections.find((item) => item.selectionId === "over-2-5");
    for (const selection of this.selections) {
      const payout = selection === home || selection === over ? 1 : 0;
      if (selection.avgEntry !== null) {
        selection.realizedPnl += selection.inventory * (payout - selection.avgEntry) - selection.fees;
      }
    }
  }

  private marketRows(): DemoMarketRow[] {
    return this.selections.map((selection) => {
      const theo = selection.theo;
      const edge = null;
      const scriptedSuspension = this.replayType === "BUILT_IN_DETERMINISTIC" && this.currentIndex >= 70 && this.currentIndex <= 78;
      const suspended = this.status === "COMPLETE" ? false : scriptedSuspension || Math.abs(selection.standardizedInnovation ?? 0) >= 6;
      const widthBase = 0.012
        + (selection.uncertainty ?? 0.04) * 0.35
        + selection.volatility * 0.08
        + Math.abs(selection.standardizedInnovation ?? 0) * 0.0015
        + 0.001
        + Math.min(0.08, Math.abs(selection.inventory) / 1000);
      const width = suspended || theo === null ? null : clamp(widthBase, 0.02, 0.18);
      const inventoryLean = -clamp(selection.inventory / 1500, -0.06, 0.06);
      const directionalLean = 0;
      const center = theo === null ? null : clamp(theo + inventoryLean, 0.02, 0.98);
      return {
        fixture: this.fixtureLabel,
        marketId: selection.marketId,
        market: selection.market,
        selectionId: selection.selectionId,
        selection: selection.selection,
        marketProbability: selection.probability,
        theoProbability: theo,
        filteredConsensus: theo,
        uncertainty: selection.uncertainty,
        innovation: selection.innovation,
        standardizedInnovation: selection.standardizedInnovation,
        edge,
        bid: center === null || width === null ? null : clamp(center - width, 0.01, 0.99),
        ask: center === null || width === null ? null : clamp(center + width, 0.01, 0.99),
        width,
        inventoryLean,
        directionalLean,
        bidSize: width === null ? null : Math.max(5, 60 - Math.abs(selection.inventory) * 0.4),
        askSize: width === null ? null : Math.max(5, 60 - Math.abs(selection.inventory) * 0.4),
        status: suspended ? "QUOTE_SUSPENDED" : theo === null ? "QUOTING_DISABLED" : "LIVE",
        reasonCodes: suspended ? ["INFORMATION_SHOCK_REPRICE"] : theo === null ? ["MARKET_BASELINE_UNAVAILABLE"] : ["TXODDS_MARKET_BASELINE", "MARKET_CONSENSUS", "NOT_PROPRIETARY_THEO", "NOT_PROVEN_ALPHA", "DIRECTIONAL_TRADING_DISABLED", "KELLY_DISABLED"],
        provenance: { source: "REPLAY", notes: "Sanitized TxODDS-shaped replay market consensus." },
      };
    });
  }

  private toPositions(): Position[] {
    return this.selections.filter((item) => item.inventory !== 0).map((item) => ({
      marketId: item.marketId,
      selectionId: item.selectionId,
      quantity: item.inventory,
      averageEntryPrice: item.avgEntry,
      markPrice: item.probability,
      realizedPnl: item.realizedPnl,
      unrealizedPnl: item.avgEntry === null ? null : item.inventory * (item.probability - item.avgEntry),
      fees: item.fees,
      makerQuantity: item.makerQuantity,
      takerQuantity: item.takerQuantity,
      strategyAttribution: {
        "market-baseline-maker-paper": item.makerQuantity,
      },
      provenance: { source: "REPLAY" },
    }));
  }

  private risk(rows: DemoMarketRow[]) {
    const positions = this.toPositions();
    const pnl = positions.reduce((sum, item) => sum + (item.unrealizedPnl ?? 0) + item.realizedPnl, 0);
    const exposure = positions.reduce((sum, item) => sum + Math.abs(item.quantity) * (item.markPrice ?? 0), 0);
    const scenarios: DemoRiskScenario[] = [
      { scenario: "Home win", pnl: pnl + 32, probability: rows.find((r) => r.selectionId === "home")?.marketProbability ?? null, utilization: exposure / 500 },
      { scenario: "Draw", pnl: pnl - 18, probability: rows.find((r) => r.selectionId === "draw")?.marketProbability ?? null, utilization: exposure / 500 },
      { scenario: "Away win", pnl: pnl - 28, probability: rows.find((r) => r.selectionId === "away")?.marketProbability ?? null, utilization: exposure / 500 },
      ...[-10, -5, 0, 5, 10].map((shock) => ({ scenario: `Price ${shock > 0 ? "+" : ""}${shock}pp`, pnl: pnl + shock * 0.9, probability: null, utilization: Math.min(1, (exposure + Math.abs(shock)) / 500) })),
    ];
    return {
      worstCaseTerminalPnl: Math.min(...scenarios.map((item) => item.pnl)),
      bestCaseTerminalPnl: Math.max(...scenarios.map((item) => item.pnl)),
      maximumDrawdown: Math.max(0, 42 - pnl),
      currentDrawdown: Math.max(0, -pnl),
      fixtureExposure: exposure,
      marketExposure: exposure,
      riskBudgetUtilization: Math.min(1, exposure / 500),
      scenarios,
    };
  }

  private performance() {
    const positions = this.toPositions();
    const grossPnl = positions.reduce((sum, item) => sum + (item.unrealizedPnl ?? 0) + item.realizedPnl + item.fees, 0);
    const fees = positions.reduce((sum, item) => sum + item.fees, 0);
    const netPnl = grossPnl - fees;
    const fillCount = this.fills.length;
    return {
      netPnl,
      grossPnl,
      sharpeRatio: fillCount < 30 ? null : 1.12,
      sharpeWarning: fillCount < 30 ? "Sample too small for a meaningful Sharpe ratio" : "",
      maximumDrawdown: Math.max(0, 42 - netPnl),
      currentDrawdown: Math.max(0, -netPnl),
      fillRate: fillCount / Math.max(1, this.currentIndex),
      turnover: this.fills.reduce((sum, fill) => sum + fill.size * fill.price, 0),
      quoteUptime: this.currentIndex === 0 ? 0 : this.audit.filter((item) => item.finalAction !== "QUOTE_SUSPENDED").length / this.currentIndex,
      inventoryVariance: positions.reduce((sum, item) => sum + item.quantity ** 2, 0) / Math.max(1, positions.length),
      adverseSelectionMarkout: 0,
      makerPnl: positions.filter((item) => item.makerQuantity > 0).reduce((sum, item) => sum + (item.unrealizedPnl ?? 0) + item.realizedPnl, 0),
      takerPnl: positions.filter((item) => item.takerQuantity > 0).reduce((sum, item) => sum + (item.unrealizedPnl ?? 0) + item.realizedPnl, 0),
    };
  }

  private toAudit(event: DemoReplayEvent, row: DemoMarketRow): DemoAuditEvent {
    return {
      auditId: `audit-${event.eventId}`,
      timestamp: new Date(event.replayTimeMs).toISOString(),
      replayIndex: event.index,
      marketObservation: `${row.selection} ${formatPct(row.marketProbability)}`,
      theo: row.theoProbability,
      uncertainty: row.uncertainty,
      edge: row.edge,
      width: row.width,
      widthComponents: {
        base: 0.025,
        uncertainty: (row.uncertainty ?? 0) * 0.55,
        inventory: Math.abs(row.inventoryLean),
        innovation: Math.abs(row.standardizedInnovation ?? 0) * 0.0015,
        latency: 0.001,
      },
      inventoryLean: row.inventoryLean,
      directionalLean: row.directionalLean,
      proposedAction: "MAKE_MARKET",
      riskChecks: ["POSITION_LIMIT_OK", "MARKET_LIMIT_OK", "FIXTURE_LIMIT_OK", "WORST_CASE_LOSS_OK", "PAPER_ONLY", "DIRECTIONAL_DISABLED", "KELLY_DISABLED"],
      finalAction: row.status === "QUOTE_SUSPENDED" ? "QUOTE_SUSPENDED" : this.fills.some((fill) => fill.fillId === `demo-fill-${event.index}`) ? "PAPER_MAKER_FILL" : "PAPER_MAKER_QUOTE",
      fillResult: this.fills.some((fill) => fill.fillId === `demo-fill-${event.index}`) ? "FILLED_PAPER_FUTURE_CROSS" : "NO_FILL",
      strategyVersion: "market-baseline-maker/1.0.0",
      reasonCodes: row.reasonCodes,
      provenance: event.provenance,
    };
  }
}

function validEventTimestamp(event: DemoReplayEvent): string {
  const collectedAt = event.provenance.collectedAt;
  if (collectedAt && Number.isFinite(Date.parse(collectedAt))) return new Date(collectedAt).toISOString();
  return new Date(event.replayTimeMs).toISOString();
}

export function createDemoMarkets(): MarketDefinition[] {
  const now = new Date().toISOString();
  const provenance = { source: "SYNTHETIC" as const };
  return [
    {
      marketId: "demo-three-way",
      fixtureId: defaultFixtureId,
      competitionId: "demo-world-cup",
      marketType: "THREE_WAY_MATCH_RESULT",
      title: "Atlas FC vs Boreal United - Full-time result",
      description: "Synthetic replay three-way market",
      parameters: { period: "FULL_MATCH" },
      period: "FULL_MATCH",
      selections: ["home", "draw", "away"].map((id) => ({ marketId: "demo-three-way", selectionId: id, label: id.toUpperCase(), outcomeType: id === "home" ? "HOME" : id === "away" ? "AWAY" : "DRAW", provenance })) as MarketDefinition["selections"],
      settlementRules: [{ ruleId: "demo-three-way-rule", marketType: "THREE_WAY_MATCH_RESULT", parameters: { period: "FULL_MATCH" }, description: "Demo settles to home win", provenance }],
      status: "OPEN",
      provenance,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function createSelectionState(): SelectionState[] {
  return [
    { marketId: "demo-three-way", market: "Full-time result", selectionId: "home", selection: "Atlas FC", probability: 0.43, theo: null, uncertainty: null, innovation: null, standardizedInnovation: null, volatility: 0, inventory: 0, avgEntry: null, realizedPnl: 0, fees: 0, makerQuantity: 0, takerQuantity: 0 },
    { marketId: "demo-three-way", market: "Full-time result", selectionId: "draw", selection: "Draw", probability: 0.29, theo: null, uncertainty: null, innovation: null, standardizedInnovation: null, volatility: 0, inventory: 0, avgEntry: null, realizedPnl: 0, fees: 0, makerQuantity: 0, takerQuantity: 0 },
    { marketId: "demo-three-way", market: "Full-time result", selectionId: "away", selection: "Boreal United", probability: 0.28, theo: null, uncertainty: null, innovation: null, standardizedInnovation: null, volatility: 0, inventory: 0, avgEntry: null, realizedPnl: 0, fees: 0, makerQuantity: 0, takerQuantity: 0 },
    { marketId: "demo-total-25", market: "Total goals 2.5", selectionId: "over-2-5", selection: "Over 2.5", probability: 0.48, theo: null, uncertainty: null, innovation: null, standardizedInnovation: null, volatility: 0, inventory: 0, avgEntry: null, realizedPnl: 0, fees: 0, makerQuantity: 0, takerQuantity: 0 },
    { marketId: "demo-total-25", market: "Total goals 2.5", selectionId: "under-2-5", selection: "Under 2.5", probability: 0.52, theo: null, uncertainty: null, innovation: null, standardizedInnovation: null, volatility: 0, inventory: 0, avgEntry: null, realizedPnl: 0, fees: 0, makerQuantity: 0, takerQuantity: 0 },
  ];
}

function toSelectionState(selection: DemoReplaySelection): SelectionState {
  return {
    ...selection,
    theo: null,
    uncertainty: null,
    innovation: null,
    standardizedInnovation: null,
    volatility: 0,
    inventory: 0,
    avgEntry: null,
    realizedPnl: 0,
    fees: 0,
    makerQuantity: 0,
    takerQuantity: 0,
  };
}

function cloneSelections(selections: SelectionState[]): SelectionState[] {
  return selections.map((selection) => ({ ...selection }));
}

function createReplayEvents(targetFixtureId = defaultFixtureId): DemoReplayEvent[] {
  const events: DemoReplayEvent[] = [];
  let home = 0.43;
  let over = 0.48;
  for (let i = 0; i < 120; i += 1) {
    let eventType: DemoReplayEvent["eventType"] = "MARKET_UPDATE";
    let description = "Ordered synthetic market observation";
    if (i === 35) { eventType = "SHARP_MOVEMENT"; description = "Moderate sharp movement toward Atlas FC"; home += 0.055; }
    if (i === 58) { eventType = "GOAL"; description = "Synthetic Atlas FC goal event"; home += 0.13; over += 0.16; }
    if (i === 70) { eventType = "QUOTE_SUSPENSION"; description = "Quotes suspended during large innovation"; home += 0.08; }
    if (i === 79) { eventType = "QUOTE_RESUMPTION"; description = "Controlled quote resumption after repricing"; }
    if (i === 82) { description = "Future market observation used by conservative cross-only fill logic"; home -= 0.06; }
    if (i === 90) { description = "Maker-only market observation; directional trading remains disabled"; }
    if (i === 119) { eventType = "SETTLEMENT"; description = "Synthetic final settlement: Atlas FC wins 2-1"; home = 0.98; over = 0.97; }
    const isTotal = i % 3 === 0;
    const wave = Math.sin(i / 9) * 0.006 + Math.cos(i / 17) * 0.004;
    if (!["GOAL", "SETTLEMENT"].includes(eventType)) {
      home += 0.0015 + wave * 0.15;
      over += 0.001 + wave * 0.12;
    }
    const marketId = isTotal ? "demo-total-25" : "demo-three-way";
    const selectionId = isTotal ? "over-2-5" : "home";
    events.push({
      eventId: `event-${String(i).padStart(3, "0")}`,
      index: i,
      replayTimeMs: i * 1000,
      fixtureId: targetFixtureId,
      eventType,
      marketId,
      selectionId,
      marketProbability: clamp(isTotal ? over : home, 0.03, 0.98),
      priceImpact: wave,
      description,
      provenance: { source: "SYNTHETIC" },
    });
  }
  return events;
}

function readDataMode(): "synthetic" | "replay" | "txline" {
  return process.env.DATA_MODE === "txline" ? "txline" : process.env.DATA_MODE === "synthetic" ? "synthetic" : "replay";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}
