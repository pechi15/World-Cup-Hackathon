import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EventStore,
  mapFixture,
  mapOddsUpdateToMarket,
  selectMarketProbabilities,
  toNormalizedMarketObservation,
  type TxlineFixtureRow,
  type TxlineOddsUpdate,
} from "../packages/market-data/src/index.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const replayPath = path.resolve(root, "../data/samples/txodds/replay/recorded-historical-replay.json");
const replay = JSON.parse(readFileSync(replayPath, "utf8")) as {
  label: string;
  fixture: TxlineFixtureRow;
  fixtures: TxlineFixtureRow[];
  updates: TxlineOddsUpdate[];
  oddsRecords: Array<{ update: TxlineOddsUpdate; receiveTime: string; sourceTime: string; endpoint: string }>;
  scoreEvents: Array<Record<string, unknown>>;
  provenance: { fixtureId: string; source: string; network: string; sourceEndpoints: string[] };
};

function replayEvents() {
  const store = new EventStore();
  for (const record of replay.oddsRecords) {
    store.appendRaw({
      receivedAt: record.receiveTime,
      transport: "file",
      endpoint: record.endpoint,
      body: record.update,
      dataMode: "REPLAY",
    });
  }
  return store;
}

describe("sanitized recorded TxODDS historical replay", () => {
  it("parses genuine fixture metadata and remains explicitly replay/devnet", () => {
    expect(replay).toMatchObject({
      label: "SANITIZED_RECORDED_TXODDS_HISTORICAL",
      provenance: { source: "TXODDS", network: "devnet" },
    });
    const mapped = mapFixture(replay.fixture, "REPLAY");
    expect(mapped.fixtureId).toBe(String(replay.fixture.FixtureId));
    expect(mapped.homeTeamId).toBe(String(replay.fixture.Participant1Id));
    expect(mapped.awayTeamId).toBe(String(replay.fixture.Participant2Id));
    expect(mapped.startTime).toBe(new Date(replay.fixture.StartTime!).toISOString());
  });

  it("normalizes markets while preserving raw Prices, Pct, source timestamps, and IDs", () => {
    const store = replayEvents();
    expect(store.rawCount()).toBe(replay.oddsRecords.length);
    const event = store.events()[0]!;
    const observation = toNormalizedMarketObservation(event);
    const source = replay.oddsRecords.find((record) => record.update.MessageId === event.sequenceId)!.update;
    expect(observation.raw.Prices).toEqual(source.Prices);
    expect(observation.raw.Pct).toEqual(source.Pct);
    expect(observation.eventTime).toBe(new Date(source.Ts).toISOString());
    expect(observation.provenance.messageId).toBe(source.MessageId);
    expect(observation.provenance.source).toBe("REPLAY");
  });

  it("recognizes de-margined StablePrice milliodds and never selects Pct or double de-vigs", () => {
    const source = replay.updates.find((update) => update.Bookmaker === "TXLineStablePriceDemargined")!;
    const selected = selectMarketProbabilities(source);
    expect(source.StablePrice).toBeUndefined();
    expect(source.Prices.some((price) => price >= 1_000)).toBe(true);
    expect(selected.field).toBe("STABLE_PRICE");
    expect(selected.demarginingStatus).toBe("VERIFIED_ALREADY_DEMARGINED");
    expect(selected.probabilities.reduce((sum, probability) => sum + probability, 0)).toBeCloseTo(1, 12);
    expect(selected.reasonCodes).toEqual(expect.arrayContaining([
      "TXLINE_STABLE_PRICE_DEMARGINED_SOURCE_VERIFIED",
      "MILLIODDS_DECODED_WHEN_PRESENT",
      "DOUBLE_DEVIG_SKIPPED",
      "PCT_NOT_SELECTED_UNVERIFIED",
    ]));
  });

  it("delivers timestamp-ordered events deterministically", () => {
    const first = replayEvents().events();
    const second = replayEvents().events();
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort((a, b) =>
      a.receiveTime.localeCompare(b.receiveTime)
      || a.eventTime.localeCompare(b.eventTime)
      || String(a.sequenceId ?? "").localeCompare(String(b.sequenceId ?? "")),
    ));
  });

  it("joins recorded scores and odds on the same fixture without inventing settlement", () => {
    expect(replay.updates.every((update) => String(update.FixtureId) === replay.provenance.fixtureId)).toBe(true);
    expect(replay.scoreEvents.length).toBeGreaterThan(0);
    expect(replay.scoreEvents.every((score) => String(score.FixtureId) === replay.provenance.fixtureId)).toBe(true);
    expect(replay.scoreEvents.every((score) => String(score.GameState).toLowerCase() !== "final")).toBe(true);
  });

  it("handles an unrecognized recorded-shape SuperOddsType without dropping raw identity", () => {
    const unknown: TxlineOddsUpdate = {
      ...structuredClone(replay.updates[0]!),
      SuperOddsType: "UNRECOGNIZED_RECORDED_MARKET",
      PriceNames: ["Yes", "No"],
      Prices: [2_000, 2_000],
      Pct: ["50.000", "50.000"],
    };
    const mapped = mapOddsUpdateToMarket(unknown, "REPLAY");
    expect(mapped).toMatchObject({ marketType: "BINARY_YES_NO", status: "OPEN" });
    expect(mapped.marketId).toContain("UNRECOGNIZED_RECORDED_MARKET");
    expect(mapped.description).toContain("UNRECOGNIZED_RECORDED_MARKET");
  });

  it("contains no credential, authorization-header, wallet, signature, or secret-path fields", () => {
    const forbidden = new Set(["txline_api_token", "guestjwt", "authorization", "x-api-token", "wallet", "walletpath", "signature", "privatekey", "secretpath"]);
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        expect(forbidden.has(key.toLowerCase())).toBe(false);
        visit(child);
      }
    };
    visit(replay);
  });
});
