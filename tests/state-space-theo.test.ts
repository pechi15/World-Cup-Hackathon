import { describe, expect, it } from "vitest";
import {
  EventStore,
  mapOddsUpdateToMarket,
  proportionalDevig,
  selectMarketProbabilities,
  toNormalizedMarketObservation,
  type NormalizedEvent,
  type TxlineOddsUpdate,
} from "../packages/market-data/src/index.js";
import {
  PipelineTheoProvider,
  resolveResearchTheoMode,
  type StateSpaceEstimate,
} from "../packages/theo/src/index.js";
import { compareWithMarketBaseline } from "../packages/evaluation/src/index.js";

const start = Date.parse("2026-07-18T12:00:00.000Z");

function update(message: number, prices: number[], timestamp = start + message * 15_000): TxlineOddsUpdate {
  return {
    FixtureId: 1,
    MessageId: `message-${message}`,
    Ts: timestamp,
    Bookmaker: "ResearchReplay",
    BookmakerId: 7,
    SuperOddsType: "MATCH_RESULT_1X2",
    MarketPeriod: "FULL_MATCH",
    PriceNames: ["Home", "Draw", "Away"],
    Prices: [...prices],
    Pct: ["0", "0", "0"],
  };
}

function replayEvents(...updates: TxlineOddsUpdate[]): NormalizedEvent[] {
  const store = new EventStore();
  store.loadUpdates(updates, "REPLAY");
  return store.events();
}

function probabilities(estimate: StateSpaceEstimate): number[] {
  expect(estimate.probabilities).not.toBeNull();
  return Object.values(estimate.probabilities!);
}

describe("TxLINE probability semantics and provenance", () => {
  it("selects raw decimal Prices for replay and de-vigs exactly once", () => {
    const selected = selectMarketProbabilities(update(0, [2.1, 3.4, 3.5]));
    expect(selected.field).toBe("PRICES_DECIMAL");
    expect(selected.demarginingStatus).toBe("VERIFIED_RAW_REQUIRES_DEVIG");
    expect(selected.reasonCodes).toContain("DEVIG_APPLIED_ONCE");
    expect(selected.probabilities.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
  });

  it("uses StablePrice without a second de-vig and rejects an explicit double de-vig", () => {
    const stable = {
      ...update(0, [2.1, 3.4, 3.5]),
      StablePrice: [0.5, 0.3, 0.2],
    };
    const selected = selectMarketProbabilities(stable);
    expect(selected.field).toBe("STABLE_PRICE");
    expect(selected.demarginingStatus).toBe("VERIFIED_ALREADY_DEMARGINED");
    expect(selected.probabilities).toEqual([0.5, 0.3, 0.2]);
    expect(() => proportionalDevig(selected.probabilities, "ALREADY_DEMARGINED")).toThrow("DOUBLE_DEVIG_FORBIDDEN");
  });

  it("preserves immutable raw Prices, Pct, StablePrice, and provenance", () => {
    const original = {
      ...update(0, [2.1, 3.4, 3.5]),
      StablePrice: [0.5, 0.3, 0.2],
    };
    const store = new EventStore();
    store.loadUpdates([original]);
    original.Prices[0] = 99;
    original.Pct![0] = "99";
    original.StablePrice![0] = 0.99;

    const raw = store.rawRecords()[0];
    expect(raw.body.Prices).toEqual([2.1, 3.4, 3.5]);
    expect(raw.body.Pct).toEqual(["0", "0", "0"]);
    expect(raw.body.StablePrice).toEqual([0.5, 0.3, 0.2]);
    const observation = toNormalizedMarketObservation(store.events()[0]);
    expect(observation.raw).toEqual({
      Prices: [2.1, 3.4, 3.5],
      Pct: ["0", "0", "0"],
      StablePrice: [0.5, 0.3, 0.2],
    });
    expect(observation.provenance.dataMode).toBe("REPLAY");
    expect(observation.provenance.messageId).toBe("message-0");
  });

  it("does not deduplicate identical prices from different bookmakers", () => {
    const first = update(0, [2.1, 3.4, 3.5]);
    delete first.MessageId;
    const second = { ...first, Bookmaker: "OtherBook", BookmakerId: 8 };
    const store = new EventStore();
    store.loadUpdates([first, second]);
    expect(store.uniqueCount()).toBe(2);
  });
});

describe("StateSpaceTheo latent log-odds filter", () => {
  it("filters normalized replay observations and reports posterior diagnostics", async () => {
    const [first, second] = replayEvents(
      update(0, [2.1, 3.4, 3.5]),
      update(1, [1.6, 4.0, 5.0]),
    );
    const market = mapOddsUpdateToMarket(first.update);
    const pipeline = new PipelineTheoProvider("REPLAY");
    pipeline.ingestEvent(first);
    const initial = await pipeline.getTheo({ market, asOf: first.eventTime });
    pipeline.ingestEvent(second);
    const posterior = await pipeline.getTheo({ market, asOf: second.eventTime });
    const observed = toNormalizedMarketObservation(second).probabilities[0];
    const initialHome = initial.probabilities![market.selections[0].selectionId];
    const posteriorHome = posterior.probabilities![market.selections[0].selectionId];

    expect(posteriorHome).toBeGreaterThan(initialHome);
    expect(posteriorHome).toBeLessThan(observed);
    expect(posterior.posteriorProbabilities).toEqual(posterior.probabilities);
    expect(posterior.innovation).not.toBeNull();
    expect(posterior.standardizedInnovation).not.toBeNull();
    expect(posterior.standardizedInnovationMagnitude).toBeGreaterThan(0);
    expect(posterior.uncertainty).toBeGreaterThan(0);
  });

  it("increases uncertainty for missing and stale observations", async () => {
    const [event] = replayEvents(update(0, [2.1, 3.4, 3.5]));
    const market = mapOddsUpdateToMarket(event.update);
    const pipeline = new PipelineTheoProvider("REPLAY", {
      processVariance: 0.01,
      staleAfterMs: 30_000,
      processIntervalMs: 15_000,
    });
    pipeline.ingestEvent(event);
    const fresh = await pipeline.getTheo({ market, asOf: event.eventTime });
    const staleAsOf = new Date(Date.parse(event.eventTime) + 60_000).toISOString();
    const stale = await pipeline.getTheo({ market, asOf: staleAsOf });

    expect(stale.status).toBe("STALE");
    expect(stale.reasonCodes).toContain("MISSING_OBSERVATION_PREDICTION_ONLY");
    expect(stale.reasonCodes).toContain("STALE_OBSERVATION");
    expect(stale.uncertainty!).toBeGreaterThan(fresh.uncertainty!);
  });

  it("returns insufficient data when an observation is missing", async () => {
    const [event] = replayEvents(update(0, [2.1, 3.4, 3.5]));
    const market = mapOddsUpdateToMarket(event.update);
    const pipeline = new PipelineTheoProvider("REPLAY");
    const estimate = await pipeline.getTheo({ market, asOf: event.eventTime });
    expect(estimate.status).toBe("INSUFFICIENT_DATA");
    expect(estimate.reasonCodes).toContain("MISSING_OBSERVATION");
    expect(estimate.probabilities).toBeNull();
  });

  it("applies larger process variance once after an information shock", async () => {
    const [event] = replayEvents(update(0, [2.1, 3.4, 3.5]));
    const market = mapOddsUpdateToMarket(event.update);
    const regular = new PipelineTheoProvider("REPLAY", {
      processVariance: 0.001,
      informationShockProcessVariance: 0.2,
    });
    const shocked = new PipelineTheoProvider("REPLAY", {
      processVariance: 0.001,
      informationShockProcessVariance: 0.2,
    });
    regular.ingestEvent(event);
    shocked.ingestEvent(event);
    await regular.getTheo({ market, asOf: event.eventTime });
    await shocked.getTheo({ market, asOf: event.eventTime });
    shocked.signalEventShock(market.marketId);
    const nextAsOf = new Date(Date.parse(event.eventTime) + 15_000).toISOString();
    const regularPrediction = await regular.getTheo({ market, asOf: nextAsOf });
    const shockedPrediction = await shocked.getTheo({ market, asOf: nextAsOf });

    expect(shockedPrediction.uncertainty!).toBeGreaterThan(regularPrediction.uncertainty!);
  });

  it("keeps all posterior probabilities bounded and summing to one", async () => {
    const events = replayEvents(
      update(0, [100, 1.01, 50]),
      update(1, [1.001, 100, 100]),
    );
    const market = mapOddsUpdateToMarket(events[0].update);
    const pipeline = new PipelineTheoProvider("REPLAY");
    for (const event of events) {
      pipeline.ingestEvent(event);
      const estimate = await pipeline.getTheo({ market, asOf: event.eventTime });
      const values = probabilities(estimate);
      expect(values.every((value) => value >= 0 && value <= 1)).toBe(true);
      expect(values.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    }
  });

  it("is reproducible for the same ordered replay", async () => {
    const events = replayEvents(
      update(0, [2.1, 3.4, 3.5]),
      update(1, [1.9, 3.6, 3.9]),
      update(2, [1.4, 4.5, 7]),
    );
    const market = mapOddsUpdateToMarket(events[0].update);
    const run = async () => {
      const pipeline = new PipelineTheoProvider("REPLAY");
      const outputs: StateSpaceEstimate[] = [];
      for (const event of events) {
        pipeline.ingestEvent(event);
        outputs.push(await pipeline.getTheo({ market, asOf: event.eventTime }));
      }
      return outputs;
    };
    expect(await run()).toEqual(await run());
  });

  it("rejects future observations without mutating filter state", async () => {
    const [future] = replayEvents(update(1, [1.8, 3.7, 4.1]));
    const market = mapOddsUpdateToMarket(future.update);
    const guarded = new PipelineTheoProvider("REPLAY");
    guarded.ingestEvent(future);
    const before = new Date(Date.parse(future.eventTime) - 1).toISOString();
    const rejected = await guarded.getTheo({ market, asOf: before });
    expect(rejected.status).toBe("MODEL_ERROR");
    expect(rejected.reasonCodes).toContain("LOOKAHEAD_OBSERVATION_REJECTED");

    const afterRejection = await guarded.getTheo({ market, asOf: future.eventTime });
    const clean = new PipelineTheoProvider("REPLAY");
    clean.ingestEvent(future);
    const expected = await clean.getTheo({ market, asOf: future.eventTime });
    expect(afterRejection).toEqual(expected);
  });

  it("rejects an observation not yet received at the forecast time", async () => {
    const [event] = replayEvents(update(0, [2.1, 3.4, 3.5]));
    const delayed = {
      ...event,
      receiveTime: new Date(Date.parse(event.eventTime) + 30_000).toISOString(),
    };
    const market = mapOddsUpdateToMarket(event.update);
    const pipeline = new PipelineTheoProvider("REPLAY");
    pipeline.ingestEvent(delayed);
    const estimate = await pipeline.getTheo({ market, asOf: event.eventTime });
    const baseline = await pipeline.getBaseline({ market, asOf: event.eventTime });
    expect(estimate.status).toBe("MODEL_ERROR");
    expect(estimate.reasonCodes).toContain("LOOKAHEAD_OBSERVATION_REJECTED");
    expect(baseline.status).toBe("MODEL_ERROR");
    expect(baseline.reasonCodes).toContain("LOOKAHEAD_OBSERVATION_REJECTED");
  });

  it("does not let a prediction-only query alter a later filter update", async () => {
    const [first, second] = replayEvents(
      update(0, [2.1, 3.4, 3.5]),
      update(1, [1.9, 3.6, 3.9]),
    );
    const market = mapOddsUpdateToMarket(first.update);
    const queried = new PipelineTheoProvider("REPLAY");
    queried.ingestEvent(first);
    await queried.getTheo({ market, asOf: first.eventTime });
    await queried.getTheo({
      market,
      asOf: new Date(Date.parse(second.eventTime) + 60_000).toISOString(),
    });
    queried.ingestEvent(second);
    const afterForecastQuery = await queried.getTheo({ market, asOf: second.eventTime });

    const clean = new PipelineTheoProvider("REPLAY");
    clean.ingestEvent(first);
    await clean.getTheo({ market, asOf: first.eventTime });
    clean.ingestEvent(second);
    const expected = await clean.getTheo({ market, asOf: second.eventTime });
    expect(afterForecastQuery).toEqual(expected);
  });
});

describe("research exposure and proper-score benchmark", () => {
  it("defaults to Null mode unless REPLAY or RESEARCH is explicit", () => {
    expect(resolveResearchTheoMode(undefined)).toBeNull();
    expect(resolveResearchTheoMode("production")).toBeNull();
    expect(resolveResearchTheoMode("replay")).toBe("REPLAY");
    expect(resolveResearchTheoMode("RESEARCH")).toBe("RESEARCH");
  });

  it("computes paired Brier score and log loss when outcomes are available", () => {
    const outcomeSelectionId = "home";
    const comparison = compareWithMarketBaseline(
      [{
        pairingKey: "fixture-1:market-1",
        forecastTime: "2026-07-18T12:00:00.000Z",
        probabilities: { home: 0.6, draw: 0.25, away: 0.15 },
        outcomeSelectionId,
      }],
      [{
        pairingKey: "fixture-1:market-1",
        forecastTime: "2026-07-18T12:00:00.000Z",
        probabilities: { home: 0.5, draw: 0.3, away: 0.2 },
        outcomeSelectionId,
      }],
    );
    expect(comparison.stateSpace.sampleSize).toBe(1);
    expect(comparison.stateSpace.brierScore).toBeCloseTo(0.245, 12);
    expect(comparison.marketBaseline.brierScore).toBeCloseTo(0.38, 12);
    expect(comparison.stateSpace.logLoss).toBeCloseTo(-Math.log(0.6), 12);
    expect(comparison.marketBaseline.logLoss).toBeCloseTo(-Math.log(0.5), 12);
    expect(comparison.reasonCodes).toContain("NO_ALPHA_CLAIM");
  });

  it("refuses to invent benchmark results when replay outcomes are absent", () => {
    const comparison = compareWithMarketBaseline([], []);
    expect(comparison.stateSpace.sampleSize).toBe(0);
    expect(comparison.brierDifference).toBeNull();
    expect(comparison.logLossDifference).toBeNull();
    expect(comparison.reasonCodes).toContain("NO_OUTCOMES_AVAILABLE");
  });
});
