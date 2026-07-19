import { describe, expect, it } from "vitest";
import type { Fill, MarketDefinition, MarketPrice, TheoEstimate, TradingSignal } from "../packages/contracts/src/index.js";
import { markets, defaultRiskLimits } from "../apps/api/src/sample-data.js";
import { defaultScoreScenarios, settleScoreMarket, settleTournamentWinner } from "../packages/market-model/src/index.js";
import { NullTheoProvider } from "../packages/theo/src/index.js";
import { defaultQuoteConfig, generateQuote } from "../packages/quoting/src/index.js";
import { fractionalKelly, NoTheoNoActionStrategy } from "../packages/strategies/src/index.js";
import { applyFill, createEmptyPortfolio, markPortfolio } from "../packages/portfolio/src/index.js";
import { checkOrderRisk, markToMarketShockRisk, probabilityShock, terminalOutcomeRisk } from "../packages/risk/src/index.js";
import { PaperExecutionEngine } from "../packages/execution/src/index.js";

const threeWay = markets.find((market) => market.marketId === "m-three-way-001")!;
const totals = markets.find((market) => market.marketId === "m-total-001")!;
const handicap = markets.find((market) => market.marketId === "m-handicap-001")!;
const tournament = markets.find((market) => market.marketId === "m-tournament-winner-001")!;

function availableTheo(market: MarketDefinition, probabilities: Record<string, number>, uncertainty = 0.04): TheoEstimate {
  return {
    marketId: market.marketId,
    probabilities,
    uncertainty,
    modelVersion: "test-only/0.1.0",
    generatedAt: new Date().toISOString(),
    source: "TEST_FIXTURE",
    status: "AVAILABLE",
    reasonCodes: [],
  };
}

function testFill(overrides: Partial<Fill> = {}): Fill {
  return {
    fillId: "fill-test",
    orderId: "order-test",
    marketId: totals.marketId,
    selectionId: "over-2-5",
    side: "BUY",
    price: 0.4,
    size: 100,
    fee: 1,
    executionStyle: "MAKER",
    strategyId: "test-strategy",
    filledAt: new Date().toISOString(),
    provenance: { source: "TEST_FIXTURE" },
    ...overrides,
  };
}

describe("market settlement", () => {
  it("settles binary yes/no markets from score scenarios", () => {
    const binary: MarketDefinition = {
      ...totals,
      marketId: "binary",
      marketType: "BINARY_YES_NO",
      selections: [
        { ...totals.selections[0], marketId: "binary", selectionId: "yes", outcomeType: "YES", label: "Any goal" },
        { ...totals.selections[1], marketId: "binary", selectionId: "no", outcomeType: "NO", label: "No goals" },
      ],
      settlementRules: [{ ...totals.settlementRules[0], marketType: "BINARY_YES_NO" }],
    };
    const result = settleScoreMarket(binary, { scenarioId: "1-0", fixtureId: "fixture-test-001", homeGoals: 1, awayGoals: 0, provenance: { source: "TEST_FIXTURE" } });
    expect(result.selectionPayouts.yes).toBe(1);
    expect(result.selectionPayouts.no).toBe(0);
  });

  it("settles three-way match result markets", () => {
    const result = settleScoreMarket(threeWay, { scenarioId: "1-1", fixtureId: "fixture-test-001", homeGoals: 1, awayGoals: 1, provenance: { source: "TEST_FIXTURE" } });
    expect(result.selectionPayouts.draw).toBe(1);
    expect(result.selectionPayouts.home).toBe(0);
  });

  it("settles totals markets", () => {
    const result = settleScoreMarket(totals, { scenarioId: "2-1", fixtureId: "fixture-test-001", homeGoals: 2, awayGoals: 1, provenance: { source: "TEST_FIXTURE" } });
    expect(result.selectionPayouts["over-2-5"]).toBe(1);
    expect(result.selectionPayouts["under-2-5"]).toBe(0);
  });

  it("settles handicap markets", () => {
    const result = settleScoreMarket(handicap, { scenarioId: "0-0", fixtureId: "fixture-test-001", homeGoals: 0, awayGoals: 0, provenance: { source: "TEST_FIXTURE" } });
    expect(result.selectionPayouts["home-plus-0-5"]).toBe(1);
    expect(result.selectionPayouts["away-minus-0-5"]).toBe(0);
  });

  it("settles tournament-winner markets", () => {
    const result = settleTournamentWinner(tournament, "away");
    expect(result.selectionPayouts["team-away"]).toBe(1);
    expect(result.selectionPayouts["team-home"]).toBe(0);
  });
});

describe("theo, quoting, strategy, and Kelly safeguards", () => {
  it("returns null theo while awaiting TxODDS API", async () => {
    const theo = await new NullTheoProvider().getTheo({ market: totals });
    expect(theo.probabilities).toBeNull();
    expect(theo.uncertainty).toBeNull();
    expect(theo.status).toBe("AWAITING_TXODDS_API");
  });

  it("disables quotes when theo is null", async () => {
    const theo = await new NullTheoProvider().getTheo({ market: totals });
    const quote = generateQuote({
      market: totals,
      selectionId: "over-2-5",
      theo,
      recentVolatility: 0,
      sharpMovementSignal: 0,
      dataAgeMs: 0,
      marketConcentration: 0,
      remainingMarketRiskBudget: 1000,
      remainingFixtureRiskBudget: 1000,
      remainingPortfolioRiskBudget: 1000,
      worstCaseMarginalLiability: 1,
      riskLimits: defaultRiskLimits,
      config: defaultQuoteConfig,
    });
    expect(quote.status).toBe("QUOTING_DISABLED");
    expect(quote.bid).toBeNull();
    expect(quote.ask).toBeNull();
    expect(quote.reasonCodes).toContain("THEO_UNAVAILABLE");
  });

  it("calculates width, inventory lean, directional lean, and quote height with injected test theo", () => {
    const portfolio = applyFill(createEmptyPortfolio(), testFill({ size: 50 }));
    const signal: TradingSignal = {
      signalId: "sig",
      marketId: totals.marketId,
      selectionId: "over-2-5",
      directionalLean: 0.02,
      confidence: 0.5,
      status: "AVAILABLE",
      reasonCodes: [],
      generatedAt: new Date().toISOString(),
      provenance: { source: "TEST_FIXTURE" },
    };
    const quote = generateQuote({
      market: totals,
      selectionId: "over-2-5",
      theo: availableTheo(totals, { "over-2-5": 0.58, "under-2-5": 0.42 }),
      inventory: portfolio.positions[0],
      recentVolatility: 0.02,
      sharpMovementSignal: 0.01,
      dataAgeMs: 1000,
      marketConcentration: 0.1,
      remainingMarketRiskBudget: 1000,
      remainingFixtureRiskBudget: 1000,
      remainingPortfolioRiskBudget: 1000,
      worstCaseMarginalLiability: 1,
      directionalSignal: signal,
      riskLimits: defaultRiskLimits,
      config: defaultQuoteConfig,
    });
    expect(quote.status).toBe("LIVE");
    expect(quote.width).toBeGreaterThan(defaultQuoteConfig.minimumWidth);
    expect(quote.inventoryLean).toBeLessThan(0);
    expect(quote.directionalLean).toBe(0.01);
    expect(quote.bidSize).toBeGreaterThan(0);
  });

  it("does not produce directional opinions without theo", async () => {
    const theo = await new NullTheoProvider().getTheo({ market: totals });
    const decision = await new NoTheoNoActionStrategy().evaluate({ market: totals, selectionId: "over-2-5", theo, marketProbability: 0.52 });
    expect(decision.action).toBe("NO_ACTION");
    expect(decision.status).toBe("THEO_UNAVAILABLE");
    expect(decision.estimatedEdge).toBeNull();
  });

  it("calculates fractional Kelly for valid binary opportunities", () => {
    const result = fractionalKelly({
      modelProbability: 0.6,
      executable: { kind: "BINARY_CONTRACT", price: 0.5, side: "BUY", priceSource: "ASK" },
      bankroll: 1000,
      kellyFraction: 0.25,
      maximumBankrollFraction: 0.1,
      fees: 0,
      slippage: 0,
      independentTheoStatus: "AVAILABLE",
      calibration: { status: "CALIBRATED", method: "held-out reliability" },
      theoMode: "research",
      caps: { selection: 80, market: 100, fixture: 100, portfolioWorstCaseLoss: 100 },
    });
    expect(result.status).toBe("AVAILABLE");
    expect(result.size).toBeCloseTo(50, 12);
  });

  it("disables Kelly when theo is null", () => {
    const result = fractionalKelly({
      modelProbability: null,
      executable: { kind: "BINARY_CONTRACT", price: 0.5, side: "BUY", priceSource: "ASK" },
      bankroll: 1000,
      kellyFraction: 0.25,
      maximumBankrollFraction: 0.1,
      fees: 0,
      slippage: 0,
      independentTheoStatus: "UNAVAILABLE",
      calibration: { status: "CALIBRATED" },
      theoMode: "research",
      caps: { selection: 80, market: 100, fixture: 100, portfolioWorstCaseLoss: 100 },
    });
    expect(result.status).toBe("THEO_UNAVAILABLE");
    expect(result.size).toBeNull();
  });
});

describe("portfolio, risk, and execution", () => {
  it("tracks cash, position accounting, realized and unrealized P&L", () => {
    let portfolio = createEmptyPortfolio("p", 1000);
    portfolio = applyFill(portfolio, testFill({ side: "BUY", price: 0.4, size: 100, fee: 1 }));
    portfolio = applyFill(portfolio, testFill({ fillId: "sell", side: "SELL", price: 0.6, size: 40, fee: 1, executionStyle: "TAKER" }));
    const mark: MarketPrice = { marketId: totals.marketId, selectionId: "over-2-5", bid: 0.49, ask: 0.51, mid: 0.5, last: null, timestamp: new Date().toISOString(), sequenceId: null, provenance: { source: "TEST_FIXTURE" } };
    portfolio = markPortfolio(portfolio, [mark]);
    expect(portfolio.positions[0].quantity).toBe(60);
    expect(portfolio.positions[0].realizedPnl).toBeCloseTo(8);
    expect(portfolio.positions[0].unrealizedPnl).toBeCloseTo(6);
    expect(portfolio.positions[0].makerQuantity).toBe(100);
    expect(portfolio.positions[0].takerQuantity).toBe(40);
  });

  it("builds a scenario payoff matrix and keeps expected P&L null without distribution", () => {
    const portfolio = applyFill(createEmptyPortfolio("p", 1000), testFill({ side: "BUY", price: 0.4, size: 100, fee: 0 }));
    const scenarios = defaultScoreScenarios("fixture-test-001", "TEST_FIXTURE");
    const risk = terminalOutcomeRisk(portfolio, [totals], scenarios, null);
    expect(risk.rows).toHaveLength(15);
    expect(risk.worstCasePnl).toBeLessThan(0);
    expect(risk.bestCasePnl).toBeGreaterThan(0);
    expect(risk.expectedPnl).toBeNull();
  });

  it("computes expected P&L when an approved scenario distribution exists", () => {
    const portfolio = applyFill(createEmptyPortfolio("p", 1000), testFill({ side: "BUY", price: 0.4, size: 100, fee: 0 }));
    const scenarios = defaultScoreScenarios("fixture-test-001", "TEST_FIXTURE");
    const distribution = Object.fromEntries(scenarios.map((scenario) => [scenario.scenarioId, 1 / scenarios.length]));
    const risk = terminalOutcomeRisk(portfolio, [totals], scenarios, distribution);
    expect(risk.expectedPnl).not.toBeNull();
  });

  it("applies probability shocks while preserving mutually exclusive constraints", () => {
    const shocked = probabilityShock({ home: 0.4, draw: 0.3, away: 0.3 }, 0.1);
    expect(Object.values(shocked).reduce((acc, value) => acc + value, 0)).toBeCloseTo(1);
    expect(shocked.home).toBeCloseTo(0.5);
  });

  it("calculates mark-to-market shock P&L", () => {
    const portfolio = applyFill(createEmptyPortfolio("p", 1000), testFill({ side: "BUY", price: 0.4, size: 100, fee: 0 }));
    const current: MarketPrice = { marketId: totals.marketId, selectionId: "over-2-5", bid: 0.39, ask: 0.41, mid: 0.4, last: null, timestamp: new Date().toISOString(), sequenceId: null, provenance: { source: "TEST_FIXTURE" } };
    const shocked: MarketPrice = { ...current, mid: 0.5 };
    const risk = markToMarketShockRisk(portfolio, [current], [shocked]);
    expect(risk.portfolioPnlChange).toBeCloseTo(10);
  });

  it("rejects orders that exceed risk limits", () => {
    const portfolio = createEmptyPortfolio();
    const result = checkOrderRisk(portfolio, totals, "over-2-5", 9999, defaultRiskLimits);
    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain("MAX_ORDER_SIZE_EXCEEDED");
  });

  it("supports kill switch rejection in paper execution", () => {
    const engine = new PaperExecutionEngine();
    const order = {
      orderId: "order",
      marketId: totals.marketId,
      selectionId: "over-2-5",
      side: "BUY" as const,
      price: 0.5,
      size: 1,
      status: "NEW" as const,
      executionStyle: "TAKER" as const,
      createdAt: new Date().toISOString(),
      provenance: { source: "TEST_FIXTURE" as const },
    };
    const result = engine.submitOrder(createEmptyPortfolio(), totals, order, { ...defaultRiskLimits, killSwitch: true });
    expect(result.order.status).toBe("REJECTED");
    expect(result.reasonCodes).toContain("KILL_SWITCH_ENABLED");
  });

  it("handles unknown or unsupported markets", () => {
    const unsupported = { ...totals, marketType: "COMBINATION" as const };
    const result = settleScoreMarket(unsupported, { scenarioId: "1-1", fixtureId: "fixture-test-001", homeGoals: 1, awayGoals: 1, provenance: { source: "TEST_FIXTURE" } });
    expect(result.status).toBe("UNSUPPORTED_MARKET");
  });
});
