import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditTxlineHistory,
  captureTxlineHistory,
  createSanitizedHistoricalReplay,
  EventStore,
  mapFixture,
  mapOddsUpdateToMarket,
  toNormalizedMarketObservation,
  writeHistoricalExport,
  type FetchLike,
  type TxlineOddsUpdate,
  TxlineReadOnlyAdapter,
} from "../packages/market-data/src/index.js";
import { SOLANA_DEVNET_RPC, TXLINE_DEVNET_ORIGIN, type TxlineDataConfig } from "../packages/market-data/src/config.js";

const config: TxlineDataConfig = {
  valid: true,
  mode: "txline",
  demoMode: false,
  network: "devnet",
  apiOrigin: TXLINE_DEVNET_ORIGIN,
  apiToken: "test-token-never-written",
  solanaRpcUrl: SOLANA_DEVNET_RPC,
  enableRealExecution: false,
  enableWalletOperations: false,
  enableTxoddsActivation: false,
};

const fixture = {
  FixtureId: 9001,
  CompetitionId: 72,
  Competition: "Recorded Competition",
  Participant1Id: 101,
  Participant1: "Recorded Home",
  Participant2Id: 202,
  Participant2: "Recorded Away",
  Participant1IsHome: true,
  StartTime: Date.parse("2026-07-18T18:00:00.000Z"),
  GameState: 3,
};

function odds(messageId: string, seconds: number, type = "MATCH_RESULT_1X2", stable = true): TxlineOddsUpdate {
  return {
    FixtureId: 9001,
    MessageId: messageId,
    Ts: Date.parse("2026-07-18T18:00:00.000Z") + seconds * 1_000,
    Bookmaker: "RecordedBook",
    BookmakerId: 17,
    SuperOddsType: type,
    MarketParameters: "",
    MarketPeriod: "FULL_MATCH",
    PriceNames: type === "MATCH_RESULT_1X2" ? ["Home", "Draw", "Away"] : ["Yes", "No"],
    Prices: type === "MATCH_RESULT_1X2" ? [2, 4, 4] : [1.8, 2.1],
    StablePrice: stable ? (type === "MATCH_RESULT_1X2" ? [0.5, 0.25, 0.25] : [0.55, 0.45]) : undefined,
    Pct: ["unverified", "unverified", ...(type === "MATCH_RESULT_1X2" ? ["unverified"] : [])],
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function mockedFetcher(): { fetcher: FetchLike; authorization: string[] } {
  const authorization: string[] = [];
  const fetcher: FetchLike = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/auth/guest/start")) return json({ token: "ephemeral-test-jwt" });
    const headers = init?.headers as Record<string, string>;
    authorization.push(headers.Authorization);
    const path = new URL(url).pathname;
    if (path === "/api/fixtures/snapshot") return json([fixture]);
    if (path === "/api/odds/updates/20652/23/0") return json([odds("1", 0), odds("2", 30), odds("3", 60, "FUTURE_UNKNOWN_MARKET")]);
    if (path.startsWith("/api/odds/updates/")) return json([]);
    if (path === "/api/scores/updates/20652/23/0") return json([{ FixtureId: 9001, MessageId: "score-1", Ts: Date.parse("2026-07-18T20:00:00.000Z"), HomeScore: 2, AwayScore: 1, Status: "FINAL" }]);
    if (path.startsWith("/api/scores/updates/20652/")) return json([]);
    if (path === "/api/odds/snapshot/9001") return json([odds("3", 60, "FUTURE_UNKNOWN_MARKET")]);
    if (path === "/api/scores/snapshot/9001") return json([]);
    if (path === "/api/scores/updates/9001") return json([]);
    if (path === "/api/scores/historical/9001") return json([{ FixtureId: 9001, MessageId: "final-1", Ts: Date.parse("2026-07-18T20:00:01.000Z"), HomeScore: 2, AwayScore: 1, Status: "FINAL" }]);
    return json([]);
  };
  return { fetcher, authorization };
}

async function capture() {
  const mock = mockedFetcher();
  const adapter = new TxlineReadOnlyAdapter(config, mock.fetcher, () => new Date("2026-07-19T00:00:00.000Z"));
  const result = await captureTxlineHistory(adapter, {
    startEpochDay: 20652,
    endEpochDay: 20652,
    intervals: [0],
    emptyDayStop: 1,
  }, () => new Date("2026-07-19T00:00:00.000Z"));
  return { result, authorization: mock.authorization };
}

describe("TxODDS historical read-only capture", () => {
  it("covers fixtures, odds buckets/snapshots, score buckets/snapshots/updates, and historical scores", async () => {
    const { result, authorization } = await capture();
    const endpoints = new Set(result.probes.map((probe) => probe.endpoint));
    expect(endpoints.has("/api/fixtures/snapshot")).toBe(true);
    expect(endpoints.has("/api/odds/updates/20652/23/0")).toBe(true);
    expect(endpoints.has("/api/odds/snapshot/9001")).toBe(true);
    expect(endpoints.has("/api/scores/updates/20652/23/0")).toBe(true);
    expect(endpoints.has("/api/scores/snapshot/9001")).toBe(true);
    expect(endpoints.has("/api/scores/updates/9001")).toBe(true);
    expect(endpoints.has("/api/scores/historical/9001")).toBe(true);
    expect(authorization.every((value) => value === "Bearer ephemeral-test-jwt")).toBe(true);
  });

  it("preserves raw source fields, provenance, source time, receive time, and message identifiers", async () => {
    const { result } = await capture();
    const record = result.oddsEvents.find((event) => event.messageId === "1")!;
    expect(record.raw).toMatchObject({
      Prices: [2, 4, 4],
      StablePrice: [0.5, 0.25, 0.25],
      Pct: ["unverified", "unverified", "unverified"],
      SuperOddsType: "MATCH_RESULT_1X2",
      MarketParameters: "",
      MarketPeriod: "FULL_MATCH",
      PriceNames: ["Home", "Draw", "Away"],
    });
    expect(record).toMatchObject({
      sourceTimestamp: "2026-07-18T18:00:00.000Z",
      receiveTimestamp: "2026-07-19T00:00:00.000Z",
      fixtureId: "9001",
      messageId: "1",
      sequenceId: "1",
      provenance: { source: "TXODDS", network: "devnet", transport: "https-read-only" },
    });
  });

  it("normalizes recorded StablePrice without double de-vigging or selecting Pct", async () => {
    const { result } = await capture();
    const source = result.oddsEvents.find((event) => event.messageId === "1")!.raw;
    const store = new EventStore();
    const event = store.appendRaw({ receivedAt: "2026-07-19T00:00:00.000Z", transport: "file", body: source, dataMode: "REPLAY" })!;
    const observation = toNormalizedMarketObservation(event);
    expect(observation.probabilityField).toBe("STABLE_PRICE");
    expect(observation.probabilities).toEqual([0.5, 0.25, 0.25]);
    expect(observation.provenance.reasonCodes).toContain("DOUBLE_DEVIG_SKIPPED");
    expect(observation.provenance.reasonCodes).toContain("PCT_NOT_SELECTED_UNVERIFIED");
  });

  it("orders replay by receive time and remains deterministic", async () => {
    const first = await capture();
    const second = await capture();
    expect(first.result).toEqual(second.result);
    const store = new EventStore();
    for (const record of first.result.oddsEvents) {
      store.appendRaw({ receivedAt: record.receiveTimestamp, transport: "file", endpoint: record.endpoint, body: record.raw, dataMode: "REPLAY" });
    }
    const events = store.events();
    expect(events).toEqual([...events].sort((a, b) => a.receiveTime.localeCompare(b.receiveTime) || a.eventTime.localeCompare(b.eventTime) || String(a.sequenceId).localeCompare(String(b.sequenceId))));
  });

  it("joins odds and scores by fixture while handling an unknown market deterministically", async () => {
    const { result } = await capture();
    const replay = createSanitizedHistoricalReplay(result);
    expect(replay).toMatchObject({ label: "SANITIZED_RECORDED_TXODDS_HISTORICAL" });
    expect((replay.scoreEvents as Array<Record<string, unknown>>).every((score) => String(score.FixtureId) === "9001")).toBe(true);
    const unknown = result.oddsEvents.find((event) => event.raw.SuperOddsType === "FUTURE_UNKNOWN_MARKET")!;
    const mapped = mapOddsUpdateToMarket(unknown.raw, "REPLAY");
    expect(mapped).toMatchObject({ fixtureId: "9001", marketType: "BINARY_YES_NO", status: "OPEN" });
    expect(mapped.description).toContain("FUTURE_UNKNOWN_MARKET");
  });

  it("audits duplicates, ordering, markouts, final scores, and the observed retention window", async () => {
    const { result } = await capture();
    const audit = auditTxlineHistory(result);
    expect(audit).toMatchObject({
      fixtureCount: 1,
      completedFixtureCount: 1,
      earliestSourceTimestamp: "2026-07-18T18:00:00.000Z",
      latestSourceTimestamp: "2026-07-18T20:00:01.000Z",
    });
    expect(audit.duplicateRate).toBeGreaterThan(0);
    expect(audit.availableFutureMarkoutHorizons["30"]).toBeGreaterThan(0);
    expect(audit.observedRetention).toMatchObject({ earliestEpochDayWithData: 20652, latestEpochDayWithData: 20652 });
  });

  it("writes reproducible ignored dataset identifiers without credentials", async () => {
    const { result } = await capture();
    const firstRoot = await mkdtemp(join(tmpdir(), "txodds-history-a-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "txodds-history-b-"));
    try {
      const first = await writeHistoricalExport(result, firstRoot);
      const second = await writeHistoricalExport(result, secondRoot);
      expect(first.datasetId).toBe(second.datasetId);
      const exported = await readFile(join(first.outputDirectory, "capture.json"), "utf8");
      expect(exported).not.toContain(config.apiToken);
      expect(exported).not.toContain("ephemeral-test-jwt");
      expect(exported).not.toContain("Authorization");
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it("normal tests do not require live credentials", async () => {
    const previous = process.env.TXLINE_API_TOKEN;
    delete process.env.TXLINE_API_TOKEN;
    try {
      await expect(capture()).resolves.toBeDefined();
    } finally {
      if (previous === undefined) delete process.env.TXLINE_API_TOKEN;
      else process.env.TXLINE_API_TOKEN = previous;
    }
  });
});

describe("recorded fixture parsing", () => {
  it("maps fixture metadata without changing participant IDs or kickoff time", () => {
    const mapped = mapFixture(fixture, "REPLAY");
    expect(mapped).toMatchObject({ fixtureId: "9001", competitionId: "72", homeTeamId: "101", awayTeamId: "202", startTime: "2026-07-18T18:00:00.000Z" });
  });
});
