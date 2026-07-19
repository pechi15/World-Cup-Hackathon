import type {
  Fill,
  MarketDefinition,
  Order,
  Portfolio,
  Quote,
  RiskLimit,
} from "../../contracts/src/index.js";
import type { NormalizedMarketObservation } from "../../market-data/src/event-store.js";
import type { TxoddsAdapterStatus } from "../../market-data/src/index.js";
import { MarketBaselineTheoProvider } from "../../theo/src/market-baseline.js";
import { MarketConsensusFilter } from "../../theo/src/benchmark.js";
import { defaultQuoteConfig, generateQuote } from "../../quoting/src/index.js";
import { applyFill, createEmptyPortfolio, markPortfolio } from "../../portfolio/src/index.js";
import { checkOrderRisk } from "../../risk/src/index.js";
import type { MarketBaselineRuntimeConfig } from "./config.js";

export * from "./config.js";

export type QuoteCancellation = {
  quoteId: string;
  marketId: string;
  cancelledAt: string;
  reasonCode: "QUOTE_EXPIRED" | "QUOTE_REPLACED" | "STALE_DATA" | "SEQUENCE_GAP" | "CONNECTION_LOSS" | "INFORMATION_SHOCK" | "LATENCY_LIMIT" | "DRAWDOWN_LIMIT" | "RISK_SUSPENSION";
};

export type MarketBaselineAudit = {
  eventId: string;
  eventTime: string;
  receiveTime: string;
  decisionTime: string;
  marketId: string;
  selectionIds: string[];
  sequenceId: string | null;
  dataStatus: TxoddsAdapterStatus;
  probabilityField: "STABLE_PRICE" | "PRICES_DECIMAL";
  filteredConsensus: number[] | null;
  uncertainty: number | null;
  innovation: number | null;
  standardizedInnovation: number | null;
  quoteIds: string[];
  fillIds: string[];
  estimatedEdge: null;
  directionalAction: "NO_ACTION";
  kellySize: null;
  reasonCodes: string[];
};

type RestingQuote = {
  quote: Quote;
  market: MarketDefinition;
  sourceEventId: string;
  earliestExecutableTime: string;
  expiresAt: string;
};

function numericSequence(value: string | null): number | null {
  if (value === null) return null;
  const direct = /^\d+$/.test(value) ? value : value.split(":").at(-1)?.match(/^\d+/)?.[0];
  if (!direct) return null;
  const parsed = Number(direct);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function clampProbability(value: number): number {
  return Math.min(0.99, Math.max(0.01, value));
}

export class LiveMarketBaselineRuntime {
  readonly provider: MarketBaselineTheoProvider;
  portfolio: Portfolio;
  readonly fills: Fill[] = [];
  readonly orders: Order[] = [];
  readonly cancellations: QuoteCancellation[] = [];
  readonly audit: MarketBaselineAudit[] = [];
  private connectionStatus: TxoddsAdapterStatus = "DISCONNECTED";
  private readonly resting = new Map<string, RestingQuote>();
  private readonly lastSequence = new Map<string, number>();
  private readonly filters = new Map<string, MarketConsensusFilter>();
  private readonly filterAudit = new Map<string, { filteredConsensus: number[]; uncertainty: number; innovation: number; standardizedInnovation: number }>();
  private readonly markets = new Map<string, MarketDefinition>();

  constructor(readonly config: MarketBaselineRuntimeConfig, public riskLimits: RiskLimit, bankroll = 100_000) {
    this.portfolio = createEmptyPortfolio("live-market-baseline-paper", bankroll);
    this.provider = new MarketBaselineTheoProvider(new Map(), {
      liveTxodds: true,
      connectionStatus: () => this.connectionStatus,
    });
  }

  setRiskLimits(limits: RiskLimit): void {
    this.riskLimits = limits;
    if (limits.killSwitch || limits.quoteSuspension) this.cancelAll(new Date().toISOString(), "RISK_SUSPENSION");
  }

  setConnectionStatus(status: TxoddsAdapterStatus, at = new Date().toISOString()): void {
    this.connectionStatus = status;
    if (status !== "CONNECTED") this.cancelAll(at, "CONNECTION_LOSS");
  }

  private cancelAll(at: string, reasonCode: QuoteCancellation["reasonCode"]): void {
    for (const resting of this.resting.values()) {
      this.cancellations.push({ quoteId: resting.quote.quoteId, marketId: resting.quote.marketId, cancelledAt: at, reasonCode });
    }
    this.resting.clear();
  }

  private cancelMarket(marketId: string, at: string, reasonCode: QuoteCancellation["reasonCode"]): void {
    for (const [key, resting] of this.resting) {
      if (resting.quote.marketId !== marketId) continue;
      this.cancellations.push({ quoteId: resting.quote.quoteId, marketId, cancelledAt: at, reasonCode });
      this.resting.delete(key);
    }
  }

  expireQuotes(at: string): void {
    const atMs = Date.parse(at);
    for (const [key, resting] of this.resting) {
      if (Date.parse(resting.expiresAt) > atMs) continue;
      this.cancellations.push({ quoteId: resting.quote.quoteId, marketId: resting.quote.marketId, cancelledAt: at, reasonCode: "QUOTE_EXPIRED" });
      this.resting.delete(key);
    }
  }

  private fillCrossedQuotes(observation: NormalizedMarketObservation): string[] {
    const nowMs = Date.parse(observation.receiveTime);
    const fillIds: string[] = [];
    for (const [key, resting] of [...this.resting]) {
      if (resting.quote.marketId !== observation.marketId || nowMs < Date.parse(resting.earliestExecutableTime)) continue;
      const index = observation.selectionIds.indexOf(resting.quote.selectionId);
      if (index < 0) continue;
      const probability = observation.probabilities[index];
      let side: "BUY" | "SELL" | null = null;
      let rawPrice: number | null = null;
      if (resting.quote.bid !== null && probability <= resting.quote.bid) {
        side = "BUY";
        rawPrice = resting.quote.bid;
      } else if (resting.quote.ask !== null && probability >= resting.quote.ask) {
        side = "SELL";
        rawPrice = resting.quote.ask;
      }
      if (side === null || rawPrice === null) continue;
      const budgets = this.riskBudgets(resting.market, resting.quote.selectionId);
      const size = Math.min(
        side === "BUY" ? resting.quote.bidSize ?? 0 : resting.quote.askSize ?? 0,
        this.riskLimits.maxOrderSize,
        budgets.selection,
        budgets.market,
        budgets.fixture,
        budgets.portfolio,
      );
      if (size <= 0) continue;
      const risk = checkOrderRisk(this.portfolio, resting.market, resting.quote.selectionId, size, this.riskLimits);
      const order: Order = {
        orderId: `paper-${observation.observationId}-${resting.quote.quoteId}-${side.toLowerCase()}`,
        marketId: resting.quote.marketId,
        selectionId: resting.quote.selectionId,
        side,
        price: clampProbability(rawPrice + (side === "BUY" ? this.config.slippage : -this.config.slippage)),
        size,
        status: risk.accepted ? "FILLED" : "REJECTED",
        executionStyle: "MAKER",
        strategyId: "market-baseline-maker-paper",
        createdAt: resting.earliestExecutableTime,
        provenance: { source: "TXODDS", notes: "Conservative future-observation cross-only paper order." },
      };
      this.orders.push(order);
      if (risk.accepted) {
        const fill: Fill = {
          fillId: `fill-${order.orderId}`,
          orderId: order.orderId,
          marketId: order.marketId,
          selectionId: order.selectionId,
          side,
          price: order.price,
          size,
          fee: size * order.price * this.config.feeRate,
          executionStyle: "MAKER",
          strategyId: order.strategyId,
          filledAt: observation.receiveTime,
          provenance: { source: "TXODDS", notes: "Paper-only fill after execution latency and a later crossing observation." },
        };
        this.portfolio = applyFill(this.portfolio, fill);
        this.fills.push(fill);
        fillIds.push(fill.fillId);
      }
      this.resting.delete(key);
    }
    return fillIds;
  }

  private riskBudgets(market: MarketDefinition, selectionId: string) {
    const marketPositions = this.portfolio.positions.filter((position) => position.marketId === market.marketId);
    const fixtureMarketIds = new Set([...this.markets.values()].filter((candidate) => candidate.fixtureId === market.fixtureId).map((candidate) => candidate.marketId));
    const selectionExposure = Math.abs(marketPositions.find((position) => position.selectionId === selectionId)?.quantity ?? 0);
    const marketExposure = marketPositions.reduce((sum, position) => sum + Math.abs(position.quantity), 0);
    const fixtureExposure = this.portfolio.positions.filter((position) => fixtureMarketIds.has(position.marketId)).reduce((sum, position) => sum + Math.abs(position.quantity), 0);
    const portfolioExposure = this.portfolio.positions.reduce((sum, position) => sum + Math.abs(position.quantity), 0);
    return {
      selection: Math.max(0, this.riskLimits.maxPositionPerSelection - selectionExposure),
      market: Math.max(0, this.riskLimits.maxExposurePerMarket - marketExposure),
      fixture: Math.max(0, this.riskLimits.maxExposurePerFixture - fixtureExposure),
      portfolio: Math.max(0, this.riskLimits.maxWorstCaseLoss - portfolioExposure),
    };
  }

  async onObservation(market: MarketDefinition, observation: NormalizedMarketObservation): Promise<MarketBaselineAudit> {
    this.markets.set(market.marketId, market);
    this.expireQuotes(observation.receiveTime);
    const reasons = ["NON_INDEPENDENT_MARKET_BASELINE", "DIRECTIONAL_TRADING_DISABLED", "KELLY_DISABLED"];
    const nowMs = Date.parse(observation.receiveTime);
    const eventMs = Date.parse(observation.eventTime);
    const dataAgeMs = nowMs - eventMs;

    if (this.connectionStatus !== "CONNECTED") {
      this.cancelMarket(market.marketId, observation.receiveTime, "CONNECTION_LOSS");
      reasons.push(`TXODDS_${this.connectionStatus}`);
      return this.appendAudit(observation, [], [], reasons);
    }

    const currentSequence = numericSequence(observation.provenance.messageId);
    const previousSequence = this.lastSequence.get(market.marketId);
    const sequenceGap = currentSequence !== null && previousSequence !== undefined && currentSequence > previousSequence + 1;
    if (currentSequence !== null) this.lastSequence.set(market.marketId, currentSequence);
    if (sequenceGap) {
      this.cancelMarket(market.marketId, observation.receiveTime, "SEQUENCE_GAP");
      reasons.push("SEQUENCE_GAP_QUOTE_SUSPENSION");
      return this.appendAudit(observation, [], [], reasons);
    }

    if (!Number.isFinite(dataAgeMs) || dataAgeMs < 0 || dataAgeMs > this.config.staleAfterMs) {
      this.cancelMarket(market.marketId, observation.receiveTime, "STALE_DATA");
      reasons.push("STALE_DATA_QUOTE_SUSPENSION");
      return this.appendAudit(observation, [], [], reasons);
    }

    if (dataAgeMs > this.config.maxLatencyMs) {
      this.cancelMarket(market.marketId, observation.receiveTime, "LATENCY_LIMIT");
      reasons.push("LATENCY_KILL_SWITCH");
      return this.appendAudit(observation, [], [], reasons);
    }

    const currentPnl = this.portfolio.positions.reduce((sum, position) => sum + position.realizedPnl + (position.unrealizedPnl ?? 0) - position.fees, 0);
    if (currentPnl <= -this.riskLimits.maxDailyDrawdown) {
      this.cancelAll(observation.receiveTime, "DRAWDOWN_LIMIT");
      reasons.push("DRAWDOWN_KILL_SWITCH");
      return this.appendAudit(observation, [], [], reasons);
    }

    const fillIds = this.fillCrossedQuotes(observation);
    const diagnostics = observation.probabilities.map((probability, index) => {
      const key = `${market.marketId}|${observation.selectionIds[index] ?? index}`;
      const filter = this.filters.get(key) ?? new MarketConsensusFilter();
      this.filters.set(key, filter);
      return filter.update(key, probability);
    });
    const innovationZ = Math.max(0, ...diagnostics.map((item) => Math.abs(item.standardizedInnovation)));
    const nextVolatility = Math.max(0.001, ...diagnostics.map((item) => item.volatility));
    this.filterAudit.set(market.marketId, {
      filteredConsensus: diagnostics.map((item) => item.filteredConsensus),
      uncertainty: Math.max(...diagnostics.map((item) => item.uncertainty)),
      innovation: Math.max(...diagnostics.map((item) => Math.abs(item.innovation))),
      standardizedInnovation: innovationZ,
    });
    if (innovationZ >= this.config.informationShockZ) {
      this.cancelMarket(market.marketId, observation.receiveTime, "INFORMATION_SHOCK");
      reasons.push("INFORMATION_SHOCK_QUOTE_SUSPENSION");
      return this.appendAudit(observation, [], fillIds, reasons);
    }

    this.cancelMarket(market.marketId, observation.receiveTime, "QUOTE_REPLACED");
    this.provider.ingestObservation(observation);
    const rawTheo = await this.provider.getTheo({ market, asOf: observation.receiveTime });
    const theo = rawTheo.probabilities === null ? rawTheo : {
      ...rawTheo,
      probabilities: Object.fromEntries(observation.selectionIds.map((selectionId, index) => [selectionId, diagnostics[index]?.filteredConsensus ?? observation.probabilities[index]])),
      uncertainty: Math.max(...diagnostics.map((item) => item.uncertainty)),
      reasonCodes: [...rawTheo.reasonCodes, "STATE_SPACE_MARKET_FILTER", `MAX_STANDARDIZED_INNOVATION=${innovationZ.toFixed(6)}`],
    };
    if (theo.status !== "AVAILABLE_BENCHMARK") {
      reasons.push(...theo.reasonCodes);
      return this.appendAudit(observation, [], fillIds, reasons);
    }

    const quotes: Quote[] = [];
    for (const selection of market.selections) {
      const budgets = this.riskBudgets(market, selection.selectionId);
      const inventory = this.portfolio.positions.find((position) => position.marketId === market.marketId && position.selectionId === selection.selectionId);
      const quote = generateQuote({
        market,
        selectionId: selection.selectionId,
        theo,
        inventory,
        recentVolatility: nextVolatility,
        sharpMovementSignal: innovationZ,
        dataAgeMs,
        feedLatencyMs: dataAgeMs,
        executionLatencyMs: this.config.executionLatencyMs,
        adverseSelectionEstimate: Math.min(0.2, innovationZ * nextVolatility),
        marketConcentration: market.selections.length === 0 ? 1 : 1 / market.selections.length,
        remainingMarketRiskBudget: Math.min(budgets.selection, budgets.market),
        remainingFixtureRiskBudget: budgets.fixture,
        remainingPortfolioRiskBudget: budgets.portfolio,
        worstCaseMarginalLiability: 1,
        directionalSignal: null,
        quoteMode: "MARKET_BASELINE_MAKER_ONLY",
        riskLimits: this.riskLimits,
        config: defaultQuoteConfig,
      });
      quotes.push(quote);
      if (quote.status === "LIVE") {
        const key = `${quote.marketId}|${quote.selectionId}`;
        this.resting.set(key, {
          quote,
          market,
          sourceEventId: observation.observationId,
          earliestExecutableTime: iso(nowMs + this.config.executionLatencyMs),
          expiresAt: iso(nowMs + this.config.quoteExpiryMs),
        });
      } else {
        reasons.push(...quote.reasonCodes);
      }
    }

    const prices = observation.selectionIds.map((selectionId, index) => ({
      marketId: market.marketId,
      selectionId,
      bid: observation.probabilities[index] ?? null,
      ask: observation.probabilities[index] ?? null,
      mid: observation.probabilities[index] ?? null,
      last: observation.probabilities[index] ?? null,
      timestamp: observation.eventTime,
      sequenceId: observation.provenance.messageId,
      provenance: { source: "TXODDS" as const },
    }));
    this.portfolio = markPortfolio(this.portfolio, prices);
    return this.appendAudit(observation, quotes.map((quote) => quote.quoteId), fillIds, [...reasons, ...theo.reasonCodes]);
  }

  private appendAudit(observation: NormalizedMarketObservation, quoteIds: string[], fillIds: string[], reasonCodes: string[]): MarketBaselineAudit {
    const filter = this.filterAudit.get(observation.marketId);
    const event: MarketBaselineAudit = {
      eventId: observation.observationId,
      eventTime: observation.eventTime,
      receiveTime: observation.receiveTime,
      decisionTime: observation.receiveTime,
      marketId: observation.marketId,
      selectionIds: [...observation.selectionIds],
      sequenceId: observation.provenance.messageId,
      dataStatus: this.connectionStatus,
      probabilityField: observation.probabilityField,
      filteredConsensus: filter?.filteredConsensus ?? null,
      uncertainty: filter?.uncertainty ?? null,
      innovation: filter?.innovation ?? null,
      standardizedInnovation: filter?.standardizedInnovation ?? null,
      quoteIds,
      fillIds,
      estimatedEdge: null,
      directionalAction: "NO_ACTION",
      kellySize: null,
      reasonCodes: [...new Set(reasonCodes)],
    };
    this.audit.push(event);
    return event;
  }

  activeQuotes(): Array<Quote & { earliestExecutableTime: string; expiresAt: string }> {
    return [...this.resting.values()].map(({ quote, earliestExecutableTime, expiresAt }) => ({ ...quote, earliestExecutableTime, expiresAt }));
  }

  status() {
    const available = this.config.valid && this.connectionStatus === "CONNECTED" && this.audit.some((event) => event.quoteIds.length > 0);
    const unavailableReasons = !this.config.valid
      ? [...this.config.reasonCodes]
      : this.connectionStatus !== "CONNECTED"
        ? [`TXODDS_${this.connectionStatus}`, "MARKET_BASELINE_UNAVAILABLE"]
        : ["AWAITING_FRESH_LIVE_MARKET_OBSERVATION"];
    return {
      theo: {
        status: available ? "AVAILABLE_BENCHMARK" : "UNAVAILABLE",
        provenance: "TXODDS_MARKET_BASELINE",
        modelVersion: "market-baseline-v1",
        independentAlpha: false,
        labels: ["Market benchmark", "No proprietary theo", "Not proven alpha"],
        reasonCodes: available ? ["MARKET_CONSENSUS_BENCHMARK", "NOT_PROVEN_ALPHA"] : unavailableReasons,
      },
      trading: {
        maker: available ? "PAPER_ENABLED" : "DISABLED",
        directional: "DISABLED_NON_INDEPENDENT_THEO",
        kelly: "DISABLED_NON_INDEPENDENT_THEO",
        realExecution: "DISABLED",
        fillModel: "CONSERVATIVE_CROSS_ONLY",
        estimatedEdge: null,
        labels: ["Paper maker only", "Directional trading disabled"],
      },
    };
  }
}
