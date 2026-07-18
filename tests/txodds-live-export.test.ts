import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SOLANA_DEVNET_RPC,
  TXLINE_DEVNET_ORIGIN,
  TxlineReadOnlyAdapter,
  maskSecret,
  resolveDataRuntimeConfig,
  type Environment,
  type FetchLike,
  type TxlineDataConfig,
  type TxlineOddsUpdate,
} from "../packages/market-data/src/index.js";
import {
  TABLE_SCHEMAS,
  buildResearchTables,
  sanitizeForResearch,
  writeResearchBundle,
  type ResearchCapture,
} from "../packages/research-data/src/index.js";

function liveEnvironment(overrides: Environment = {}): Environment {
  return {
    DATA_MODE: "txline",
    DEMO_MODE: "false",
    TXLINE_NETWORK: "devnet",
    TXLINE_API_ORIGIN: TXLINE_DEVNET_ORIGIN,
    TXLINE_API_TOKEN: "activated-api-token-for-tests",
    SOLANA_RPC_URL: SOLANA_DEVNET_RPC,
    ENABLE_REAL_EXECUTION: "false",
    ENABLE_WALLET_OPERATIONS: "false",
    ENABLE_TXODDS_ACTIVATION: "false",
    ...overrides,
  };
}

function liveConfig(): TxlineDataConfig {
  const resolved = resolveDataRuntimeConfig(liveEnvironment());
  if (!resolved.valid || resolved.mode !== "txline") throw new Error("test configuration invalid");
  return resolved;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function update(messageId: string, seconds: number, prices: number[]): TxlineOddsUpdate {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return {
    FixtureId: 101,
    MessageId: messageId,
    Ts: base + seconds * 1000,
    Bookmaker: "SanitizedBook",
    BookmakerId: 1,
    SuperOddsType: "MATCH_RESULT_1X2",
    MarketPeriod: "FULL_MATCH",
    PriceNames: ["Home", "Draw", "Away"],
    Prices: prices,
    Pct: ["0", "0", "0"],
  };
}

function capture(options: { duplicate?: boolean; settled?: boolean } = {}): ResearchCapture {
  const updates = [
    update("m1", 0, [2, 4, 4]),
    update("m2", 10, [1.9, 4.1, 4.2]),
    update("m3", 30, [1.8, 4.2, 4.5]),
    update("m4", 60, [1.7, 4.4, 4.8]),
  ];
  if (options.duplicate) updates.push(structuredClone(updates[0]));
  return {
    sourceNetwork: "sanitized-replay",
    fixture: {
      FixtureId: 101,
      CompetitionId: 72,
      Participant1Id: 1,
      Participant2Id: 2,
      Participant1IsHome: true,
      StartTime: Date.parse("2026-01-01T01:00:00.000Z"),
      GameState: 1,
    },
    updates,
    scoreEvents: options.settled ? [{
      FixtureId: 101,
      MessageId: "score-final",
      Ts: Date.parse("2026-01-01T02:00:00.000Z"),
      receiveTime: "2026-01-01T02:00:01.000Z",
      action: "game_finalised",
      statusId: 100,
      period: 100,
      homeScore: 2,
      awayScore: 1,
    }] : [],
  };
}

describe("Railway live read-only configuration", () => {
  it("accepts the documented replay demo variables", () => {
    const config = resolveDataRuntimeConfig({
      DATA_MODE: "replay",
      DEMO_MODE: "true",
      ENABLE_REAL_EXECUTION: "false",
      ENABLE_WALLET_OPERATIONS: "false",
      ENABLE_TXODDS_ACTIVATION: "false",
    });
    expect(config).toMatchObject({ valid: true, mode: "replay", demoMode: true });
  });

  it("reports exact missing variables instead of pretending to be connected", () => {
    const config = resolveDataRuntimeConfig({ DATA_MODE: "txline" });
    expect(config.valid).toBe(false);
    if (config.valid) throw new Error("expected invalid config");
    expect(config.status).toBe("NOT_CONFIGURED");
    expect(config.reasonCodes).toContain("MISSING_TXLINE_API_ORIGIN");
    expect(config.reasonCodes).toContain("MISSING_TXLINE_API_TOKEN");
  });

  it("accepts the documented Railway live-read-only variables without a wallet or stored JWT", () => {
    const config = resolveDataRuntimeConfig(liveEnvironment());
    expect(config.valid).toBe(true);
    expect(config.mode).toBe("txline");
    expect("guestJwt" in config).toBe(false);
    expect("wallet" in config).toBe(false);
  });

  it("never falls back to replay when txline configuration is invalid", () => {
    const config = resolveDataRuntimeConfig(liveEnvironment({ TXLINE_API_ORIGIN: undefined }));
    expect(config.valid).toBe(false);
    expect(config.mode).toBe("txline");
  });

  it("acquires a fresh guest JWT and exposes only masked credential state", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: FetchLike = async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/auth/guest/start")) return jsonResponse({ token: "fresh-guest-jwt-123456" });
      return jsonResponse([]);
    };
    const adapter = new TxlineReadOnlyAdapter(liveConfig(), fetcher, () => new Date("2026-01-01T00:00:00.000Z"));
    await adapter.connect();
    expect(calls[0]).toMatchObject({ url: `${TXLINE_DEVNET_ORIGIN}/auth/guest/start`, init: { method: "POST" } });
    const headers = calls[1].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer fresh-guest-jwt-123456");
    expect(headers["X-Api-Token"]).toBe("activated-api-token-for-tests");
    expect(JSON.stringify(adapter.getSystemDataStatus())).not.toContain("fresh-guest-jwt");
    expect(JSON.stringify(adapter.getSystemDataStatus())).not.toContain("activated-api-token");
    expect(adapter.getSystemDataStatus().status).toBe("CONNECTED");
  });

  it("renews the guest JWT once after a 401 and retries with the activated API token", async () => {
    let authCount = 0;
    let dataCount = 0;
    const authorizationHeaders: string[] = [];
    const fetcher: FetchLike = async (input, init) => {
      if (String(input).endsWith("/auth/guest/start")) return jsonResponse({ token: `jwt-${++authCount}-long-enough` });
      dataCount += 1;
      authorizationHeaders.push((init?.headers as Record<string, string>).Authorization);
      return dataCount === 1 ? jsonResponse({ error: "expired" }, 401) : jsonResponse([]);
    };
    const adapter = new TxlineReadOnlyAdapter(liveConfig(), fetcher);
    await expect(adapter.connect()).resolves.toBeUndefined();
    expect(authCount).toBe(2);
    expect(authorizationHeaders).toEqual(["Bearer jwt-1-long-enough", "Bearer jwt-2-long-enough"]);
  });

  it("masks secrets consistently", () => {
    expect(maskSecret("abcdefghijklmnop")).toBe("abcd...mnop");
    expect(maskSecret("short")).toBe("<masked>");
  });
});

describe("Colab research export", () => {
  it("matches required export columns and the Pydantic PredictionObservation projection", () => {
    const tables = buildResearchTables(capture({ settled: true }));
    for (const [table, schema] of Object.entries(TABLE_SCHEMAS)) {
      for (const row of tables[table as keyof typeof tables]) {
        for (const required of schema.required as string[]) expect(row).toHaveProperty(required);
      }
    }
    expect(Object.keys(tables.prediction_observations[0]).sort()).toEqual([
      "available_at", "baseline_probability", "decision_time", "event_time", "fixture_id",
      "observation_id", "outcome", "probability", "strategy_return", "target_available_at",
    ].sort());
  });

  it("produces a reproducible dataset hash independent of export timestamp", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "colab-export-a-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "colab-export-b-"));
    try {
      const tables = buildResearchTables(capture());
      const first = await writeResearchBundle(tables, { outputRoot: firstRoot, exportGitCommit: "a".repeat(40), exportTimestamp: "2026-01-01T00:00:00Z", sourceNetwork: "sanitized-replay", sourceUri: "fixture.json" });
      const second = await writeResearchBundle(tables, { outputRoot: secondRoot, exportGitCommit: "a".repeat(40), exportTimestamp: "2026-02-01T00:00:00Z", sourceNetwork: "sanitized-replay", sourceUri: "fixture.json" });
      expect(first.datasetHash).toBe(second.datasetHash);
      expect(await readFile(join(first.outputDirectory, "dataset-hash.txt"), "utf8")).toBe(`${first.datasetHash}\n`);
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it("rejects receive timestamps earlier than source event timestamps", () => {
    const row = update("bad-time", 10, [2, 4, 4]);
    expect(() => buildResearchTables({ fixture: capture().fixture, oddsRecords: [{ update: row, receiveTime: "2026-01-01T00:00:00.000Z" }] })).toThrow(/RECEIVED_BEFORE_EVENT/);
  });

  it("deduplicates repeated source events and reports the removal", () => {
    const tables = buildResearchTables(capture({ duplicate: true }));
    expect(tables.raw_events).toHaveLength(4);
    expect(tables.market_events).toHaveLength(12);
    expect(tables.data_quality.some((row) => row.code === "DUPLICATES_REMOVED")).toBe(true);
  });

  it("removes secret, wallet, signature, activation, and authorization fields", () => {
    const sanitized = sanitizeForResearch({
      TXLINE_API_TOKEN: "token-value",
      guestJwt: "jwt-value",
      Authorization: "Bearer secret",
      walletAddress: "wallet",
      walletPath: "path",
      privateKey: "private",
      signature: "signature",
      activationPayload: { txSig: "value" },
      safe: { FixtureId: 101 },
    });
    expect(sanitized).toEqual({ safe: { FixtureId: 101 } });
  });

  it("keeps unavailable markout horizons explicit and null", () => {
    const tables = buildResearchTables(capture());
    const missing = tables.markout_observations.find((row) => row.horizon_seconds === 300);
    expect(missing).toMatchObject({ status: "MISSING_FUTURE_OBSERVATION", future_probability: null, markout: null, target_available_at: null });
  });

  it("joins final settled outcomes without making them available before the final score", () => {
    const tables = buildResearchTables(capture({ settled: true }));
    expect(tables.settlements.length).toBe(3);
    const home = tables.market_events.find((row) => String(row.selection_id).includes(":Home"));
    expect(home?.settled_outcome).toBe(1);
    expect(String(home?.settlement_available_at)).toBe("2026-01-01T02:00:01.000Z");
    expect(tables.prediction_observations.length).toBeGreaterThan(0);
    expect(tables.prediction_observations.every((row) => String(row.decision_time) < String(row.target_available_at))).toBe(true);
  });
});
