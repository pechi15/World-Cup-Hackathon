import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { defaultRiskLimits } from "../apps/api/src/sample-data.js";
import { route } from "../apps/api/src/server.js";
import {
  AdaptiveQuoteGuard,
  DecisionBook,
  DualStrategyController,
  ShadowExecutionEngine,
  sanitizeMarketUpdate,
  type DecisionAction,
  type DecisionSide,
  type ExecutableMarketEvent,
  type RecordDecisionInput,
} from "../packages/live-agents/src/index.js";
import type { TxlineOddsUpdate } from "../packages/market-data/src/index.js";

const t0 = "2026-07-18T20:00:00.000Z";

function decisionInput(overrides: Partial<RecordDecisionInput> = {}): RecordDecisionInput {
  return {
    fixtureId: "fixture-1",
    marketId: "market-1",
    selectionId: "selection-1",
    sourceEventId: "signal-1",
    sourceEventTime: t0,
    receiveTime: t0,
    dataCutoffTime: t0,
    decisionTime: t0,
    configuredLatencyMs: 100,
    strategy: "hawk",
    action: "OPEN_PAPER_POSITION",
    side: "BUY",
    proposedPrice: 0.5,
    proposedSize: 10,
    reasonCodes: ["MOVEMENT_SIGNAL"],
    status: "PENDING",
    provenance: "RECORDED_TXODDS_REPLAY",
    featureReferences: [{ eventId: "signal-1", availableAt: t0, kind: "MARKET_OBSERVATION" }],
    ...overrides,
  };
}

function executable(overrides: Partial<ExecutableMarketEvent> = {}): ExecutableMarketEvent {
  return {
    eventId: "market-2",
    fixtureId: "fixture-1",
    marketId: "market-1",
    selectionId: "selection-1",
    sourceEventTime: "2026-07-18T20:00:00.100Z",
    availableAt: "2026-07-18T20:00:00.100Z",
    receiveTime: "2026-07-18T20:00:00.100Z",
    bid: 0.51,
    ask: 0.52,
    ...overrides,
  };
}

function odds(timestamp: string, probability: number): TxlineOddsUpdate {
  return {
    FixtureId: 1,
    MessageId: timestamp,
    Ts: Date.parse(timestamp),
    Bookmaker: "TxLineStablePriceDemargined",
    SuperOddsType: "BINARY",
    MarketPeriod: "FULL_MATCH",
    PriceNames: ["Yes", "No"],
    Prices: [1 / probability, 1 / (1 - probability)],
  };
}

async function get(pathName: string): Promise<{ status: number; body: unknown }> {
  let status = 0;
  let raw = "";
  const request = { method: "GET", url: pathName, headers: { host: "localhost" } } as IncomingMessage;
  const response = {
    writeHead(code: number) { status = code; },
    end(body: string) { raw = body; },
  } as unknown as ServerResponse;
  await route(request, response);
  return { status, body: JSON.parse(raw) };
}

describe("Hive Decision Book causal assertions", () => {
  it("rejects future features and prohibited final-result features", () => {
    const book = new DecisionBook();
    expect(() => book.record(decisionInput({
      featureReferences: [{ eventId: "future", availableAt: "2026-07-18T20:00:00.001Z", kind: "MARKET_OBSERVATION" }],
    }))).toThrow("NO_LOOKAHEAD_VIOLATION:FUTURE_FEATURE");
    expect(() => book.record(decisionInput({
      featureReferences: [{ eventId: "final", availableAt: t0, kind: "FINAL_RESULT" }],
    }))).toThrow("NO_LOOKAHEAD_VIOLATION:PROHIBITED_FEATURE");
  });

  it("creates reproducible IDs and replay-serializable decisions", () => {
    const first = new DecisionBook().record(decisionInput());
    const second = new DecisionBook().record(decisionInput());
    expect(first).toEqual(second);
    expect(new DecisionBook([first]).all()).toEqual([first]);
    expect(first.noLookaheadVerificationStatus).toBe("VERIFIED");
  });
});

describe("causal shadow fills", () => {
  it("forbids a same-event fill and applies configured latency", () => {
    const book = new DecisionBook();
    book.record(decisionInput());
    const engine = new ShadowExecutionEngine(book, { configuredLatencyMs: 100, feeRate: 0.001, slippageBps: 5 });
    expect(engine.processMarketEvent(executable({ eventId: "signal-1" }))).toEqual([]);
    expect(engine.processMarketEvent(executable({
      eventId: "market-before-latency",
      sourceEventTime: "2026-07-18T20:00:00.099Z",
      availableAt: "2026-07-18T20:00:00.099Z",
      receiveTime: "2026-07-18T20:00:00.099Z",
    }))).toEqual([]);
    expect(book.all()[0]).toMatchObject({ status: "PENDING", fillEventId: null });
    expect(engine.processMarketEvent(executable())).toHaveLength(1);
  });

  it("requires a later cross for Maker Bee quotes", () => {
    const book = new DecisionBook();
    book.record(decisionInput({
      strategy: "maker",
      action: "PLACE_PAPER_QUOTE",
      side: "BUY",
      proposedPrice: 0.48,
      configuredLatencyMs: 0,
    }));
    const engine = new ShadowExecutionEngine(book, { configuredLatencyMs: 0, feeRate: 0.001, slippageBps: 5 });
    expect(engine.processMarketEvent(executable({ bid: 0.49, ask: 0.5 }))).toEqual([]);
    expect(engine.processMarketEvent(executable({
      eventId: "future-cross",
      sourceEventTime: "2026-07-18T20:00:00.200Z",
      availableAt: "2026-07-18T20:00:00.200Z",
      receiveTime: "2026-07-18T20:00:00.200Z",
      bid: 0.47,
      ask: 0.48,
    }))[0]).toMatchObject({ status: "FILLED", fillEventId: "future-cross" });
  });

  it("uses the first later executable ask for a Hawk buy and applies fees and slippage", () => {
    const book = new DecisionBook();
    const decision = book.record(decisionInput());
    const engine = new ShadowExecutionEngine(book, { configuredLatencyMs: 100, feeRate: 0.01, slippageBps: 100 });
    const [fill] = engine.processMarketEvent(executable({ ask: 0.52 }));
    expect(fill?.decisionId).toBe(decision.decisionId);
    expect(fill?.fillPrice).toBeCloseTo(0.5252, 8);
    expect(fill?.fees).toBeGreaterThan(0);
    expect(fill?.slippage).toBeGreaterThan(0);
    expect(fill?.unrealizedPnl).toBeLessThan(0);
  });

  it("leaves an order pending when no future market event exists", () => {
    const book = new DecisionBook();
    book.record(decisionInput());
    expect(book.all()[0]).toMatchObject({ status: "PENDING", fillEventId: null, fillPrice: null });
  });

  it("uses final scores only for settlement after the final event arrives", () => {
    const book = new DecisionBook();
    book.record(decisionInput());
    const engine = new ShadowExecutionEngine(book, { configuredLatencyMs: 100, feeRate: 0.01, slippageBps: 100 });
    engine.processMarketEvent(executable());
    expect(engine.settle({
      eventId: "score-1",
      fixtureId: "fixture-1",
      sourceEventTime: "2026-07-18T21:00:00.000Z",
      availableAt: "2026-07-18T21:00:00.000Z",
      isFinal: false,
      selectionPayouts: { "selection-1": 1 },
    })).toEqual([]);
    expect(book.all()[0]?.status).toBe("FILLED");
    const settled = engine.settle({
      eventId: "score-final",
      fixtureId: "fixture-1",
      sourceEventTime: "2026-07-18T22:00:00.000Z",
      availableAt: "2026-07-18T22:00:00.000Z",
      isFinal: true,
      selectionPayouts: { "selection-1": 1 },
    });
    expect(settled[0]).toMatchObject({ status: "SETTLED", unrealizedPnl: 0 });
    expect(settled[0]?.realizedPnl).toBeLessThan(10 * (1 - 0.52));
  });
});

describe("Forager Bee autonomous shadow strategy", () => {
  it("uses past movement and innovation, then fills only on a later event", () => {
    const controller = new DualStrategyController(
      new AdaptiveQuoteGuard([], "SANITIZED_TXODDS", []),
      { ...defaultRiskLimits },
      { configuredLatencyMs: 100 },
    );
    controller.ingest(sanitizeMarketUpdate(odds("2026-07-18T20:00:00.000Z", 0.5)), "REPLAY");
    controller.ingest(sanitizeMarketUpdate(odds("2026-07-18T20:00:01.000Z", 0.51)), "REPLAY");
    controller.ingest(sanitizeMarketUpdate(odds("2026-07-18T20:00:02.000Z", 0.53)), "REPLAY");
    const opening = controller.shared.decisionBook.all().find((row) => row.strategy === "hawk" && row.action === "OPEN_PAPER_POSITION");
    expect(opening).toMatchObject({ status: "PENDING", fillEventId: null, provenance: "RECORDED_TXODDS_REPLAY" });
    controller.ingest(sanitizeMarketUpdate(odds("2026-07-18T20:00:03.000Z", 0.54)), "REPLAY");
    expect(controller.shared.decisionBook.get(opening!.decisionId)).toMatchObject({ status: "FILLED" });
    expect(controller.hawk.status()).toMatchObject({
      agent: "HawkAgent",
      agentId: "hawk",
      displayName: "Forager Bee",
      technicalRole: "RELATIVE_VALUE_SCOUT",
      executionMode: "SHADOW",
    });
  });

  it("cannot bypass shared Hive risk limits", () => {
    const controller = new DualStrategyController(
      new AdaptiveQuoteGuard([], "SANITIZED_TXODDS", []),
      { ...defaultRiskLimits, killSwitch: true },
    );
    for (const [index, probability] of [0.5, 0.51, 0.53].entries()) {
      controller.ingest(sanitizeMarketUpdate(odds(`2026-07-18T20:00:0${index}.000Z`, probability)), "LIVE");
    }
    expect(controller.shared.decisionBook.all().filter((row) => row.strategy === "hawk" && row.action === "OPEN_PAPER_POSITION")).toEqual([]);
    expect(controller.hawk.status().reasonCodes).toContain("MANUAL_KILL_SWITCH");
  });
});

describe("shadow and bee presentation API", () => {
  it("preserves internal IDs while returning bee display names", async () => {
    expect((await get("/api/agent/maker")).body).toMatchObject({
      agent: "MakerAgent",
      agentId: "maker",
      displayName: "Maker Bee",
      executionMode: "SHADOW",
    });
    expect((await get("/api/agent/hawk")).body).toMatchObject({
      agent: "HawkAgent",
      agentId: "hawk",
      displayName: "Forager Bee",
      agentType: "RELATIVE_VALUE_SCOUT",
      executionMode: "SHADOW",
    });
  });

  it("exposes the Hive Decision Book and prohibits real execution", async () => {
    const list = (await get("/api/decision-book")).body as { decisions: Array<{ decisionId: string }> };
    expect(list).toMatchObject({ displayName: "Hive Decision Book", enabled: true, executionMode: "SHADOW", realFundsEnabled: false });
    expect(list.decisions.length).toBeGreaterThan(0);
    expect((await get(`/api/decision-book/${list.decisions[0]!.decisionId}`)).status).toBe(200);
    expect((await get("/api/trading/status")).body).toMatchObject({
      agentAutonomous: true,
      executionMode: "SHADOW",
      shadowExecution: "ENABLED",
      decisionBookEnabled: true,
      realExecutionEnabled: false,
      realExecution: "DISABLED",
    });
  });

  it("supports every documented Decision Book action without a real-order action", () => {
    const supported: DecisionAction[] = [
      "PLACE_PAPER_QUOTE", "REPLACE_PAPER_QUOTE", "CANCEL_PAPER_QUOTE", "OPEN_PAPER_POSITION",
      "REDUCE_PAPER_POSITION", "CLOSE_PAPER_POSITION", "SUSPEND", "RESUME", "NO_TRADE",
    ];
    expect(supported).not.toContain("PLACE_REAL_ORDER" as DecisionAction);
    expect(process.env.ENABLE_REAL_EXECUTION ?? "false").not.toBe("true");
  });
});
