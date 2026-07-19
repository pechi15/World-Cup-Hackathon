import type { Fixture, MarketDefinition, MarketSnapshot, TxoddsAdapterStatusSchema } from "../../contracts/src/index.js";
import { z } from "zod";
import { EventStore } from "./event-store.js";
import { mapFixture, mapOddsUpdateToMarket, mapOddsUpdateToTicks, type TxlineFixtureRow, type TxlineOddsUpdate } from "./mapper.js";

export type TxoddsAdapterStatus = z.infer<typeof TxoddsAdapterStatusSchema>;

export type TxoddsAdapterConfig = {
  network?: string;
  apiOrigin?: string;
  guestJwt?: string;
  apiToken?: string;
  solanaRpcUrl?: string;
};

export * from "./event-store.js";
export * from "./mapper.js";
export * from "./config.js";
export * from "./txline-readonly.js";
export * from "./historical.js";

export class DisabledTxoddsAdapter {
  readonly status: TxoddsAdapterStatus;

  constructor(private readonly config: TxoddsAdapterConfig = {}) {
    this.status = !config.apiOrigin ? "NOT_CONFIGURED" : !config.guestJwt || !config.apiToken ? "AWAITING_CREDENTIALS" : "CONNECTED";
  }

  getSystemDataStatus() {
    return {
      status: this.status,
      display: this.status === "CONNECTED" ? "Configured" : "Awaiting TxODDS API",
      reasonCodes: this.status === "CONNECTED" ? [] : ["TXODDS_API_NOT_CONNECTED"],
    };
  }

  async discoverFixtures(): Promise<Fixture[]> {
    if (this.status !== "CONNECTED") return [];
    throw new Error("Live TxODDS fixture discovery not enabled in this build; use ReplayTxoddsAdapter for offline demo.");
  }

  async discoverMarkets(): Promise<MarketDefinition[]> {
    if (this.status !== "CONNECTED") return [];
    throw new Error("Live TxODDS market discovery not enabled in this build; use ReplayTxoddsAdapter for offline demo.");
  }

  async fetchOddsSnapshot(): Promise<MarketSnapshot[]> {
    if (this.status !== "CONNECTED") return [];
    throw new Error("Live TxODDS odds snapshot not enabled in this build; use ReplayTxoddsAdapter for offline demo.");
  }
}

/** Offline / historical-replay adapter backed by an EventStore. */
export class ReplayTxoddsAdapter {
  readonly status: TxoddsAdapterStatus = "CONNECTED";
  readonly store: EventStore;
  private fixtures: Fixture[] = [];

  constructor(store = new EventStore()) {
    this.store = store;
  }

  getSystemDataStatus() {
    return {
      status: this.status,
      display: "Replay store",
      reasonCodes: [] as string[],
      uniqueEvents: this.store.uniqueCount(),
      rawEvents: this.store.rawCount(),
      duplicateRate: this.store.duplicateRate(),
    };
  }

  loadFixtures(rows: TxlineFixtureRow[]): void {
    this.fixtures = rows.map((row) => mapFixture(row, "REPLAY"));
  }

  loadOddsUpdates(updates: TxlineOddsUpdate[]): number {
    return this.store.loadUpdates(updates, "REPLAY");
  }

  async discoverFixtures(): Promise<Fixture[]> {
    if (this.fixtures.length) return this.fixtures;
    const ids = [...new Set(this.store.events().map((e) => e.fixtureId))];
    return ids.map((fixtureId) =>
      mapFixture({ FixtureId: Number(fixtureId), Participant1: "Home", Participant2: "Away", Participant1IsHome: true }, "REPLAY"),
    );
  }

  async discoverMarkets(): Promise<MarketDefinition[]> {
    const byKey = new Map<string, MarketDefinition>();
    for (const event of this.store.events()) {
      byKey.set(event.marketKey, mapOddsUpdateToMarket(event.update, "REPLAY"));
    }
    return [...byKey.values()];
  }

  async fetchOddsSnapshot(): Promise<MarketSnapshot[]> {
    const latest = new Map<string, MarketSnapshot>();
    for (const event of this.store.events()) {
      const ticks = mapOddsUpdateToTicks(event.update, "REPLAY");
      latest.set(event.marketKey, {
        snapshotId: `snap-${event.eventId}`,
        marketId: event.marketKey,
        prices: ticks.map(({ tickId: _t, ...p }) => p),
        timestamp: event.eventTime,
        provenance: { source: "REPLAY" },
      });
    }
    return [...latest.values()];
  }
}
