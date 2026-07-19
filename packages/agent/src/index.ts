import type { Fill, MarketDefinition, Portfolio, Quote, RiskLimit, TheoEstimate } from "../../contracts/src/index.js";
import { mapOddsUpdateToMarket, mapOddsUpdateToTicks } from "../../market-data/src/mapper.js";
import type { NormalizedEvent } from "../../market-data/src/event-store.js";
import { PipelineTheoProvider } from "../../theo/src/pipeline.js";
import { defaultQuoteConfig, generateQuote } from "../../quoting/src/index.js";
import { applyFill, createEmptyPortfolio, markPortfolio } from "../../portfolio/src/index.js";
import { PaperExecutionEngine } from "../../execution/src/index.js";
import { appendAuditEvent, type AuditEvent } from "../../evaluation/src/audit.js";
import { computeMarkouts } from "../../evaluation/src/markout.js";

export type LoopConfig = {
  riskLimits: RiskLimit;
  bankroll: number;
  kellyFraction: number;
  makerFillProbability: number;
  innovationSuspendThreshold: number;
};

export type LoopState = {
  portfolio: Portfolio;
  quotes: Quote[];
  fills: Fill[];
  audit: AuditEvent[];
  lastTheo: Map<string, TheoEstimate>;
  lastBaseline: Map<string, TheoEstimate>;
  lastInnovation: Map<string, number>;
  markets: Map<string, MarketDefinition>;
  mids: Map<string, number>;
};

export class AutonomousTradingLoop {
  readonly theo = new PipelineTheoProvider("REPLAY");
  readonly execution = new PaperExecutionEngine();
  state: LoopState;
  config: LoopConfig;

  constructor(config: LoopConfig) {
    this.config = config;
    this.state = this.emptyState(config.bankroll);
  }

  private emptyState(bankroll: number): LoopState {
    return {
      portfolio: createEmptyPortfolio("replay-agent", bankroll),
      quotes: [],
      fills: [],
      audit: [],
      lastTheo: new Map(),
      lastBaseline: new Map(),
      lastInnovation: new Map(),
      markets: new Map(),
      mids: new Map(),
    };
  }

  reset(): void {
    this.theo.clear();
    this.state = this.emptyState(this.config.bankroll);
  }

  setRiskLimits(limits: RiskLimit): void {
    this.config = { ...this.config, riskLimits: limits };
  }

  async onEvent(event: NormalizedEvent): Promise<AuditEvent> {
    const market = mapOddsUpdateToMarket(event.update, event.source);
    const ticks = mapOddsUpdateToTicks(event.update, event.source);
    this.state.markets.set(market.marketId, market);
    for (const tick of ticks) {
      if (tick.mid != null) this.state.mids.set(`${tick.marketId}|${tick.selectionId}`, tick.mid);
    }
    this.theo.ingestEvent(event);

    // Decisions use information-availability time; eventTime remains the latent
    // observation time inside the state-space filter.
    const asOf = event.receiveTime;
    const baseline = await this.theo.getBaseline({ market, asOf });
    const theo = await this.theo.getTheo({ market, asOf });
    this.state.lastBaseline.set(market.marketId, baseline);
    this.state.lastTheo.set(market.marketId, theo);
    const innovation = this.theo.getInnovation(market.marketId);
    this.state.lastInnovation.set(market.marketId, innovation);

    const shock = innovation >= this.config.innovationSuspendThreshold;
    if (shock) this.theo.signalEventShock(market.marketId);

    const quotes: Quote[] = [];
    const reasonCodes: string[] = [];
    for (const selection of market.selections) {
      const inventory = this.state.portfolio.positions.find(
        (p) => p.marketId === market.marketId && p.selectionId === selection.selectionId,
      );
      const quote = generateQuote({
        market,
        selectionId: selection.selectionId,
        theo: shock
          ? { ...theo, status: theo.status === "AVAILABLE" ? "STALE" : theo.status, reasonCodes: [...theo.reasonCodes, "INNOVATION_SHOCK"] }
          : theo,
        inventory,
        recentVolatility: Math.min(0.2, innovation * 0.05),
        sharpMovementSignal: innovation,
        dataAgeMs: 0,
        marketConcentration: 0,
        remainingMarketRiskBudget: this.config.riskLimits.maxExposurePerMarket,
        remainingFixtureRiskBudget: this.config.riskLimits.maxExposurePerFixture,
        remainingPortfolioRiskBudget: this.config.riskLimits.maxWorstCaseLoss,
        worstCaseMarginalLiability: 1,
        directionalSignal:
          theo.status === "AVAILABLE" && theo.probabilities
            ? {
                signalId: `sig-${event.eventId}`,
                marketId: market.marketId,
                selectionId: selection.selectionId,
                directionalLean: (theo.probabilities[selection.selectionId] ?? 0) - (baseline.probabilities?.[selection.selectionId] ?? 0),
                confidence: Math.max(0, 1 - (theo.uncertainty ?? 0.5)),
                status: "AVAILABLE",
                reasonCodes: [],
                generatedAt: asOf,
                provenance: { source: "REPLAY" },
              }
            : null,
        riskLimits: shock
          ? { ...this.config.riskLimits, quoteSuspension: true }
          : this.config.riskLimits,
        config: defaultQuoteConfig,
      });
      quotes.push(quote);
      if (quote.status !== "LIVE") reasonCodes.push(...quote.reasonCodes);

      // Paper maker fill: if LIVE and random-ish deterministic hash, fill at bid/ask mid.
      if (quote.status === "LIVE" && quote.bid != null && quote.ask != null && quote.bidSize && quote.bidSize > 0) {
        const shouldFill = (event.dedupeKey.charCodeAt(0) % 100) / 100 < this.config.makerFillProbability;
        if (shouldFill) {
          const side = (event.dedupeKey.charCodeAt(1) % 2 === 0 ? "BUY" : "SELL") as "BUY" | "SELL";
          const price = side === "BUY" ? quote.bid : quote.ask;
          const size = Math.min(quote.bidSize, this.config.riskLimits.maxOrderSize);
          const order = {
            orderId: `maker-${event.eventId}-${selection.selectionId}`,
            marketId: market.marketId,
            selectionId: selection.selectionId,
            side,
            price,
            size,
            status: "NEW" as const,
            executionStyle: "MAKER" as const,
            strategyId: "autonomous-maker",
            createdAt: asOf,
            provenance: { source: "REPLAY" as const, notes: "Simulated maker fill during replay." },
          };
          const result = this.execution.submitOrder(this.state.portfolio, market, order, this.config.riskLimits);
          this.state.portfolio = result.portfolio;
          this.state.fills.push(...result.fills);
        }
      }

      // Kelly remains calculation-only. The maker submission has no directional
      // taker path; executable-price sizing can be considered only by a future,
      // independently calibrated and separately approved strategy contract.
      reasonCodes.push("KELLY_DIRECTIONAL_ORDER_PATH_DISABLED");
    }

    this.state.quotes = quotes;
    const prices = ticks.map(({ tickId: _t, ...p }) => p);
    this.state.portfolio = markPortfolio(this.state.portfolio, prices);

    const primary = market.selections[0];
    const primaryQuote = quotes.find((q) => q.selectionId === primary.selectionId);
    const markouts = computeMarkouts(this.state.fills, this.state.mids, market.marketId, primary.selectionId);
    const audit = appendAuditEvent(this.state.audit, {
      eventId: event.eventId,
      eventTime: event.eventTime,
      fixtureId: event.fixtureId,
      marketId: market.marketId,
      selectionId: primary.selectionId,
      marketPrice: this.state.mids.get(`${market.marketId}|${primary.selectionId}`) ?? null,
      theo: theo.probabilities?.[primary.selectionId] ?? null,
      baseline: baseline.probabilities?.[primary.selectionId] ?? null,
      uncertainty: theo.uncertainty,
      innovation,
      bid: primaryQuote?.bid ?? null,
      ask: primaryQuote?.ask ?? null,
      width: primaryQuote?.width ?? null,
      inventoryLean: primaryQuote?.inventoryLean ?? 0,
      directionalLean: primaryQuote?.directionalLean ?? 0,
      quoteSize: primaryQuote?.bidSize ?? null,
      quoteStatus: primaryQuote?.status ?? "QUOTING_DISABLED",
      makerInventory: this.state.portfolio.positions
        .filter((p) => p.marketId === market.marketId)
        .reduce((a, p) => a + p.makerQuantity, 0),
      directionalPosition: this.state.portfolio.positions
        .filter((p) => p.marketId === market.marketId)
        .reduce((a, p) => a + p.takerQuantity * Math.sign(p.quantity || 1), 0),
      realizedPnl: this.state.portfolio.cash.realizedPnl,
      fees: this.state.portfolio.cash.feesPaid,
      killSwitch: this.config.riskLimits.killSwitch,
      quoteSuspended: shock || this.config.riskLimits.quoteSuspension,
      markout10s: markouts.m10,
      markout30s: markouts.m30,
      markout60s: markouts.m60,
      markout300s: markouts.m300,
      reasonCodes: [...new Set([...theo.reasonCodes, ...reasonCodes, ...(shock ? ["INNOVATION_SHOCK_WIDEN_OR_SUSPEND"] : [])])],
    });
    return audit;
  }
}
