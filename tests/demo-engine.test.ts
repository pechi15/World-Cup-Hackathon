import { describe, expect, it } from "vitest";
import { DemoReplayEngine } from "../packages/demo/src/engine.js";
import { BenchmarkStateSpaceTheoProvider } from "../packages/theo/src/benchmark.js";

describe("deterministic demo replay", () => {
  it("replays deterministically after reset", () => {
    const engine = new DemoReplayEngine("replay", true);
    engine.start();
    for (let i = 0; i < 25; i += 1) engine.step();
    const first = engine.getState();
    engine.reset();
    engine.start();
    for (let i = 0; i < 25; i += 1) engine.step();
    const second = engine.getState();
    expect(second.currentIndex).toBe(first.currentIndex);
    expect(second.marketRows.map((row) => row.marketProbability)).toEqual(first.marketRows.map((row) => row.marketProbability));
    expect(second.performance.netPnl).toBe(first.performance.netPnl);
  });

  it("supports start pause resume speed and shock controls", () => {
    const engine = new DemoReplayEngine("replay", true);
    engine.start();
    expect(engine.getState().replayStatus).toBe("RUNNING");
    engine.pause();
    expect(engine.getState().replayStatus).toBe("PAUSED");
    engine.setSpeed(20);
    engine.resume();
    engine.tick();
    engine.injectShock();
    const state = engine.getState();
    expect(state.speed).toBe(20);
    expect(state.audit.some((event) => event.finalAction === "INFO_SHOCK")).toBe(true);
  });

  it("creates maker and directional paper fills and complete audit rows", () => {
    const engine = new DemoReplayEngine("replay", true);
    engine.start();
    for (let i = 0; i < 100; i += 1) engine.step();
    const state = engine.getState();
    expect(state.positions.length).toBeGreaterThan(0);
    expect(state.positions.some((position) => position.makerQuantity > 0)).toBe(true);
    expect(state.positions.some((position) => position.takerQuantity > 0)).toBe(true);
    expect(state.audit.every((event) => event.riskChecks.includes("PAPER_ONLY"))).toBe(true);
  });

  it("settles and reports risk and performance", () => {
    const engine = new DemoReplayEngine("replay", true);
    engine.start();
    for (let i = 0; i < 140; i += 1) engine.step();
    const state = engine.getState();
    expect(state.replayStatus).toBe("COMPLETE");
    expect(state.risk.scenarios.length).toBeGreaterThanOrEqual(8);
    expect(state.performance.turnover).toBeGreaterThan(0);
  });
});

describe("benchmark theo restrictions", () => {
  it("is available only in demo replay or synthetic mode", () => {
    const provider = new BenchmarkStateSpaceTheoProvider();
    const replayTheo = provider.getTheo({ marketId: "m", selectionId: "s", observedProbability: 0.55, previousTheo: null, dataMode: "replay", demoMode: true });
    expect(replayTheo.status).toBe("AVAILABLE");
    expect(replayTheo.source).toBe("BENCHMARK_THEO");
    const txlineTheo = provider.getTheo({ marketId: "m", selectionId: "s", observedProbability: 0.55, previousTheo: null, dataMode: "txline", demoMode: true });
    expect(txlineTheo.probabilities).toBeNull();
    expect(txlineTheo.reasonCodes).toContain("APPROVED_RESEARCH_MODEL_NOT_CONNECTED");
  });
});
