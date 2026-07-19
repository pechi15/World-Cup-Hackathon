import { defaultRiskLimits } from "./sample-data.js";
import type { DemoAuditEvent, DemoMarketRow, DemoState, MarketDefinition } from "../../../packages/contracts/src/index.js";
import { DemoReplayEngine } from "../../../packages/demo/src/engine.js";
import {
  invalidConfigStatus,
  mapOddsUpdateToMarket,
  resolveDataRuntimeConfig,
  toNormalizedMarketObservation,
  TxlineReadOnlyAdapter,
  type DataRuntimeConfig,
  type NormalizedEvent,
} from "../../../packages/market-data/src/index.js";
import {
  assertMarketBaselineStartupSafe,
  LiveMarketBaselineRuntime,
  resolveMarketBaselineRuntimeConfig,
} from "../../../packages/live-market-baseline/src/index.js";

export class ProductRuntime {
  readonly dataConfig: DataRuntimeConfig;
  readonly baselineConfig;
  readonly demo: DemoReplayEngine;
  readonly live: LiveMarketBaselineRuntime | null;
  readonly adapter: TxlineReadOnlyAdapter | null;
  private abortController: AbortController | null = null;
  private startupError: string | null = null;

  constructor(private readonly env: Record<string, string | undefined> = process.env) {
    this.dataConfig = resolveDataRuntimeConfig(env);
    this.baselineConfig = resolveMarketBaselineRuntimeConfig(env);
    assertMarketBaselineStartupSafe(this.baselineConfig);
    this.demo = new DemoReplayEngine("replay", true);
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
  }

  private async onEvent(event: NormalizedEvent): Promise<void> {
    if (!this.live) return;
    const market = mapOddsUpdateToMarket(event.update, "TXODDS");
    await this.live.onObservation(market, toNormalizedMarketObservation(event));
  }

  dataStatus() {
    if (!this.dataConfig.valid) return invalidConfigStatus(this.dataConfig);
    if (this.dataConfig.mode === "replay") {
      return {
        status: "CONNECTED",
        display: "Deterministic sanitized replay",
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
    if (!this.baselineConfig.valid) {
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
    const available = this.baselineConfig.valid && (this.mode === "replay" || this.live?.status().trading.maker === "PAPER_ENABLED");
    return {
      maker: available ? "PAPER_ENABLED" : "DISABLED",
      directional: "DISABLED_NON_INDEPENDENT_THEO",
      kelly: "DISABLED_NON_INDEPENDENT_THEO",
      realExecution: "DISABLED",
      walletOperations: "DISABLED",
      subscriptionActivation: "DISABLED",
      fillModel: "CONSERVATIVE_CROSS_ONLY",
      estimatedEdge: null,
      directionalAction: "NO_ACTION",
      kellySize: null,
      labels: ["PAPER MARKET MAKING", "NO REAL EXECUTION"],
    };
  }

  state(): DemoState {
    if (this.mode !== "txline" || !this.live) return this.demo.getState();
    return liveState(this.live, this.dataStatus());
  }
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
    width: null,
    widthComponents: {},
    inventoryLean: 0,
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
