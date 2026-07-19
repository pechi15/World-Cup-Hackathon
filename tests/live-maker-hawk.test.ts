import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { defaultRiskLimits, markets } from "../apps/api/src/sample-data.js";
import { route } from "../apps/api/src/server.js";
import {
  AdaptiveQuoteGuard,
  DualStrategyController,
  buildCurrentFixtureSample,
  buildHistoricalReplay,
  containsCredentialMaterial,
  findFixtureByTeams,
  findScoreFixtureByTeams,
  loadAdaptiveQuoteGuard,
  sanitizeMarketUpdate,
  type QuoteGuardRow,
} from "../packages/live-agents/src/index.js";
import type { TxlineFixtureRow, TxlineOddsUpdate, TxlineScoreEvent } from "../packages/market-data/src/index.js";

const root = path.resolve(import.meta.dirname, "..");
const quoteGuardDirectory = path.join(root, "data", "samples", "demo", "adaptive-quote-guard");
const currentPath = path.join(root, "data", "samples", "txodds", "current", "argentina-spain.json");
const replayPath = path.join(root, "data", "samples", "txodds", "replay", "england-france-third-place.json");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const fixtureRows: TxlineFixtureRow[] = [
  { FixtureId: 1, Participant1: "Spain", Participant2: "Argentina", StartTime: Date.parse("2026-07-19T19:00:00Z") },
  { FixtureId: 2, Participant1: "Other", Participant2: "Teams" },
];

const scoreRows: TxlineScoreEvent[] = [{
  FixtureId: 3,
  Participant1Id: 1999,
  Participant2Id: 1888,
  Participant1IsHome: true,
  StartTime: Date.parse("2026-07-18T21:00:00Z"),
  Ts: Date.parse("2026-07-18T20:00:00Z"),
  Action: "lineups",
  Lineups: [
    { normativeId: 1999, preferredName: "France" },
    { normativeId: 1888, preferredName: "England" },
  ],
}];

function update(timestamp: string, probability = 0.5): TxlineOddsUpdate {
  const other = 1 - probability;
  return {
    FixtureId: 3,
    MessageId: timestamp,
    Ts: Date.parse(timestamp),
    Bookmaker: "TxLineStablePriceDemargined",
    SuperOddsType: "BINARY",
    MarketPeriod: "FULL_MATCH",
    PriceNames: ["Yes", "No"],
    Prices: [1 / probability, 1 / other],
  };
}

function finalScore(): TxlineScoreEvent {
  return {
    FixtureId: 3,
    Ts: Date.parse("2026-07-18T23:06:54.839Z"),
    Action: "game_finalised",
    StatusId: 100,
    Score: {
      Participant1: { Total: { Goals: 4 } },
      Participant2: { Total: { Goals: 6 } },
    },
  };
}

function guardRow(timestamp: string, riskScore: number): QuoteGuardRow {
  return {
    timestamp,
    fixtureId: "3",
    marketId: "3:BINARY::FULL_MATCH",
    selectionId: "3:BINARY::FULL_MATCH:1:No",
    marketProbability: 0.5,
    regime: riskScore > 0.8 ? "SHOCK" : "VOLATILE",
    riskScore,
    widthMultiplier: 1 + 1.75 * riskScore,
    sizeMultiplier: Math.max(0.15, (1 - riskScore) ** 2),
    recommendedAction: riskScore > 0.8 ? "SUSPEND" : "DEFENSIVE",
    provenance: "SANITIZED_TXODDS",
    featureDrivers: ["ewma_volatility"],
    lookaheadUsed: false,
    maxSourceTimestampUsed: timestamp,
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

describe("fixture discovery and sanitized captures", () => {
  it("matches Argentina and Spain regardless of participant order", () => {
    const match = findFixtureByTeams(fixtureRows, "Argentina", "Spain");
    expect(match?.fixtureId).toBe("1");
    expect(findFixtureByTeams(fixtureRows, "Spain", "Argentina")?.fixtureId).toBe("1");
  });

  it("discovers England and France from returned score metadata without a fixture id constant", () => {
    const match = findScoreFixtureByTeams(scoreRows, "England", "France");
    expect(match?.fixtureId).toBe("3");
    expect(match?.participant1).toBe("France");
    expect(match?.participant2).toBe("England");
  });

  it("does not fabricate a result for the future Argentina-Spain fixture", () => {
    const match = findFixtureByTeams(fixtureRows, "Argentina", "Spain")!;
    const sample = buildCurrentFixtureSample({
      match,
      snapshotUpdates: [],
      streamUpdates: [],
      capturedAt: "2026-07-19T10:00:00Z",
      stream: { attempted: true, available: true, quiet: true, fallbackPollPerformed: true },
    }) as Record<string, unknown>;
    expect(sample.finalState).toBeNull();
    expect(sample.resultStatus).toBe("FUTURE_FIXTURE_NO_RESULT");
    expect(sample.reasonCodes).toContain("RESULT_NOT_FABRICATED");
  });

  it("preserves recorded TxODDS replay provenance, the verified final, and deterministic output", () => {
    const match = findScoreFixtureByTeams(scoreRows, "England", "France")!;
    const input = { match, oddsUpdates: [update("2026-07-18T20:00:00Z")], scoreEvents: [...scoreRows, finalScore()], discoveredEpochDay: 20652 };
    const first = buildHistoricalReplay(input) as Record<string, unknown>;
    const second = buildHistoricalReplay(input) as Record<string, unknown>;
    expect(first.provenance).toBe("RECORDED_TXODDS_REPLAY");
    expect(first.finalResultVerified).toBe(true);
    expect(first.resultFabricated).toBe(false);
    expect(first).toEqual(second);
  });

  it("commits sanitized samples with no credential material", () => {
    const current = JSON.parse(fs.readFileSync(currentPath, "utf8"));
    const replay = JSON.parse(fs.readFileSync(replayPath, "utf8"));
    expect(containsCredentialMaterial(current)).toBe(false);
    expect(containsCredentialMaterial(replay)).toBe(false);
    expect(JSON.stringify([current, replay])).not.toMatch(/Bearer\s|authorization|api.?token|guest.?jwt/i);
  });
});

describe("Adaptive Quote Guard", () => {
  it("validates the integrated checksums and provenance", () => {
    const guard = loadAdaptiveQuoteGuard(quoteGuardDirectory);
    expect(guard.validatedChecksums).toBe(true);
    expect(guard.provenance).toBe("SANITIZED_TXODDS");
    expect(guard.status().forbiddenEffects).toContain("QUOTE_CENTRE");
  });

  it("rejects a tampered integrated artifact", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "quote-guard-test-"));
    temporaryDirectories.push(temporary);
    fs.cpSync(quoteGuardDirectory, temporary, { recursive: true });
    fs.appendFileSync(path.join(temporary, "metrics.json"), " ");
    expect(() => loadAdaptiveQuoteGuard(temporary)).toThrow("QUOTE_GUARD_CHECKSUM_MISMATCH:metrics.json");
  });

  it("never looks ahead and leaves unrelated fixtures on baseline policy", () => {
    const row = guardRow("2026-07-18T20:00:10Z", 0.5);
    const guard = new AdaptiveQuoteGuard([row], "SANITIZED_TXODDS", ["PAPER_ONLY"]);
    expect(guard.lookup({ ...row, timestamp: "2026-07-18T20:00:00Z" }).available).toBe(false);
    expect(guard.lookup({ ...row, fixtureId: "other", timestamp: "2026-07-18T21:00:00Z" }).available).toBe(false);
  });
});

describe("shared Maker and Hawk controller", () => {
  it("lets Maker act autonomously and replace its own paper quotes", () => {
    const guard = new AdaptiveQuoteGuard([], "SANITIZED_TXODDS", ["PAPER_ONLY"]);
    const controller = new DualStrategyController(guard, { ...defaultRiskLimits });
    const event = sanitizeMarketUpdate(update("2026-07-18T20:00:00Z"));
    controller.ingest(event, "LIVE");
    expect(controller.maker.status().latestAction).toBe("PLACE_QUOTES");
    controller.ingest(sanitizeMarketUpdate(update("2026-07-18T20:00:01Z", 0.51)), "LIVE");
    expect(controller.maker.status().latestAction).toBe("REPLACE_QUOTES");
  });

  it("keeps Hawk monitoring and abstaining without an independent theo", () => {
    const controller = new DualStrategyController(new AdaptiveQuoteGuard([], "SANITIZED_TXODDS", []), { ...defaultRiskLimits });
    controller.ingest(sanitizeMarketUpdate(update("2026-07-18T20:00:00Z")), "LIVE");
    expect(controller.hawk.status()).toMatchObject({
      state: "MONITORING",
      latestAction: "NO_TRADE",
      edge: null,
    });
    expect(controller.hawk.status().reasonCodes).toContain("INDEPENDENT_THEO_UNAVAILABLE");
  });

  it("never creates edge by comparing a market with itself", () => {
    const controller = new DualStrategyController(new AdaptiveQuoteGuard([], "SANITIZED_TXODDS", []), { ...defaultRiskLimits });
    controller.hawk.monitorLive({
      timestamp: "2026-07-18T20:00:00Z",
      fixtureId: "3",
      marketId: "same-market",
      selectionId: "yes",
      marketProbability: 0.5,
      uncertainty: 0.01,
      volatility: 0.01,
      standardizedInnovation: 2,
      latencyMs: 10,
      stalenessMs: 10,
      inventory: 0,
      executionCost: 0.001,
      comparableMarket: { marketId: "same-market", probability: 0.6 },
    });
    expect(controller.hawk.status().edge).toBeNull();
    expect(controller.hawk.status().reasonCodes).toContain("SELF_MARKET_COMPARISON_REJECTED");
  });

  it("labels the optional replay heuristic paper-only and not proven alpha", () => {
    const controller = new DualStrategyController(new AdaptiveQuoteGuard([], "SANITIZED_TXODDS", []), { ...defaultRiskLimits });
    const first = sanitizeMarketUpdate(update("2026-07-18T20:00:00Z", 0.5));
    const second = sanitizeMarketUpdate(update("2026-07-18T20:00:01Z", 0.55));
    const market = { ...markets[0], marketId: second.marketId, fixtureId: "3", selections: markets[0].selections.slice(0, 2).map((selection, index) => ({ ...selection, marketId: second.marketId, selectionId: second.selectionIds[index]! })) };
    controller.ingest(first, "REPLAY", market);
    controller.ingest(second, "REPLAY", market);
    expect(controller.hawk.status().labels).toEqual(["REPLAY_HAWK_HEURISTIC", "PAPER_ONLY", "NOT_PROVEN_ALPHA"]);
    expect(controller.hawk.status().edge).toBeNull();
  });

  it("shares paper risk capacity between Hawk positions and Maker size", () => {
    const limits = { ...defaultRiskLimits, maxWorstCaseLoss: 5, maxOrderSize: 5 };
    const controller = new DualStrategyController(new AdaptiveQuoteGuard([], "SANITIZED_TXODDS", []), limits);
    const first = sanitizeMarketUpdate(update("2026-07-18T20:00:00Z", 0.5));
    const second = sanitizeMarketUpdate(update("2026-07-18T20:00:01Z", 0.55));
    const market = { ...markets[0], marketId: second.marketId, fixtureId: "3", selections: markets[0].selections.slice(0, 2).map((selection, index) => ({ ...selection, marketId: second.marketId, selectionId: second.selectionIds[index]! })) };
    controller.ingest(first, "REPLAY", market);
    controller.ingest(second, "REPLAY", market);
    expect(controller.shared.grossExposure()).toBeGreaterThan(0);
    expect(controller.shared.capacity()).toBeLessThan(5);
  });

  it("allows Quote Guard to change width and size only", () => {
    const timestamp = "2026-07-18T20:00:00Z";
    const event = sanitizeMarketUpdate(update(timestamp));
    const baseline = new DualStrategyController(new AdaptiveQuoteGuard([], "SANITIZED_TXODDS", []), { ...defaultRiskLimits });
    const guarded = new DualStrategyController(new AdaptiveQuoteGuard([guardRow(timestamp, 0.5)], "SANITIZED_TXODDS", []), { ...defaultRiskLimits });
    baseline.ingest(event, "LIVE");
    guarded.ingest(event, "LIVE");
    const ordinary = baseline.maker.status();
    const defensive = guarded.maker.status();
    expect(defensive.quoteCentre).toBe(ordinary.quoteCentre);
    expect(defensive.width).toBeGreaterThan(ordinary.width!);
    expect(defensive.size).toBeLessThan(ordinary.size!);
    expect(guarded.hawk.status().edge).toBeNull();
    expect(guarded.status().security).toMatchObject({ realExecution: false, mainnet: false, kelly: false });
  });

  it("suspends paper quotes and resumes only on an explicit controlled-resumption row", () => {
    const suspend = guardRow("2026-07-18T20:00:01Z", 0.9);
    const resume = { ...guardRow("2026-07-18T20:00:02Z", 0.2), recommendedAction: "RESUME" as const };
    const controller = new DualStrategyController(
      new AdaptiveQuoteGuard([suspend, resume], "SANITIZED_TXODDS", []),
      { ...defaultRiskLimits },
    );
    controller.ingest(sanitizeMarketUpdate(update("2026-07-18T20:00:01Z", 0.5)), "LIVE");
    expect(controller.maker.status()).toMatchObject({ state: "SUSPENDED", latestAction: "SUSPEND", bid: null, ask: null });
    controller.ingest(sanitizeMarketUpdate(update("2026-07-18T20:00:02Z", 0.5)), "LIVE");
    expect(controller.maker.status()).toMatchObject({ state: "QUOTING", latestAction: "RESUME" });
  });
});

describe("backend handoff endpoints", () => {
  it.each([
    "/api/fixtures/current",
    "/api/replays",
    "/api/replays/england-france-third-place",
    "/api/txodds/status",
    "/api/agent/status",
    "/api/agent/maker",
    "/api/agent/hawk",
    "/api/trading/status",
    "/api/audit",
  ])("serves %s", async (endpoint) => {
    const response = await get(endpoint);
    expect(response.status).toBe(200);
  });

  it("keeps real execution disabled in API status", async () => {
    const response = await get("/api/trading/status");
    expect(response.body).toMatchObject({ realExecution: "DISABLED" });
  });

  it("returns the required Maker and Hawk response fields", async () => {
    const maker = (await get("/api/agent/maker")).body as Record<string, unknown>;
    const hawk = (await get("/api/agent/hawk")).body as Record<string, unknown>;
    for (const field of ["state", "latestAction", "bid", "ask", "width", "size", "inventoryLean", "reasonCodes"]) {
      expect(maker).toHaveProperty(field);
    }
    for (const field of ["state", "latestAction", "signalType", "signalConfidence", "edge", "paperPosition", "reasonCodes"]) {
      expect(hawk).toHaveProperty(field);
    }
  });
});
