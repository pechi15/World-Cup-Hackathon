import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventStore, ReplayTxoddsAdapter, mapOddsUpdateToTicks, proportionalDevig, decimalOddsToImplied } from "../packages/market-data/src/index.js";
import { PipelineTheoProvider, NullTheoProvider } from "../packages/theo/src/index.js";
import { ReplayClock } from "../packages/replay/src/index.js";
import { AutonomousTradingLoop } from "../packages/agent/src/index.js";
import { defaultRiskLimits } from "../apps/api/src/sample-data.js";
import { generateQuote, defaultQuoteConfig } from "../packages/quoting/src/index.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const replayPath = path.resolve(root, "../data/samples/txodds/sanitized/replay-fixture.json");

function loadReplay() {
  const raw = JSON.parse(fs.readFileSync(replayPath, "utf8")) as {
    fixture: Parameters<ReplayTxoddsAdapter["loadFixtures"]>[0][number];
    updates: Parameters<ReplayTxoddsAdapter["loadOddsUpdates"]>[0];
  };
  const adapter = new ReplayTxoddsAdapter();
  adapter.loadFixtures([raw.fixture]);
  adapter.loadOddsUpdates(raw.updates);
  return { adapter, raw };
}

describe("mapper and de-vig", () => {
  it("maps decimal odds to probabilities that sum to one after de-vig", () => {
    const implied = [2.1, 3.4, 3.5].map(decimalOddsToImplied);
    const fair = proportionalDevig(implied, "RAW_BOOK_IMPLIED");
    expect(fair.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(fair.every((p) => p > 0 && p < 1)).toBe(true);
  });

  it("produces ticks from TxLINE-shaped updates", () => {
    const { raw } = loadReplay();
    const ticks = mapOddsUpdateToTicks(raw.updates[0], "REPLAY");
    expect(ticks).toHaveLength(3);
    expect(ticks[0].provenance.source).toBe("REPLAY");
  });
});

describe("event store dedupe", () => {
  it("deduplicates identical updates", () => {
    const { raw } = loadReplay();
    const store = new EventStore();
    store.loadUpdates([raw.updates[0], raw.updates[0], raw.updates[1]]);
    expect(store.rawCount()).toBe(3);
    expect(store.uniqueCount()).toBe(2);
    expect(store.duplicateRate()).toBeCloseTo(1 / 3, 5);
  });
});

describe("theo pipeline", () => {
  it("keeps NullTheoProvider awaiting behavior", async () => {
    const { adapter } = loadReplay();
    const markets = await adapter.discoverMarkets();
    const theo = await new NullTheoProvider().getTheo({ market: markets[0] });
    expect(theo.status).toBe("AWAITING_TXODDS_API");
    expect(theo.probabilities).toBeNull();
  });

  it("MarketBaseline is labeled benchmark only", async () => {
    const { adapter } = loadReplay();
    const markets = await adapter.discoverMarkets();
    const event = adapter.store.events().at(-1)!;
    const pipeline = new PipelineTheoProvider("REPLAY");
    pipeline.ingestEvent(event);
    const theo = await pipeline.getBaseline({ market: markets[0] });
    expect(theo.status).toBe("AVAILABLE");
    expect(theo.modelVersion).toContain("MARKET_BASELINE");
    expect(theo.reasonCodes).toContain("BENCHMARK_ONLY");
    expect(theo.reasonCodes).toContain("NOT_PROPRIETARY_ALPHA");
  });

  it("state-space residual theo becomes AVAILABLE and enables LIVE quotes", async () => {
    const { adapter } = loadReplay();
    const markets = await adapter.discoverMarkets();
    const event = adapter.store.events().at(-1)!;
    const pipeline = new PipelineTheoProvider("REPLAY");
    pipeline.ingestEvent(event);
    const theo = await pipeline.getTheo({ market: markets[0], asOf: event.eventTime });
    expect(theo.probabilities).not.toBeNull();
    const quote = generateQuote({
      market: markets[0],
      selectionId: markets[0].selections[0].selectionId,
      theo,
      recentVolatility: 0.01,
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
    expect(quote.status).toBe("LIVE");
    expect(quote.bid).not.toBeNull();
  });
});

describe("autonomous replay loop", () => {
  it("replays fixture end-to-end and records shock suspension reason codes", async () => {
    const { adapter } = loadReplay();
    const clock = new ReplayClock(adapter.store.events());
    const loop = new AutonomousTradingLoop({
      riskLimits: defaultRiskLimits,
      bankroll: 100_000,
      kellyFraction: 0.1,
      makerFillProbability: 0.5,
      innovationSuspendThreshold: 1.0,
    });
    while (true) {
      const event = clock.step();
      if (!event) break;
      await loop.onEvent(event);
    }
    expect(loop.state.audit.length).toBeGreaterThan(5);
    const shock = loop.state.audit.find((a) => a.reasonCodes.includes("INNOVATION_SHOCK_WIDEN_OR_SUSPEND"));
    expect(shock).toBeTruthy();
    const withTheo = loop.state.audit.find((a) => a.theo != null);
    expect(withTheo).toBeTruthy();
    expect(withTheo?.uncertainty).not.toBeNull();
    // Deterministic second run
    const loop2 = new AutonomousTradingLoop({
      riskLimits: defaultRiskLimits,
      bankroll: 100_000,
      kellyFraction: 0.1,
      makerFillProbability: 0.5,
      innovationSuspendThreshold: 1.0,
    });
    const clock2 = new ReplayClock(adapter.store.events());
    while (true) {
      const event = clock2.step();
      if (!event) break;
      await loop2.onEvent(event);
    }
    expect(loop2.state.audit.map((a) => a.theo)).toEqual(loop.state.audit.map((a) => a.theo));
  });
});
