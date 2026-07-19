import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defaultRiskLimits } from "./sample-data.js";
import type { DemoAuditEvent, DemoMarketRow, DemoReplayEvent, DemoState, MarketDefinition } from "../../../packages/contracts/src/index.js";
import { DemoReplayEngine, type DemoReplayInput } from "../../../packages/demo/src/engine.js";
import {
  invalidConfigStatus,
  mapOddsUpdateToMarket,
  resolveDataRuntimeConfig,
  selectMarketProbabilities,
  toNormalizedMarketObservation,
  TxlineReadOnlyAdapter,
  type DataRuntimeConfig,
  type NormalizedEvent,
  type TxlineOddsUpdate,
} from "../../../packages/market-data/src/index.js";
import {
  assertMarketBaselineStartupSafe,
  LiveMarketBaselineRuntime,
  resolveMarketBaselineRuntimeConfig,
} from "../../../packages/live-market-baseline/src/index.js";
import {
  DualStrategyController,
  loadAdaptiveQuoteGuard,
  sanitizeMarketUpdate,
  type SanitizedMarketEvent,
} from "../../../packages/live-agents/src/index.js";

export class ProductRuntime {
  readonly dataConfig: DataRuntimeConfig;
  readonly baselineConfig;
  demo: DemoReplayEngine;
  readonly live: LiveMarketBaselineRuntime | null;
  readonly adapter: TxlineReadOnlyAdapter | null;
  readonly agents: DualStrategyController;
  private readonly recordedReplay: DemoReplayInput | null;
  private readonly liveFixtureLabel: string;
  private readonly historicalFixtureLabel: string;
  private selectedReplay = "built-in";
  private abortController: AbortController | null = null;
  private replayTimer: ReturnType<typeof setInterval> | null = null;
  private startupError: string | null = null;
  private replayRunSequence = 0;
  private replayRunId = "replay-0";

  constructor(private readonly env: Record<string, string | undefined> = process.env) {
    this.dataConfig = resolveDataRuntimeConfig(env);
    this.baselineConfig = resolveMarketBaselineRuntimeConfig(env);
    assertMarketBaselineStartupSafe(this.baselineConfig);
    const historicalPath = env.REPLAY_FILE ?? "data/samples/txodds/replay/england-france-third-place.json";
    this.recordedReplay = loadRecordedReplay(historicalPath);
    this.liveFixtureLabel = loadFixtureLabel(
      env.CURRENT_FIXTURE_FILE ?? "data/samples/txodds/current/argentina-spain.json",
      "Live",
    ) ?? "Live fixture unavailable";
    this.historicalFixtureLabel = loadFixtureLabel(historicalPath, "Historical") ?? "Historical replay unavailable";
    this.demo = new DemoReplayEngine("replay", true);
    this.agents = new DualStrategyController(loadAdaptiveQuoteGuard(path.resolve(
      "data/samples/demo/adaptive-quote-guard",
    )), { ...defaultRiskLimits });
    this.agents.reset(this.nextReplayRunId());
    if (this.dataConfig.valid && this.dataConfig.mode === "txline") {
      this.adapter = new TxlineReadOnlyAdapter(this.dataConfig);
      this.live = new LiveMarketBaselineRuntime(this.baselineConfig, { ...defaultRiskLimits });
    } else {
      this.adapter = null;
      this.live = null;
    }
  }

  get mode(): "replay" | "txline" | "invalid" {
    return this.dataConfig.valid ? this.dataConfig.mode : "invalid";
  }

  async start(): Promise<void> {
    if (!this.adapter || !this.live) return;
    try {
      this.live.setConnectionStatus("CONNECTING");
      await this.adapter.connect();
      this.live.setConnectionStatus(this.adapter.status);
      const capture = await this.adapter.captureLiveSnapshot();
      for (const event of capture.oddsEvents) await this.onEvent(event);
      this.abortController = new AbortController();
      void this.adapter.streamOddsEvents(async (update, receivedAt) => {
        const event = this.adapter!.store.appendRaw({
          receivedAt,
          transport: "sse",
          endpoint: "/api/odds/stream",
          body: update,
          dataMode: "TXODDS",
        });
        if (event) await this.onEvent(event);
      }, this.abortController.signal).catch((error) => {
        this.startupError = error instanceof Error ? error.message : String(error);
        this.live?.setConnectionStatus(this.adapter?.status ?? "DEGRADED");
      });
    } catch (error) {
      this.startupError = error instanceof Error ? error.message : String(error);
      this.live.setConnectionStatus(this.adapter.status);
    }
  }

  stop(): void {
    this.abortController?.abort();
    this.stopReplayTimer();
  }

  replays() {
    return {
      selected: this.mode === "txline" ? "live-current" : this.selectedReplay,
      options: [
        { id: "live-current", label: this.liveFixtureLabel, available: this.mode === "txline", sourceType: "LIVE_TXODDS" },
        { id: "historical-recorded", label: this.historicalFixtureLabel, available: this.mode === "replay" && this.recordedReplay !== null, sourceType: "RECORDED_TXODDS_REPLAY" },
        { id: "built-in", label: "Built-in deterministic fallback", available: this.mode === "replay", sourceType: "DETERMINISTIC_REPLAY" },
      ],
    };
  }

  selectReplay(replayId: string): DemoState {
    if (this.mode !== "replay") throw new Error("REPLAY_CONTROLS_DISABLED_IN_TXLINE_MODE");
    this.stopReplayTimer();
    this.agents.reset(this.nextReplayRunId());
    if (replayId === "built-in") {
      this.selectedReplay = replayId;
      this.demo = new DemoReplayEngine("replay", true);
      return this.demo.getState();
    }
    if ((replayId === "historical-recorded" || replayId === "recorded-txodds") && this.recordedReplay) {
      this.selectedReplay = "historical-recorded";
      this.demo = new DemoReplayEngine("replay", true, this.recordedReplay);
      return this.demo.getState();
    }
    if (replayId === "live-current") throw new Error("LIVE_SOURCE_REQUIRES_TXLINE_MODE");
    throw new Error(replayId === "historical-recorded" || replayId === "recorded-txodds" ? "RECORDED_REPLAY_UNAVAILABLE" : "UNKNOWN_REPLAY");
  }

  private async onEvent(event: NormalizedEvent): Promise<void> {
    if (!this.live) return;
    const market = mapOddsUpdateToMarket(event.update, "TXODDS");
    await this.live.onObservation(market, toNormalizedMarketObservation(event));
    this.agents.ingest(sanitizeMarketUpdate(event.update), "LIVE", market, {
      runId: "live",
      eventIndex: this.agents.audit.length + 1,
      provenance: "SANITIZED_TXODDS",
    });
  }

  startReplay(): DemoState {
    this.assertReplayMode();
    this.stopReplayTimer();
    this.agents.reset(this.nextReplayRunId());
    this.demo.start();
    this.processNextReplayEvent();
    this.scheduleReplay();
    return this.state();
  }

  pauseReplay(): DemoState {
    this.assertReplayMode();
    this.stopReplayTimer();
    this.demo.pause();
    return this.state();
  }

  resumeReplay(): DemoState {
    this.assertReplayMode();
    this.demo.resume();
    this.processNextReplayEvent();
    this.scheduleReplay();
    return this.state();
  }

  resetReplay(): DemoState {
    this.assertReplayMode();
    this.stopReplayTimer();
    this.demo.reset();
    this.agents.reset(this.nextReplayRunId());
    return this.state();
  }

  stepReplay(): DemoState {
    this.assertReplayMode();
    this.stopReplayTimer();
    this.demo.pause();
    this.processNextReplayEvent();
    return this.state();
  }

  setReplaySpeed(speed: number): DemoState {
    this.assertReplayMode();
    this.demo.setSpeed(speed);
    return this.state();
  }

  private assertReplayMode(): void {
    if (this.mode !== "replay") throw new Error("REPLAY_CONTROLS_DISABLED_IN_TXLINE_MODE");
  }

  private processNextReplayEvent(): void {
    const event = this.demo.step();
    if (!event) {
      this.stopReplayTimer();
      return;
    }
    this.agents.ingest(toSanitizedReplayEvent(event), "REPLAY", undefined, {
      runId: this.replayRunId,
      eventIndex: this.demo.getState().currentIndex,
      provenance: this.selectedReplay === "historical-recorded" ? "RECORDED_TXODDS_REPLAY" : "DETERMINISTIC_REPLAY",
    });
  }

  private scheduleReplay(): void {
    this.stopReplayTimer();
    if (this.demo.getState().replayStatus !== "RUNNING") return;
    this.replayTimer = setInterval(() => {
      const count = Math.max(1, Math.min(this.demo.getState().speed, 8));
      for (let index = 0; index < count && this.demo.getState().replayStatus !== "COMPLETE"; index += 1) {
        this.processNextReplayEvent();
      }
      if (this.demo.getState().replayStatus === "COMPLETE") this.stopReplayTimer();
    }, 800);
    this.replayTimer.unref?.();
  }

  private stopReplayTimer(): void {
    if (this.replayTimer) clearInterval(this.replayTimer);
    this.replayTimer = null;
  }

  private nextReplayRunId(): string {
    this.replayRunSequence += 1;
    this.replayRunId = `replay-${this.replayRunSequence}`;
    return this.replayRunId;
  }

  dataStatus() {
    if (!this.dataConfig.valid) return invalidConfigStatus(this.dataConfig);
    if (this.dataConfig.mode === "replay") {
      return {
        status: "CONNECTED",
        display: this.selectedReplay === "historical-recorded" ? "Sanitized recorded TxODDS historical replay" : "Deterministic sanitized replay",
        mode: "replay",
        network: "local",
        readOnly: true,
        reasonCodes: [],
        labels: ["Replay connected"],
      };
    }
    return {
      ...this.adapter!.getSystemDataStatus(),
      startupError: this.startupError,
    };
  }

  theoStatus() {
    if (!this.baselineConfig.enabled || !this.baselineConfig.valid) {
      return {
        status: "UNAVAILABLE",
        provenance: "TXODDS_MARKET_BASELINE",
        independentAlpha: false,
        reasonCodes: this.baselineConfig.reasonCodes,
      };
    }
    if (this.mode === "replay") {
      return {
        status: "AVAILABLE_BENCHMARK",
        provenance: "TXODDS_MARKET_BASELINE",
        modelVersion: "market-consensus-filter/1.0.0",
        independentAlpha: false,
        labels: ["MARKET_CONSENSUS", "NOT_PROPRIETARY_THEO", "NOT_PROVEN_ALPHA"],
        reasonCodes: ["SANITIZED_REPLAY_MARKET_BASELINE"],
      };
    }
    return this.live?.status().theo ?? {
      status: "UNAVAILABLE",
      provenance: "TXODDS_MARKET_BASELINE",
      independentAlpha: false,
      reasonCodes: ["TXODDS_CONFIGURATION_INVALID"],
    };
  }

  tradingStatus() {
    const available = this.baselineConfig.enabled
      && this.baselineConfig.valid
      && (this.mode === "replay" || this.live?.status().trading.maker === "PAPER_ENABLED");
    return {
      maker: available ? "PAPER_ENABLED" : "DISABLED",
      directional: "DISABLED_NON_INDEPENDENT_THEO",
      kelly: "DISABLED_NON_INDEPENDENT_THEO",
      kellyImplemented: true,
      kellyEnabled: false,
      realExecution: "DISABLED",
      walletOperations: "DISABLED",
      subscriptionActivation: "DISABLED",
      fillModel: "CONSERVATIVE_CROSS_ONLY",
      estimatedEdge: null,
      directionalAction: "NO_ACTION",
      kellySize: null,
      labels: ["PAPER MARKET MAKING", "DIRECTIONAL TRADING DISABLED", "KELLY AVAILABLE BUT LOCKED", "NO REAL EXECUTION"],
      reasonCodes: ["INDEPENDENT_THEO_UNAVAILABLE", "MARKET_BASELINE_IS_NOT_ALPHA", "KELLY_DISABLED"],
    };
  }

  state(): DemoState {
    if (this.mode !== "txline" || !this.live) return synchronizedReplayState(this.demo.getState(), this.agents.maker.status());
    return liveState(this.live, this.dataStatus());
  }
}

function synchronizedReplayState(state: DemoState, maker: ReturnType<DualStrategyController["maker"]["status"]>): DemoState {
  const observation = maker.currentMarketObservation;
  if (!observation || maker.eventIndex !== state.currentIndex) return state;
  const quote = maker.activeQuote;
  const marketRows = state.marketRows.map((row) => row.marketId === observation.marketId && row.selectionId === observation.selectionId
    ? {
        ...row,
        bid: quote?.status === "ACTIVE" ? quote.bid : null,
        ask: quote?.status === "ACTIVE" ? quote.ask : null,
        width: quote?.status === "ACTIVE" ? quote.width : null,
        bidSize: quote?.status === "ACTIVE" ? quote.size : null,
        askSize: quote?.status === "ACTIVE" ? quote.size : null,
        status: quote?.status ?? "QUOTING_DISABLED",
        reasonCodes: [...maker.reasonCodes],
      }
    : row);
  const chart = state.chart.map((point) => point.index === maker.eventIndex
    && point.marketId === observation.marketId
    && point.selectionId === observation.selectionId
    ? {
        ...point,
        bid: quote?.status === "ACTIVE" ? quote.bid : null,
        ask: quote?.status === "ACTIVE" ? quote.ask : null,
      }
    : point);
  return { ...state, marketRows, chart };
}

function toSanitizedReplayEvent(event: DemoReplayEvent): SanitizedMarketEvent {
  return {
    timestamp: validIso(event.provenance.collectedAt) ?? new Date(event.replayTimeMs).toISOString(),
    fixtureId: event.fixtureId,
    marketId: event.marketId ?? "unknown-market",
    marketType: "REPLAY_MARKET",
    marketParameters: null,
    marketPeriod: "PRE_MATCH",
    inRunning: false,
    selectionIds: event.selectionId ? [event.selectionId] : [],
    selectionLabels: event.selectionId ? [event.selectionId] : [],
    marketProbabilities: typeof event.marketProbability === "number" ? [event.marketProbability] : [],
    probabilityField: "STABLE_PRICE",
    demarginingStatus: "VERIFIED_ALREADY_DEMARGINED",
    messageId: event.eventId,
    reasonCodes: ["REPLAY_EVENT", "NO_LOOKAHEAD"],
  };
}

function liveState(runtime: LiveMarketBaselineRuntime, dataStatus: ReturnType<ProductRuntime["dataStatus"]>): DemoState {
  const quotes = runtime.activeQuotes();
  const latest = new Map<string, typeof runtime.audit[number]>();
  for (const audit of runtime.audit) latest.set(audit.marketId, audit);
  const marketRows: DemoMarketRow[] = quotes.map((quote) => {
    const audit = latest.get(quote.marketId);
    const selectionIndex = audit?.selectionIds.indexOf(quote.selectionId) ?? -1;
    const consensus = audit?.filteredConsensus?.[selectionIndex] ?? (quote.bid !== null && quote.ask !== null ? (quote.bid + quote.ask) / 2 : 0.5);
    return {
      fixture: audit?.marketId ?? quote.marketId,
      marketId: quote.marketId,
      market: quote.marketId,
      selectionId: quote.selectionId,
      selection: quote.selectionId,
      marketProbability: consensus,
      theoProbability: consensus,
      filteredConsensus: consensus,
      uncertainty: audit?.uncertainty ?? null,
      innovation: audit?.innovation ?? null,
      standardizedInnovation: audit?.standardizedInnovation ?? null,
      edge: null,
      bid: quote.bid,
      ask: quote.ask,
      width: quote.width,
      inventoryLean: quote.inventoryLean,
      directionalLean: 0,
      bidSize: quote.bidSize,
      askSize: quote.askSize,
      status: quote.status,
      reasonCodes: quote.reasonCodes,
      provenance: { source: "TXODDS", notes: "TXODDS_MARKET_BASELINE; NOT_PROVEN_ALPHA" },
    };
  });
  const positions = runtime.portfolio.positions;
  const realized = positions.reduce((sum, position) => sum + position.realizedPnl, 0);
  const unrealized = positions.reduce((sum, position) => sum + (position.unrealizedPnl ?? 0), 0);
  const fees = positions.reduce((sum, position) => sum + position.fees, 0);
  const exposure = positions.reduce((sum, position) => sum + Math.abs(position.quantity), 0);
  const audits: DemoAuditEvent[] = runtime.audit.slice(-150).map((audit, index) => ({
    auditId: audit.eventId,
    timestamp: audit.decisionTime,
    replayIndex: index,
    marketObservation: audit.marketId,
    theo: audit.filteredConsensus?.[0] ?? null,
    uncertainty: audit.uncertainty,
    edge: null,
    width: audit.quoteWidth,
    widthComponents: audit.quoteWidth === null ? {} as Record<string, number> : { total: audit.quoteWidth },
    inventoryLean: audit.inventoryLean,
    directionalLean: 0,
    proposedAction: "MAKE_MARKET",
    riskChecks: ["PAPER_ONLY", "DIRECTIONAL_DISABLED", "KELLY_DISABLED"],
    finalAction: audit.quoteIds.length ? "PAPER_MAKER_QUOTE" : "QUOTE_SUSPENDED",
    fillResult: audit.fillIds.length ? "FILLED_PAPER_FUTURE_CROSS" : "NO_FILL",
    strategyVersion: "market-baseline-maker/1.0.0",
    reasonCodes: audit.reasonCodes,
    provenance: { source: "TXODDS" },
  }));
  return {
    demoMode: false,
    dataMode: "txline",
    dataSource: "TXODDS_LIVE_READ_ONLY",
    replayStatus: "RUNNING",
    backendStatus: dataStatus.status === "CONNECTED" ? "CONNECTED" : "DISCONNECTED",
    theoProvider: "TXODDS_MARKET_BASELINE",
    strategyStatus: "PAPER_ENABLED / DIRECTIONAL_DISABLED",
    killSwitch: runtime.riskLimits.killSwitch,
    lastMarketUpdate: runtime.audit.at(-1)?.receiveTime ?? null,
    dataFreshnessMs: runtime.audit.at(-1) ? Math.max(0, Date.now() - Date.parse(runtime.audit.at(-1)!.receiveTime)) : null,
    speed: 1,
    currentIndex: runtime.audit.length,
    totalEvents: Math.max(1, runtime.audit.length),
    marketRows,
    chart: marketRows.map((row, index) => ({
      index,
      label: String(index),
      marketProbability: row.marketProbability,
      theoProbability: row.theoProbability,
      bid: row.bid,
      ask: row.ask,
    })),
    positions,
    risk: {
      worstCaseTerminalPnl: realized + unrealized - exposure,
      bestCaseTerminalPnl: realized + unrealized + exposure,
      maximumDrawdown: Math.max(0, -(realized + unrealized)),
      currentDrawdown: Math.max(0, -(realized + unrealized)),
      fixtureExposure: exposure,
      marketExposure: exposure,
      riskBudgetUtilization: Math.min(1, exposure / runtime.riskLimits.maxWorstCaseLoss),
      scenarios: [],
    },
    performance: {
      netPnl: realized + unrealized - fees,
      grossPnl: realized + unrealized,
      sharpeRatio: null,
      sharpeWarning: "Sample too small for a meaningful Sharpe ratio",
      maximumDrawdown: Math.max(0, -(realized + unrealized - fees)),
      currentDrawdown: Math.max(0, -(realized + unrealized - fees)),
      fillRate: runtime.fills.length / Math.max(1, runtime.audit.length),
      turnover: runtime.fills.reduce((sum, fill) => sum + fill.price * fill.size, 0),
      quoteUptime: runtime.audit.filter((audit) => audit.quoteIds.length > 0).length / Math.max(1, runtime.audit.length),
      inventoryVariance: positions.reduce((sum, position) => sum + position.quantity ** 2, 0) / Math.max(1, positions.length),
      adverseSelectionMarkout: 0,
      makerPnl: realized + unrealized,
      takerPnl: 0,
    },
    audit: audits,
    disclaimer: "PAPER MARKET MAKING · MARKET CONSENSUS BASELINE · NO PROPRIETARY ALPHA · NO REAL EXECUTION",
    buildVersion: process.env.npm_package_version ?? "0.1.0",
    cash: runtime.portfolio.cash.cashBalance,
    feesPaid: fees,
    makerFills: runtime.fills,
  };
}

type RecordedReplayFile = {
  fixture?: Record<string, unknown>;
  oddsRecords?: Array<{ update?: TxlineOddsUpdate; receiveTime?: string }>;
  updates?: TxlineOddsUpdate[];
};

function loadFixtureLabel(configuredPath: string, prefix: "Live" | "Historical"): string | null {
  const fixturePath = path.resolve(configuredPath);
  if (!existsSync(fixturePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(fixturePath, "utf8")) as { fixture?: Record<string, unknown> };
    const fixture = parsed.fixture;
    if (!fixture) return null;
    const participants = [
      fixture.participant1 ?? fixture.Participant1,
      fixture.participant2 ?? fixture.Participant2,
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (participants.length !== 2) return null;
    participants.sort((left, right) => left.localeCompare(right));
    return `${prefix} ${participants[0]}–${participants[1]}`;
  } catch {
    return null;
  }
}

function loadRecordedReplay(configuredPath: string | undefined): DemoReplayInput | null {
  const replayPath = path.resolve(configuredPath ?? "data/samples/txodds/replay/recorded-historical-replay.json");
  if (!existsSync(replayPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(replayPath, "utf8")) as RecordedReplayFile;
    const records = parsed.oddsRecords?.flatMap((record) => record.update ? [{ update: record.update, receiveTime: record.receiveTime }] : [])
      ?? parsed.updates?.map((update) => ({ update, receiveTime: new Date(update.Ts).toISOString() }))
      ?? [];
    if (records.length === 0) return null;
    records.sort((left, right) => String(left.receiveTime ?? left.update.Ts).localeCompare(String(right.receiveTime ?? right.update.Ts)));

    const firstUpdate = records[0]!.update;
    const fixtureId = String(parsed.fixture?.FixtureId ?? firstUpdate.FixtureId);
    const home = String(parsed.fixture?.Participant1 ?? "Home");
    const away = String(parsed.fixture?.Participant2 ?? "Away");
    const fixtureLabel = `${home} vs ${away} · recorded TxODDS`;
    const selections = new Map<string, DemoReplayInput["selections"][number]>();
    const previous = new Map<string, number>();
    const events: DemoReplayEvent[] = [];

    for (const record of records) {
      try {
        const market = mapOddsUpdateToMarket(record.update, "REPLAY");
        const probabilities = selectMarketProbabilities(record.update).probabilities;
        for (const [selectionIndex, selection] of market.selections.entries()) {
          const probability = probabilities[selectionIndex];
          if (probability === undefined) continue;
          const key = `${market.marketId}|${selection.selectionId}`;
          if (!selections.has(key)) {
            selections.set(key, {
              marketId: market.marketId,
              market: market.title,
              selectionId: selection.selectionId,
              selection: selection.label,
              probability,
            });
          }
          const prior = previous.get(key);
          const eventIndex = events.length;
          const collectedAt = validIso(record.receiveTime) ?? new Date(record.update.Ts).toISOString();
          events.push({
            eventId: `recorded-${record.update.MessageId ?? record.update.Ts}-${selectionIndex}`,
            index: eventIndex,
            replayTimeMs: eventIndex * 1_000,
            fixtureId,
            eventType: prior !== undefined && Math.abs(probability - prior) >= 0.08 ? "SHARP_MOVEMENT" : "MARKET_UPDATE",
            marketId: market.marketId,
            selectionId: selection.selectionId,
            marketProbability: probability,
            priceImpact: prior === undefined ? 0 : probability - prior,
            description: "Sanitized recorded TxODDS historical market observation",
            provenance: {
              source: "TXODDS_REPLAY",
              externalId: record.update.MessageId,
              collectedAt,
              notes: "Recorded read-only TxLINE devnet payload; credentials removed.",
            },
          });
          previous.set(key, probability);
        }
      } catch {
        // Preserve replay availability when the capture contains an unsupported
        // market shape; valid events remain deterministic and auditable.
      }
    }

    return events.length > 0 && selections.size > 0
      ? { replayType: "RECORDED_TXODDS", fixtureId, fixtureLabel, events, selections: [...selections.values()] }
      : null;
  } catch (error) {
    console.warn(`Recorded replay unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function validIso(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
