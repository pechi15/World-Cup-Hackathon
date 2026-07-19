import { describe, expect, it } from "vitest";
import { ProductRuntime } from "../apps/api/src/product-runtime.js";
import { defaultRiskLimits } from "../apps/api/src/sample-data.js";
import {
  AdaptiveQuoteGuard,
  DualStrategyController,
  type SanitizedMarketEvent,
} from "../packages/live-agents/src/index.js";

function replayEnv() {
  return {
    DATA_MODE: "replay",
    DEMO_MODE: "true",
    THEO_MODE: "market_baseline",
    TRADING_MODE: "paper",
    ENABLE_MARKET_MAKING: "true",
    ENABLE_DIRECTIONAL_TRADING: "false",
    ENABLE_KELLY: "false",
    ENABLE_REAL_EXECUTION: "false",
    ENABLE_WALLET_OPERATIONS: "false",
    ENABLE_TXODDS_ACTIVATION: "false",
  };
}

function marketEvent(timestamp: string, probability: number, messageId: string): SanitizedMarketEvent {
  return {
    timestamp,
    fixtureId: "fixture-sync",
    marketId: "market-sync",
    marketType: "MATCH_WINNER",
    marketParameters: null,
    marketPeriod: "PRE_MATCH",
    inRunning: false,
    selectionIds: ["selection-sync"],
    selectionLabels: ["Selection"],
    marketProbabilities: [probability],
    probabilityField: "STABLE_PRICE",
    demarginingStatus: "VERIFIED_ALREADY_DEMARGINED",
    messageId,
    reasonCodes: ["TEST_SANITIZED"],
  };
}

describe("replay pre-event and reset semantics", () => {
  it("loads at cursor zero with no strategy output", () => {
    const runtime = new ProductRuntime(replayEnv());
    const state = runtime.state();
    expect(state).toMatchObject({ replayStatus: "READY", currentIndex: 0 });
    expect(runtime.agents.maker.status()).toMatchObject({
      state: "IDLE",
      latestAction: "NONE",
      bid: null,
      ask: null,
      width: null,
      size: null,
      inventoryLean: 0,
      quoteRiskScore: null,
      activeQuote: null,
      eventIndex: 0,
      reasonCodes: ["WAITING_FOR_FIRST_MARKET_EVENT"],
    });
    expect(runtime.agents.hawk.status()).toMatchObject({
      state: "READY",
      latestAction: "NONE",
      signalType: "NONE",
      signalConfidence: null,
      paperPosition: 0,
      reasonCodes: ["WAITING_FOR_FIRST_MARKET_EVENT"],
    });
    expect(runtime.agents.shared.status()).toMatchObject({ state: "ARMED", exposure: 0, drawdown: 0, killSwitch: "OFF" });
    expect(runtime.agents.shared.decisionBook.all()).toEqual([]);
    runtime.stop();
  });

  it("processes exactly one event on the first Step and publishes one synchronized snapshot", () => {
    const runtime = new ProductRuntime(replayEnv());
    const first = runtime.stepReplay();
    const maker = runtime.agents.maker.status();
    const chart = first.chart.at(-1);
    expect(first.currentIndex).toBe(1);
    expect(maker.eventIndex).toBe(1);
    expect(maker.latestAction).toBe("PLACE_QUOTES");
    expect(maker.activeQuote).toMatchObject({ createdAtEventIndex: 1, validThroughEventIndex: 1, status: "ACTIVE" });
    expect(runtime.agents.shared.decisionBook.all().length).toBeGreaterThan(0);
    expect(chart).toMatchObject({
      index: 1,
      fixtureId: maker.currentMarketObservation?.fixtureId,
      marketId: maker.currentMarketObservation?.marketId,
      selectionId: maker.currentMarketObservation?.selectionId,
      bid: maker.activeQuote?.bid,
      ask: maker.activeQuote?.ask,
    });
    runtime.stop();
  });

  it("Resume advances a ready replay by exactly one event before scheduling later events", () => {
    const runtime = new ProductRuntime(replayEnv());
    const resumed = runtime.resumeReplay();
    expect(resumed).toMatchObject({ replayStatus: "RUNNING", currentIndex: 1 });
    expect(runtime.agents.maker.status()).toMatchObject({ eventIndex: 1, latestAction: "PLACE_QUOTES" });
    runtime.pauseReplay();
    runtime.stop();
  });

  it("reset clears run state and reproduces the deterministic first decision", () => {
    const runtime = new ProductRuntime(replayEnv());
    runtime.stepReplay();
    runtime.stepReplay();
    const firstDecision = runtime.agents.shared.decisionBook.all()[0];
    expect(firstDecision).toBeDefined();
    runtime.resetReplay();
    expect(runtime.state()).toMatchObject({ currentIndex: 0, positions: [], makerFills: [] });
    expect(runtime.state().performance).toMatchObject({ netPnl: 0, grossPnl: 0 });
    expect(runtime.agents.maker.status().activeQuote).toBeNull();
    expect(runtime.agents.hawk.status().paperPosition).toBe(0);
    expect(runtime.agents.shared.decisionBook.all()).toEqual([]);
    runtime.stepReplay();
    const repeated = runtime.agents.shared.decisionBook.all()[0];
    expect(repeated).toMatchObject({
      sourceEventId: firstDecision!.sourceEventId,
      action: firstDecision!.action,
      side: firstDecision!.side,
      proposedPrice: firstDecision!.proposedPrice,
      proposedSize: firstDecision!.proposedSize,
    });
    runtime.stop();
  });

  it("selecting another replay starts a new empty run", () => {
    const runtime = new ProductRuntime(replayEnv());
    runtime.stepReplay();
    const previousRunId = runtime.agents.maker.status().runId;
    const selected = runtime.selectReplay("historical-recorded");
    expect(selected.currentIndex).toBe(0);
    expect(runtime.agents.maker.status()).toMatchObject({ eventIndex: 0, activeQuote: null, latestAction: "NONE" });
    expect(runtime.agents.maker.status().runId).not.toBe(previousRunId);
    expect(runtime.agents.shared.decisionBook.all()).toEqual([]);
    runtime.stop();
  });
});

describe("Maker quote replacement semantics", () => {
  it("holds an immaterial quote and replaces it after a material market move", () => {
    const guard = new AdaptiveQuoteGuard([], "DETERMINISTIC_REPLAY", ["REPLAY_DEMONSTRATION"]);
    const controller = new DualStrategyController(guard, { ...defaultRiskLimits });
    controller.reset("replay-sync");
    controller.ingest(marketEvent("2026-07-19T12:00:00.000Z", 0.5, "one"), "REPLAY", undefined, { runId: "replay-sync", eventIndex: 1 });
    const placed = controller.maker.status();
    controller.ingest(marketEvent("2026-07-19T12:00:01.000Z", 0.5005, "two"), "REPLAY", undefined, { runId: "replay-sync", eventIndex: 2 });
    const held = controller.maker.status();
    expect(held).toMatchObject({ latestAction: "HOLD_QUOTES", eventIndex: 2 });
    expect(held.reasonCodes).toContain("REPLACEMENT_THRESHOLD_NOT_MET");
    expect(held.activeQuote).toMatchObject({
      bid: placed.activeQuote?.bid,
      ask: placed.activeQuote?.ask,
      createdAtEventIndex: 1,
      validThroughEventIndex: 2,
    });
    controller.ingest(marketEvent("2026-07-19T12:00:02.000Z", 0.54, "three"), "REPLAY", undefined, { runId: "replay-sync", eventIndex: 3 });
    const replaced = controller.maker.status();
    expect(replaced).toMatchObject({ latestAction: "REPLACE_QUOTES", eventIndex: 3 });
    expect(replaced.reasonCodes).toContain("MARKET_REFERENCE_MOVED");
    expect(replaced.activeQuote?.createdAtEventIndex).toBe(3);
    expect(replaced.activeQuote?.bid).not.toBe(placed.activeQuote?.bid);
  });

  it("risk controls can suspend and clear the active quote", () => {
    const controller = new DualStrategyController(
      new AdaptiveQuoteGuard([], "DETERMINISTIC_REPLAY", ["REPLAY_DEMONSTRATION"]),
      { ...defaultRiskLimits },
    );
    controller.ingest(marketEvent("2026-07-19T12:00:00.000Z", 0.5, "one"), "REPLAY");
    controller.shared.setControlState({ staleDataKillSwitch: true });
    controller.ingest(marketEvent("2026-07-19T12:00:01.000Z", 0.51, "two"), "REPLAY");
    expect(controller.maker.status()).toMatchObject({ state: "SUSPENDED", latestAction: "CANCEL_QUOTES", bid: null, ask: null });
  });
});
