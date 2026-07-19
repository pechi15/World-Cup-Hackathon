import { describe, expect, it } from "vitest";
import { defaultRiskLimits } from "../apps/api/src/sample-data.js";
import {
  EventStore,
  extractTxlineOddsUpdates,
  mapOddsUpdateToMarket,
  selectMarketProbabilities,
  toNormalizedMarketObservation,
  type TxlineOddsUpdate,
} from "../packages/market-data/src/index.js";
import {
  assertMarketBaselineStartupSafe,
  LiveMarketBaselineRuntime,
  resolveMarketBaselineRuntimeConfig,
} from "../packages/live-market-baseline/src/index.js";
import { MarketBaselineTheoProvider } from "../packages/theo/src/index.js";
import { NoTheoNoActionStrategy } from "../packages/strategies/src/index.js";

function environment(overrides: Record<string, string> = {}) {
  return {
    DATA_MODE: "txline",
    DEMO_MODE: "false",
    THEO_MODE: "market_baseline",
    TRADING_MODE: "paper",
    ENABLE_MARKET_MAKING: "true",
    ENABLE_DIRECTIONAL_TRADING: "false",
    ENABLE_KELLY: "false",
    ENABLE_REAL_EXECUTION: "false",
    ENABLE_WALLET_OPERATIONS: "false",
    ENABLE_TXODDS_ACTIVATION: "false",
    ...overrides,
  };
}

function update(messageId: string, eventMs: number, probabilities: number[] = [0.5, 0.5], stable = true): TxlineOddsUpdate {
  return {
    FixtureId: 42,
    MessageId: messageId,
    Ts: eventMs,
    Bookmaker: "SanitizedBook",
    SuperOddsType: "MATCH_WINNER",
    MarketPeriod: "FULL_MATCH",
    PriceNames: ["Home", "Away"],
    Prices: [2.1, 1.9],
    Pct: ["unverified-home", "unverified-away"],
    StablePrice: stable ? probabilities : undefined,
  };
}

function observation(source: TxlineOddsUpdate, receiveMs: number) {
  const store = new EventStore();
  const event = store.appendRaw({ receivedAt: new Date(receiveMs).toISOString(), transport: "http", body: source, dataMode: "TXODDS" });
  if (!event) throw new Error("event not normalized");
  return { market: mapOddsUpdateToMarket(source, "TXODDS"), observation: toNormalizedMarketObservation(event) };
}

function runtime(overrides: Partial<ReturnType<typeof resolveMarketBaselineRuntimeConfig>> = {}) {
  const config = { ...resolveMarketBaselineRuntimeConfig(environment()), informationShockZ: 100, ...overrides };
  const instance = new LiveMarketBaselineRuntime(config, { ...defaultRiskLimits });
  instance.setConnectionStatus("CONNECTED", "2026-01-01T00:00:00.000Z");
  return instance;
}

describe("TxODDS market-baseline provider", () => {
  it("unwraps SSE odds envelopes and ignores control frames", () => {
    const row = update("1", Date.now());
    expect(extractTxlineOddsUpdates({ event: "odds", data: { updates: [row] } })).toEqual([row]);
    expect(extractTxlineOddsUpdates({ event: "heartbeat", data: { connected: true } })).toEqual([]);
  });

  it("is unavailable whenever TxODDS is disconnected", async () => {
    let status: "DISCONNECTED" | "CONNECTED" = "DISCONNECTED";
    const provider = new MarketBaselineTheoProvider(new Map(), { liveTxodds: true, connectionStatus: () => status });
    const row = observation(update("1", Date.parse("2026-01-01T00:00:00Z")), Date.parse("2026-01-01T00:00:00.010Z"));
    provider.ingestObservation(row.observation);
    const unavailable = await provider.getTheo({ market: row.market, asOf: row.observation.receiveTime });
    expect(unavailable.probabilities).toBeNull();
    expect(unavailable.reasonCodes).toContain("TXODDS_DISCONNECTED");
    status = "CONNECTED";
    const available = await provider.getTheo({ market: row.market, asOf: row.observation.receiveTime });
    expect(available).toMatchObject({
      status: "AVAILABLE_BENCHMARK",
      provenance: "TXODDS_MARKET_BASELINE",
      modelVersion: "market-baseline-v1",
      independentAlpha: false,
      probabilityField: "STABLE_PRICE",
    });
  });

  it("uses StablePrice directly without double de-vigging and never selects Pct", () => {
    const selected = selectMarketProbabilities(update("1", Date.now(), [0.61, 0.39]));
    expect(selected.field).toBe("STABLE_PRICE");
    expect(selected.probabilities).toEqual([0.61, 0.39]);
    expect(selected.reasonCodes).toContain("DOUBLE_DEVIG_SKIPPED");
    expect(selected.reasonCodes).toContain("PCT_NOT_SELECTED_UNVERIFIED");
  });

  it("converts raw decimal Prices and de-vigs exactly once", () => {
    const selected = selectMarketProbabilities(update("1", Date.now(), [0.5, 0.5], false));
    expect(selected.field).toBe("PRICES_DECIMAL");
    expect(selected.probabilities.reduce((sum, probability) => sum + probability, 0)).toBeCloseTo(1, 12);
    expect(selected.reasonCodes).toContain("DEVIG_APPLIED_ONCE");
    expect(selected.reasonCodes.filter((code) => code.includes("DEVIG_APPLIED"))).toHaveLength(1);
  });
});

describe("maker-only lockouts and conservative paper execution", () => {
  it("rejects unsafe real-execution configuration at startup", () => {
    const config = resolveMarketBaselineRuntimeConfig(environment({ ENABLE_REAL_EXECUTION: "true" }));
    expect(config.valid).toBe(false);
    expect(config.reasonCodes).toContain("UNSAFE_REAL_EXECUTION_FOR_MARKET_BASELINE");
    expect(() => assertMarketBaselineStartupSafe(config)).toThrow(/UNSAFE_CONFIGURATION/);
  });

  it("does not permit environment variables to enable directional trading or Kelly", () => {
    const config = resolveMarketBaselineRuntimeConfig(environment({
      ENABLE_DIRECTIONAL_TRADING: "true",
      ENABLE_KELLY: "true",
    }));
    expect(config.valid).toBe(false);
    expect(config.directionalEnabled).toBe(false);
    expect(config.kellyEnabled).toBe(false);
    expect(config.reasonCodes).toEqual(expect.arrayContaining(["INVALID_ENABLE_DIRECTIONAL_TRADING", "INVALID_ENABLE_KELLY"]));
  });

  it("generates benchmark-centred maker quotes while edge, directional action, and Kelly remain null/disabled", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const row = observation(update("1", base), base + 10);
    const instance = runtime();
    const audit = await instance.onObservation(row.market, row.observation);
    expect(audit.quoteIds.length).toBe(2);
    expect(audit.estimatedEdge).toBeNull();
    expect(audit.directionalAction).toBe("NO_ACTION");
    expect(audit.kellySize).toBeNull();
    expect(audit.quoteWidth).toBeGreaterThan(0);
    expect(audit.inventoryLean).toBe(0);
    expect(instance.status().trading).toMatchObject({
      maker: "PAPER_ENABLED",
      directional: "DISABLED_NON_INDEPENDENT_THEO",
      kelly: "DISABLED_NON_INDEPENDENT_THEO",
      realExecution: "DISABLED",
    });
    const theo = await instance.provider.getTheo({ market: row.market, asOf: row.observation.receiveTime });
    const decision = await new NoTheoNoActionStrategy().evaluate({ market: row.market, selectionId: row.market.selections[0].selectionId, theo, marketProbability: 0.5 });
    expect(decision).toMatchObject({ action: "NO_ACTION", proposedSize: null, estimatedEdge: null, status: "DISABLED" });
    expect(decision.reasonCodes).toContain("NON_INDEPENDENT_MARKET_BASELINE");
  });

  it("never fills on the quote-generating tick or before execution latency", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const first = observation(update("1", base), base + 10);
    const second = observation(update("2", base + 20, [0.4, 0.6]), base + 20);
    const instance = runtime({ executionLatencyMs: 250 });
    await instance.onObservation(first.market, first.observation);
    expect(instance.fills).toHaveLength(0);
    await instance.onObservation(second.market, second.observation);
    expect(instance.fills).toHaveLength(0);
  });

  it("fills only after a later observation crosses a resting quote after latency", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const first = observation(update("1", base), base + 10);
    const later = observation(update("2", base + 1_000, [0.4, 0.6]), base + 1_010);
    const instance = runtime({ executionLatencyMs: 250, quoteExpiryMs: 5_000 });
    await instance.onObservation(first.market, first.observation);
    await instance.onObservation(later.market, later.observation);
    expect(instance.fills.length).toBeGreaterThan(0);
    expect(instance.fills.every((fill) => fill.executionStyle === "MAKER")).toBe(true);
    expect(instance.fills.every((fill) => Date.parse(fill.filledAt) > Date.parse(first.observation.receiveTime))).toBe(true);
  });

  it("suspends before evaluating fills on an information-shock observation", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const first = observation(update("1", base), base + 10);
    const shock = observation(update("2", base + 1_000, [0.01, 0.99]), base + 1_010);
    const instance = runtime({ executionLatencyMs: 1, quoteExpiryMs: 5_000, informationShockZ: 0.5 });
    await instance.onObservation(first.market, first.observation);
    const audit = await instance.onObservation(shock.market, shock.observation);
    expect(audit.reasonCodes).toContain("INFORMATION_SHOCK_QUOTE_SUSPENSION");
    expect(audit.fillIds).toHaveLength(0);
    expect(instance.fills).toHaveLength(0);
    expect(instance.activeQuotes()).toHaveLength(0);
  });

  it("suspends stale observations and cancels on sequence gaps or connection loss", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const first = observation(update("1", base), base + 10);
    const instance = runtime({ staleAfterMs: 100 });
    await instance.onObservation(first.market, first.observation);
    expect(instance.activeQuotes().length).toBeGreaterThan(0);
    const gap = observation(update("3", base + 50), base + 60);
    const gapAudit = await instance.onObservation(gap.market, gap.observation);
    expect(gapAudit.reasonCodes).toContain("SEQUENCE_GAP_QUOTE_SUSPENSION");
    expect(instance.activeQuotes()).toHaveLength(0);

    const resumed = observation(update("4", base + 70), base + 80);
    await instance.onObservation(resumed.market, resumed.observation);
    expect(instance.activeQuotes().length).toBeGreaterThan(0);
    instance.setConnectionStatus("DEGRADED", new Date(base + 90).toISOString());
    expect(instance.activeQuotes()).toHaveLength(0);

    instance.setConnectionStatus("CONNECTED", new Date(base + 100).toISOString());
    const stale = observation(update("5", base + 100), base + 1_000);
    const staleAudit = await instance.onObservation(stale.market, stale.observation);
    expect(staleAudit.reasonCodes).toContain("STALE_DATA_QUOTE_SUSPENSION");
    expect(instance.activeQuotes()).toHaveLength(0);
  });

  it("expires quotes and records zero fills honestly when nothing crosses", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const row = observation(update("1", base), base + 10);
    const instance = runtime({ quoteExpiryMs: 100 });
    await instance.onObservation(row.market, row.observation);
    instance.expireQuotes(new Date(base + 500).toISOString());
    expect(instance.activeQuotes()).toHaveLength(0);
    expect(instance.fills).toHaveLength(0);
    expect(instance.cancellations.some((cancellation) => cancellation.reasonCode === "QUOTE_EXPIRED")).toBe(true);
  });

  it("inventory changes maker lean, volatility changes width, and risk budgets reduce size", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const first = observation(update("1", base), base + 10);
    const instance = runtime({ executionLatencyMs: 1, quoteExpiryMs: 5_000 });
    await instance.onObservation(first.market, first.observation);
    const initial = instance.activeQuotes();
    const initialWidth = Math.max(...initial.map((quote) => quote.width ?? 0));
    expect(initial.every((quote) => quote.inventoryLean === 0)).toBe(true);

    const crossing = observation(update("2", base + 100, [0.4, 0.6]), base + 110);
    await instance.onObservation(crossing.market, crossing.observation);
    expect(instance.fills.length).toBeGreaterThan(0);
    expect(instance.activeQuotes().some((quote) => quote.inventoryLean !== 0)).toBe(true);
    expect(Math.max(...instance.activeQuotes().map((quote) => quote.width ?? 0))).toBeGreaterThan(initialWidth);

    const constrained = runtime();
    constrained.setRiskLimits({
      ...defaultRiskLimits,
      maxPositionPerSelection: 1,
      maxExposurePerMarket: 1,
      maxExposurePerFixture: 1,
      maxWorstCaseLoss: 1,
    });
    await constrained.onObservation(first.market, first.observation);
    expect(Math.max(...constrained.activeQuotes().map((quote) => quote.bidSize ?? 0))).toBeLessThan(
      Math.max(...initial.map((quote) => quote.bidSize ?? 0)),
    );
  });

  it("enforces latency, drawdown, and manual kill switches", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const delayed = observation(update("1", base), base + 100);
    const latency = runtime({ staleAfterMs: 1_000, maxLatencyMs: 50 });
    const latencyAudit = await latency.onObservation(delayed.market, delayed.observation);
    expect(latencyAudit.reasonCodes).toContain("LATENCY_KILL_SWITCH");
    expect(latency.activeQuotes()).toHaveLength(0);

    const fresh = observation(update("1", base), base + 10);
    const drawdown = runtime();
    drawdown.setRiskLimits({ ...defaultRiskLimits, maxDailyDrawdown: 10 });
    drawdown.portfolio.positions.push({
      marketId: fresh.market.marketId,
      selectionId: fresh.market.selections[0].selectionId,
      quantity: 1,
      averageEntryPrice: 0.5,
      markPrice: 0.5,
      realizedPnl: -11,
      unrealizedPnl: 0,
      fees: 0,
      makerQuantity: 1,
      takerQuantity: 0,
      strategyAttribution: { "market-baseline-maker-paper": 1 },
      provenance: { source: "TXODDS" },
    });
    const drawdownAudit = await drawdown.onObservation(fresh.market, fresh.observation);
    expect(drawdownAudit.reasonCodes).toContain("DRAWDOWN_KILL_SWITCH");

    const manual = runtime();
    await manual.onObservation(fresh.market, fresh.observation);
    expect(manual.activeQuotes().length).toBeGreaterThan(0);
    manual.setRiskLimits({ ...defaultRiskLimits, killSwitch: true });
    expect(manual.activeQuotes()).toHaveLength(0);
    await manual.onObservation(observation(update("2", base + 20), base + 30).market, observation(update("2", base + 20), base + 30).observation);
    expect(manual.activeQuotes()).toHaveLength(0);
  });
});
