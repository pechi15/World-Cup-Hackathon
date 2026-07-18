/** Append-only normalized replay store delivered in receive-time (availability) order. */

import { createHash } from "node:crypto";
import type { Source } from "../../contracts/src/index.js";
import {
  mapOddsUpdateToMarket,
  marketKey,
  selectMarketProbabilities,
  type DemarginingStatus,
  type TxlineOddsUpdate,
  type TxlineProbabilityField,
} from "./mapper.js";

export type RawRecord = {
  recordId: string;
  receivedAt: string;
  transport: "http" | "sse" | "file";
  endpoint?: string;
  body: TxlineOddsUpdate;
  dataMode: "TXODDS" | "REPLAY";
};

export type NormalizedEvent = {
  eventId: string;
  eventTime: string;
  receiveTime: string;
  sequenceId: string | null;
  fixtureId: string;
  marketKey: string;
  update: TxlineOddsUpdate;
  dedupeKey: string;
  dataMode: "TXODDS" | "REPLAY";
  source: Source;
};

/**
 * Model-facing observation derived from an append-only normalized event.
 * Raw TxLINE values remain attached unchanged for audit and reproducibility.
 */
export type NormalizedMarketObservation = {
  observationId: string;
  eventTime: string;
  receiveTime: string;
  marketId: string;
  selectionIds: string[];
  probabilities: number[];
  probabilityField: TxlineProbabilityField;
  demarginingStatus: DemarginingStatus;
  raw: {
    Prices: number[];
    Pct?: string[];
    StablePrice?: number[];
  };
  provenance: {
    source: Source;
    dataMode: "TXODDS" | "REPLAY";
    fixtureId: string;
    messageId: string | null;
    bookmaker: string | null;
    bookmakerId: number | null;
    reasonCodes: string[];
  };
};

function cloneUpdate(update: TxlineOddsUpdate): TxlineOddsUpdate {
  return {
    ...update,
    PriceNames: [...update.PriceNames],
    Prices: [...update.Prices],
    Pct: update.Pct ? [...update.Pct] : undefined,
    StablePrice: update.StablePrice ? [...update.StablePrice] : undefined,
  };
}

function dedupeKey(update: TxlineOddsUpdate): string {
  const payload = [
    update.FixtureId,
    update.SuperOddsType,
    update.MarketParameters ?? "",
    update.MarketPeriod ?? "",
    update.Bookmaker ?? "",
    update.BookmakerId ?? "",
    update.Ts,
    update.MessageId ?? "",
    JSON.stringify(update.Prices),
    JSON.stringify(update.Pct ?? []),
    JSON.stringify(update.StablePrice ?? []),
    JSON.stringify(update.PriceNames),
  ].join("|");
  return createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

export class EventStore {
  private readonly raw: RawRecord[] = [];
  private readonly normalized: NormalizedEvent[] = [];
  private readonly seen = new Set<string>();

  appendRaw(record: Omit<RawRecord, "recordId"> & { recordId?: string }): NormalizedEvent | null {
    const recordId = record.recordId ?? `raw-${this.raw.length + 1}`;
    const full: RawRecord = { ...record, body: cloneUpdate(record.body), recordId };
    this.raw.push(full);
    return this.normalize(full);
  }

  private normalize(record: RawRecord): NormalizedEvent | null {
    const update = record.body;
    const key = dedupeKey(update);
    if (this.seen.has(key)) return null;
    this.seen.add(key);
    const event: NormalizedEvent = {
      eventId: `evt-${this.normalized.length + 1}`,
      eventTime: new Date(update.Ts).toISOString(),
      receiveTime: record.receivedAt,
      sequenceId: update.MessageId ?? null,
      fixtureId: String(update.FixtureId),
      marketKey: marketKey(update),
      update,
      dedupeKey: key,
      dataMode: record.dataMode,
      source: record.dataMode === "TXODDS" ? "TXODDS" : "REPLAY",
    };
    this.normalized.push(event);
    return event;
  }

  loadUpdates(updates: TxlineOddsUpdate[], dataMode: "TXODDS" | "REPLAY" = "REPLAY"): number {
    let added = 0;
    for (const update of updates) {
      const event = this.appendRaw({
        receivedAt: new Date(update.Ts).toISOString(),
        transport: "file",
        body: update,
        dataMode,
      });
      if (event) added += 1;
    }
    return added;
  }

  events(): NormalizedEvent[] {
    return this.normalized.map((event) => ({ ...event, update: cloneUpdate(event.update) })).sort((a, b) => {
      const r = a.receiveTime.localeCompare(b.receiveTime);
      if (r !== 0) return r;
      const t = a.eventTime.localeCompare(b.eventTime);
      if (t !== 0) return t;
      return (a.sequenceId ?? "").localeCompare(b.sequenceId ?? "");
    });
  }

  rawCount(): number {
    return this.raw.length;
  }

  rawRecords(): RawRecord[] {
    return this.raw.map((record) => ({ ...record, body: cloneUpdate(record.body) }));
  }

  uniqueCount(): number {
    return this.normalized.length;
  }

  duplicateRate(): number {
    if (this.raw.length === 0) return 0;
    return 1 - this.normalized.length / this.raw.length;
  }
}

export function toNormalizedMarketObservation(event: NormalizedEvent): NormalizedMarketObservation {
  const selected = selectMarketProbabilities(event.update);
  const market = mapOddsUpdateToMarket(event.update, event.source);
  return {
    observationId: event.eventId,
    eventTime: event.eventTime,
    receiveTime: event.receiveTime,
    marketId: event.marketKey,
    selectionIds: market.selections.map((selection) => selection.selectionId),
    probabilities: [...selected.probabilities],
    probabilityField: selected.field,
    demarginingStatus: selected.demarginingStatus,
    raw: {
      Prices: [...event.update.Prices],
      Pct: event.update.Pct ? [...event.update.Pct] : undefined,
      StablePrice: event.update.StablePrice ? [...event.update.StablePrice] : undefined,
    },
    provenance: {
      source: event.source,
      dataMode: event.dataMode,
      fixtureId: event.fixtureId,
      messageId: event.sequenceId,
      bookmaker: event.update.Bookmaker ?? null,
      bookmakerId: event.update.BookmakerId ?? null,
      reasonCodes: selected.reasonCodes,
    },
  };
}
