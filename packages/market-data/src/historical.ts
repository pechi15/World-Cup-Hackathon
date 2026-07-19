import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TxlineFixtureRow, TxlineOddsUpdate } from "./mapper.js";
import { type TxlineReadOnlyAdapter, type TxlineScoreEvent } from "./txline-readonly.js";

export type HistoricalEndpoint =
  | "/api/fixtures/snapshot"
  | `/api/odds/snapshot/${string}`
  | `/api/odds/updates/${number}/${number}/${number}`
  | `/api/scores/snapshot/${string}`
  | `/api/scores/updates/${string}`
  | `/api/scores/updates/${number}/${number}/${number}`
  | `/api/scores/historical/${string}`;

export type HistoricalRecord<T extends Record<string, unknown>> = {
  endpoint: HistoricalEndpoint;
  sourceTimestamp: string | null;
  receiveTimestamp: string;
  fixtureId: string | null;
  messageId: string | null;
  sequenceId: string | null;
  provenance: {
    source: "TXODDS";
    network: "devnet";
    transport: "https-read-only";
    endpoint: HistoricalEndpoint;
  };
  raw: T;
};

export type HistoricalProbe = {
  endpoint: HistoricalEndpoint;
  status: "OK" | "ERROR";
  itemCount: number;
  receiveTimestamp: string;
  errorCode?: string;
};

export type TxlineHistoricalCapture = {
  schemaVersion: "txodds-historical-v1";
  createdAt: string;
  requestedWindow: {
    startEpochDay: number;
    endEpochDay: number;
    intervals: number[];
    emptyDayStop: number;
  };
  probedWindow: {
    earliestEpochDay: number;
    latestEpochDay: number;
    stoppedAfterEmptyDayRun: boolean;
  };
  fixtures: Array<HistoricalRecord<TxlineFixtureRow & Record<string, unknown>>>;
  oddsEvents: Array<HistoricalRecord<TxlineOddsUpdate & Record<string, unknown>>>;
  scoreEvents: Array<HistoricalRecord<TxlineScoreEvent>>;
  finalStateRecords: Array<HistoricalRecord<TxlineScoreEvent>>;
  probes: HistoricalProbe[];
};

export type HistoricalScanConfig = {
  startEpochDay: number;
  endEpochDay: number;
  intervals: number[];
  emptyDayStop: number;
  includeFixtureEndpoints?: boolean;
};

export type TxlineHistoricalAudit = {
  fixtureCount: number;
  completedFixtureCount: number;
  competitions: string[];
  teams: string[];
  earliestSourceTimestamp: string | null;
  latestSourceTimestamp: string | null;
  oddsUpdateCount: number;
  scoreUpdateCount: number;
  finalStateRecordCount: number;
  markets: Array<{
    superOddsType: string;
    marketParameters: string | null;
    marketPeriod: string | null;
    selections: string[];
  }>;
  fixturesWithFinalScores: string[];
  missingDataRate: number;
  duplicateRate: number;
  outOfOrderRate: number;
  availableFutureMarkoutHorizons: Record<"10" | "30" | "60" | "300", number>;
  observedRetention: {
    earliestEpochDayWithData: number | null;
    latestEpochDayWithData: number | null;
    probedEarliestEpochDay: number;
    probedLatestEpochDay: number;
    stoppedAfterEmptyDayRun: boolean;
    limitation: string;
  };
};

const timestampKeys = ["Ts", "Timestamp", "timestamp", "EventTime", "eventTime", "UpdatedAt", "updatedAt", "CreatedAt", "createdAt"];
const fixtureKeys = ["FixtureId", "fixtureId", "FixtureID", "fixtureID"];
const messageKeys = ["MessageId", "messageId", "MessageID", "messageID", "Id", "id"];
const sequenceKeys = ["SequenceId", "sequenceId", "Sequence", "sequence", "Seq", "seq", "MessageId", "messageId"];
const sensitiveKey = /^(authorization|x-api-token|txline_api_token|guestjwt|guest_jwt|wallet|walletpath|signature|privatekey|private_key|secret|secretpath|seedphrase)$/i;

function sanitizeReplayPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeReplayPayload);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !sensitiveKey.test(key))
      .map(([key, child]) => [key, sanitizeReplayPayload(child)]),
  );
}

function firstValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function txlineSourceTimestamp(record: Record<string, unknown>): string | null {
  const value = firstValue(record, timestampKeys);
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    const parsed = new Date(milliseconds);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (value.trim() !== "" && Number.isFinite(numeric)) return txlineSourceTimestamp({ Ts: numeric });
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function historicalRecord<T extends Record<string, unknown>>(
  raw: T,
  endpoint: HistoricalEndpoint,
  receiveTimestamp: string,
): HistoricalRecord<T> {
  return {
    endpoint,
    sourceTimestamp: txlineSourceTimestamp(raw),
    receiveTimestamp,
    fixtureId: stringValue(firstValue(raw, fixtureKeys)),
    messageId: stringValue(firstValue(raw, messageKeys)),
    sequenceId: stringValue(firstValue(raw, sequenceKeys)),
    provenance: { source: "TXODDS", network: "devnet", transport: "https-read-only", endpoint },
    raw: structuredClone(raw),
  };
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const http = message.match(/\((\d{3})\)/)?.[1];
  if (http) return `HTTP_${http}`;
  if (message.includes("TXLINE_RESPONSE_NOT_ARRAY")) return "RESPONSE_NOT_ARRAY";
  return "REQUEST_FAILED";
}

function validScanConfig(config: HistoricalScanConfig): void {
  if (!Number.isInteger(config.startEpochDay) || !Number.isInteger(config.endEpochDay) || config.startEpochDay > config.endEpochDay) {
    throw new Error("INVALID_HISTORICAL_DAY_RANGE");
  }
  if (config.intervals.length === 0 || config.intervals.some((interval) => !Number.isInteger(interval) || interval < 0)) {
    throw new Error("INVALID_HISTORICAL_INTERVALS");
  }
  if (!Number.isInteger(config.emptyDayStop) || config.emptyDayStop < 1) throw new Error("INVALID_EMPTY_DAY_STOP");
}

/**
 * Probes TxLINE backwards in UTC day/hour buckets. It reports only the observed
 * retention window; it does not infer that unprobed or empty periods are retained.
 */
export async function captureTxlineHistory(
  adapter: TxlineReadOnlyAdapter,
  config: HistoricalScanConfig,
  now: () => Date = () => new Date(),
): Promise<TxlineHistoricalCapture> {
  validScanConfig(config);
  const probes: HistoricalProbe[] = [];
  const fixtures: TxlineHistoricalCapture["fixtures"] = [];
  const oddsEvents: TxlineHistoricalCapture["oddsEvents"] = [];
  const scoreEvents: TxlineHistoricalCapture["scoreEvents"] = [];
  const finalStateRecords: TxlineHistoricalCapture["finalStateRecords"] = [];

  const fixtureEndpoint = "/api/fixtures/snapshot" as const;
  try {
    const rows = await adapter.fetchFixtureRows();
    const receivedAt = now().toISOString();
    fixtures.push(...rows.map((row) => historicalRecord(row as TxlineFixtureRow & Record<string, unknown>, fixtureEndpoint, receivedAt)));
    probes.push({ endpoint: fixtureEndpoint, status: "OK", itemCount: rows.length, receiveTimestamp: receivedAt });
  } catch (error) {
    probes.push({ endpoint: fixtureEndpoint, status: "ERROR", itemCount: 0, receiveTimestamp: now().toISOString(), errorCode: safeErrorCode(error) });
    throw error;
  }

  let emptyRun = 0;
  let sawHistoricalData = false;
  let stoppedAfterEmptyDayRun = false;
  let probedEarliestEpochDay = config.endEpochDay;
  for (let day = config.endEpochDay; day >= config.startEpochDay; day -= 1) {
    let dayItems = 0;
    probedEarliestEpochDay = day;
    const dayCalls: Array<Promise<{
      endpoint: HistoricalEndpoint;
      kind: "ODDS" | "SCORE";
      rows: Array<Record<string, unknown>>;
      receiveTimestamp: string;
      errorCode?: string;
    }>> = [];
    for (let hour = 23; hour >= 0; hour -= 1) {
      for (const interval of config.intervals) {
        const oddsEndpoint = `/api/odds/updates/${day}/${hour}/${interval}` as const;
        dayCalls.push(adapter.fetchOddsUpdates(day, hour, interval)
          .then((rows) => ({ endpoint: oddsEndpoint, kind: "ODDS" as const, rows: rows as Array<Record<string, unknown>>, receiveTimestamp: now().toISOString() }))
          .catch((error: unknown) => ({ endpoint: oddsEndpoint, kind: "ODDS" as const, rows: [], receiveTimestamp: now().toISOString(), errorCode: safeErrorCode(error) })));

        const scoreEndpoint = `/api/scores/updates/${day}/${hour}/${interval}` as const;
        dayCalls.push(adapter.fetchScoreUpdates(day, hour, interval)
          .then((rows) => ({ endpoint: scoreEndpoint, kind: "SCORE" as const, rows, receiveTimestamp: now().toISOString() }))
          .catch((error: unknown) => ({ endpoint: scoreEndpoint, kind: "SCORE" as const, rows: [], receiveTimestamp: now().toISOString(), errorCode: safeErrorCode(error) })));
      }
    }
    for (const result of await Promise.all(dayCalls)) {
      if (result.errorCode) {
        probes.push({ endpoint: result.endpoint, status: "ERROR", itemCount: 0, receiveTimestamp: result.receiveTimestamp, errorCode: result.errorCode });
        continue;
      }
      if (result.kind === "ODDS") {
        oddsEvents.push(...result.rows.map((row) => historicalRecord(row as TxlineOddsUpdate & Record<string, unknown>, result.endpoint, result.receiveTimestamp)));
      } else {
        scoreEvents.push(...result.rows.map((row) => historicalRecord(row, result.endpoint, result.receiveTimestamp)));
      }
      probes.push({ endpoint: result.endpoint, status: "OK", itemCount: result.rows.length, receiveTimestamp: result.receiveTimestamp });
      dayItems += result.rows.length;
    }
    if (dayItems > 0) {
      sawHistoricalData = true;
      emptyRun = 0;
    } else if (sawHistoricalData) {
      emptyRun += 1;
      if (emptyRun >= config.emptyDayStop) {
        stoppedAfterEmptyDayRun = true;
        break;
      }
    }
  }

  if (config.includeFixtureEndpoints !== false) {
    const fixtureIds = new Set<string>([
      ...fixtures.map((record) => record.fixtureId),
      ...oddsEvents.map((record) => record.fixtureId),
      ...scoreEvents.map((record) => record.fixtureId),
    ].filter((value): value is string => value !== null));
    for (const fixtureId of [...fixtureIds].sort()) {
      const calls: Array<{
        endpoint: HistoricalEndpoint;
        fetch: () => Promise<Array<Record<string, unknown>>>;
        destination: "ODDS" | "SCORE" | "FINAL";
      }> = [
        {
          endpoint: `/api/odds/snapshot/${fixtureId}`,
          fetch: () => adapter.fetchOddsUpdatesForFixture(fixtureId) as Promise<Array<Record<string, unknown>>>,
          destination: "ODDS",
        },
        {
          endpoint: `/api/scores/snapshot/${fixtureId}`,
          fetch: () => adapter.fetchScoreEventsForFixture(fixtureId),
          destination: "SCORE",
        },
        {
          endpoint: `/api/scores/updates/${fixtureId}`,
          fetch: () => adapter.fetchScoreUpdatesForFixture(fixtureId),
          destination: "SCORE",
        },
        {
          endpoint: `/api/scores/historical/${fixtureId}`,
          fetch: () => adapter.fetchHistoricalScoresForFixture(fixtureId),
          destination: "FINAL",
        },
      ];
      for (const call of calls) {
        try {
          const rows = await call.fetch();
          const receivedAt = now().toISOString();
          const records = rows.map((row) => historicalRecord(row, call.endpoint, receivedAt));
          if (call.destination === "ODDS") oddsEvents.push(...records as TxlineHistoricalCapture["oddsEvents"]);
          else if (call.destination === "FINAL") finalStateRecords.push(...records);
          else scoreEvents.push(...records);
          probes.push({ endpoint: call.endpoint, status: "OK", itemCount: rows.length, receiveTimestamp: receivedAt });
        } catch (error) {
          probes.push({ endpoint: call.endpoint, status: "ERROR", itemCount: 0, receiveTimestamp: now().toISOString(), errorCode: safeErrorCode(error) });
        }
      }
    }
  }

  return {
    schemaVersion: "txodds-historical-v1",
    createdAt: now().toISOString(),
    requestedWindow: { ...config, intervals: [...config.intervals] },
    probedWindow: {
      earliestEpochDay: probedEarliestEpochDay,
      latestEpochDay: config.endEpochDay,
      stoppedAfterEmptyDayRun,
    },
    fixtures,
    oddsEvents,
    scoreEvents,
    finalStateRecords,
    probes,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function identity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function isFinalRecord(record: HistoricalRecord<TxlineScoreEvent>): boolean {
  const status = String(firstValue(record.raw, ["Status", "status", "State", "state", "GameStatus", "gameStatus"]) ?? "").toLowerCase();
  return ["final", "finished", "full_time", "full-time", "completed", "settled"].some((token) => status.includes(token))
    || firstValue(record.raw, ["IsFinal", "isFinal", "Completed", "completed"]) === true;
}

function marketStreamKey(record: HistoricalRecord<Record<string, unknown>>): string {
  const raw = record.raw;
  return [
    record.fixtureId ?? "unknown",
    String(raw.SuperOddsType ?? "score"),
    String(raw.MarketParameters ?? ""),
    String(raw.MarketPeriod ?? ""),
  ].join("|");
}

function arrivalStreamKey(record: HistoricalRecord<Record<string, unknown>>): string {
  // Backfill probes days newest-to-oldest. Endpoint identity prevents that
  // deliberate request order from being misclassified as source disorder.
  return `${record.endpoint}|${marketStreamKey(record)}`;
}

export function auditTxlineHistory(capture: TxlineHistoricalCapture): TxlineHistoricalAudit {
  const allEvents: Array<HistoricalRecord<Record<string, unknown>>> = [
    ...capture.oddsEvents,
    ...capture.scoreEvents,
    ...capture.finalStateRecords,
  ];
  const fixtureIds = new Set<string>([
    ...capture.fixtures.map((record) => record.fixtureId),
    ...allEvents.map((record) => record.fixtureId),
  ].filter((value): value is string => value !== null));
  const completed = new Set(capture.finalStateRecords.filter(isFinalRecord).map((record) => record.fixtureId).filter((value): value is string => value !== null));
  for (const record of capture.scoreEvents.filter(isFinalRecord)) if (record.fixtureId) completed.add(record.fixtureId);

  const competitions = new Set<string>();
  const teams = new Set<string>();
  for (const { raw } of capture.fixtures) {
    const competition = stringValue(firstValue(raw, ["Competition", "CompetitionName", "competition", "competitionName", "CompetitionId"]));
    if (competition) competitions.add(competition);
    for (const key of ["Participant1", "Participant2", "HomeTeam", "AwayTeam", "Participant1Id", "Participant2Id"]) {
      const team = stringValue(raw[key]);
      if (team) teams.add(team);
    }
  }

  const sourceTimes = allEvents.map((record) => record.sourceTimestamp).filter((value): value is string => value !== null).sort();
  const uniqueRecords = new Set(allEvents.map((record) => identity(record.raw))).size;
  const duplicateRate = allEvents.length === 0 ? 0 : (allEvents.length - uniqueRecords) / allEvents.length;

  let outOfOrder = 0;
  let comparable = 0;
  const lastByStream = new Map<string, number>();
  for (const record of allEvents) {
    if (!record.sourceTimestamp) continue;
    const key = arrivalStreamKey(record);
    const timestamp = Date.parse(record.sourceTimestamp);
    const previous = lastByStream.get(key);
    if (previous !== undefined) {
      comparable += 1;
      if (timestamp < previous) outOfOrder += 1;
    }
    lastByStream.set(key, timestamp);
  }

  const oddsRequired = ["FixtureId", "Ts", "SuperOddsType", "MarketPeriod", "PriceNames", "Prices"];
  let missingCells = 0;
  let expectedCells = 0;
  for (const record of capture.oddsEvents) {
    for (const key of oddsRequired) {
      expectedCells += 1;
      if (record.raw[key] === undefined || record.raw[key] === null || (Array.isArray(record.raw[key]) && record.raw[key].length === 0)) missingCells += 1;
    }
  }

  const markets = new Map<string, TxlineHistoricalAudit["markets"][number]>();
  for (const { raw } of capture.oddsEvents) {
    const market = {
      superOddsType: String(raw.SuperOddsType ?? "UNKNOWN"),
      marketParameters: stringValue(raw.MarketParameters),
      marketPeriod: stringValue(raw.MarketPeriod),
      selections: Array.isArray(raw.PriceNames) ? raw.PriceNames.map(String) : [],
    };
    markets.set(identity(market), market);
  }

  const markouts: Record<"10" | "30" | "60" | "300", number> = { "10": 0, "30": 0, "60": 0, "300": 0 };
  const oddsByMarket = new Map<string, Array<HistoricalRecord<TxlineOddsUpdate & Record<string, unknown>>>>();
  for (const record of capture.oddsEvents) {
    const key = marketStreamKey(record);
    const list = oddsByMarket.get(key) ?? [];
    list.push(record);
    oddsByMarket.set(key, list);
  }
  for (const records of oddsByMarket.values()) {
    const ordered = records.filter((record) => record.sourceTimestamp).sort((a, b) => String(a.sourceTimestamp).localeCompare(String(b.sourceTimestamp)));
    for (let index = 0; index < ordered.length; index += 1) {
      const start = Date.parse(ordered[index]!.sourceTimestamp!);
      for (const horizon of [10, 30, 60, 300] as const) {
        if (ordered.slice(index + 1).some((record) => Date.parse(record.sourceTimestamp!) >= start + horizon * 1_000)) markouts[String(horizon) as keyof typeof markouts] += 1;
      }
    }
  }

  const dataDays = new Set<number>();
  for (const timestamp of sourceTimes) dataDays.add(Math.floor(Date.parse(timestamp) / 86_400_000));
  const sortedDays = [...dataDays].sort((a, b) => a - b);
  return {
    fixtureCount: fixtureIds.size,
    completedFixtureCount: completed.size,
    competitions: [...competitions].sort(),
    teams: [...teams].sort(),
    earliestSourceTimestamp: sourceTimes[0] ?? null,
    latestSourceTimestamp: sourceTimes.at(-1) ?? null,
    oddsUpdateCount: capture.oddsEvents.length,
    scoreUpdateCount: capture.scoreEvents.length,
    finalStateRecordCount: capture.finalStateRecords.length,
    markets: [...markets.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    fixturesWithFinalScores: [...completed].sort(),
    missingDataRate: expectedCells === 0 ? 0 : missingCells / expectedCells,
    duplicateRate,
    outOfOrderRate: comparable === 0 ? 0 : outOfOrder / comparable,
    availableFutureMarkoutHorizons: markouts,
    observedRetention: {
      earliestEpochDayWithData: sortedDays[0] ?? null,
      latestEpochDayWithData: sortedDays.at(-1) ?? null,
      probedEarliestEpochDay: capture.probedWindow.earliestEpochDay,
      probedLatestEpochDay: capture.probedWindow.latestEpochDay,
      stoppedAfterEmptyDayRun: capture.probedWindow.stoppedAfterEmptyDayRun,
      limitation: "Observed data range is subscription/API evidence only; empty responses do not prove permanent deletion and unprobed dates are not claimed as retained.",
    },
  };
}

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
}

export function historicalAuditMarkdown(audit: TxlineHistoricalAudit, datasetId: string): string {
  const pct = (value: number) => `${(value * 100).toFixed(4)}%`;
  const marketRows = audit.markets.length
    ? audit.markets.map((market) => `| ${market.superOddsType} | ${market.marketParameters ?? ""} | ${market.marketPeriod ?? ""} | ${market.selections.join(", ")} |`).join("\n")
    : "| _none returned_ |  |  |  |";
  return `# TxODDS historical data audit\n\n` +
    `Dataset: \`${datasetId}\`\n\nGenerated from authenticated, read-only TxLINE devnet responses. Raw values are preserved in the ignored local export.\n\n` +
    `| Metric | Value |\n|---|---:|\n` +
    `| Fixtures found | ${audit.fixtureCount} |\n| Completed fixtures | ${audit.completedFixtureCount} |\n` +
    `| Competitions | ${audit.competitions.join(", ") || "None returned"} |\n| Teams | ${audit.teams.join(", ") || "None returned"} |\n` +
    `| Earliest source timestamp | ${audit.earliestSourceTimestamp ?? "None"} |\n| Latest source timestamp | ${audit.latestSourceTimestamp ?? "None"} |\n` +
    `| Odds updates | ${audit.oddsUpdateCount} |\n| Score updates | ${audit.scoreUpdateCount} |\n| Final-state records | ${audit.finalStateRecordCount} |\n` +
    `| Fixtures with final scores | ${audit.fixturesWithFinalScores.length} |\n| Missing-data rate | ${pct(audit.missingDataRate)} |\n` +
    `| Duplicate rate | ${pct(audit.duplicateRate)} |\n| Out-of-order rate | ${pct(audit.outOfOrderRate)} |\n\n` +
    `## Markets\n\n| SuperOddsType | MarketParameters | MarketPeriod | Selections |\n|---|---|---|---|\n${marketRows}\n\n` +
    `## Future markout availability\n\n| Horizon | Observations with a future mark |\n|---|---:|\n` +
    Object.entries(audit.availableFutureMarkoutHorizons).map(([horizon, count]) => `| ${horizon}s | ${count} |`).join("\n") +
    `\n\n## Actual API retention limitations\n\n` +
    `Observed epoch-day range with returned data: ${audit.observedRetention.earliestEpochDayWithData ?? "none"} to ${audit.observedRetention.latestEpochDayWithData ?? "none"}. ` +
    `Probed: ${audit.observedRetention.probedEarliestEpochDay} to ${audit.observedRetention.probedLatestEpochDay}. ` +
    `${audit.observedRetention.limitation}\n`;
}

export type HistoricalExportResult = {
  datasetId: string;
  outputDirectory: string;
  audit: TxlineHistoricalAudit;
  auditMarkdown: string;
};

export async function writeHistoricalExport(capture: TxlineHistoricalCapture, outputRoot: string): Promise<HistoricalExportResult> {
  const contentHash = identity({
    fixtures: capture.fixtures,
    oddsEvents: capture.oddsEvents,
    scoreEvents: capture.scoreEvents,
    finalStateRecords: capture.finalStateRecords,
  });
  const datasetId = `txodds-history-${contentHash.slice(0, 16)}`;
  const outputDirectory = join(outputRoot, datasetId);
  const audit = auditTxlineHistory(capture);
  const auditMarkdown = historicalAuditMarkdown(audit, datasetId);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(outputDirectory, "capture.json"), `${JSON.stringify(capture, null, 2)}\n`, "utf8"),
    writeFile(join(outputDirectory, "fixtures.jsonl"), jsonl(capture.fixtures), "utf8"),
    writeFile(join(outputDirectory, "odds-events.jsonl"), jsonl(capture.oddsEvents), "utf8"),
    writeFile(join(outputDirectory, "score-events.jsonl"), jsonl(capture.scoreEvents), "utf8"),
    writeFile(join(outputDirectory, "final-state-records.jsonl"), jsonl(capture.finalStateRecords), "utf8"),
    writeFile(join(outputDirectory, "probes.jsonl"), jsonl(capture.probes), "utf8"),
    writeFile(join(outputDirectory, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8"),
    writeFile(join(outputDirectory, "audit.md"), auditMarkdown, "utf8"),
    writeFile(join(outputDirectory, "dataset-id.txt"), `${datasetId}\n`, "utf8"),
  ]);
  return { datasetId, outputDirectory, audit, auditMarkdown };
}

export function createSanitizedHistoricalReplay(capture: TxlineHistoricalCapture, maximumOddsEvents = 50): Record<string, unknown> {
  const firstOdds = capture.oddsEvents.find((record) => record.fixtureId !== null);
  if (!firstOdds?.fixtureId) throw new Error("NO_ODDS_EVENTS_FOR_REPLAY");
  const fixtureId = firstOdds.fixtureId;
  const odds = capture.oddsEvents.filter((record) => record.fixtureId === fixtureId).slice(0, maximumOddsEvents);
  const scores = [...capture.scoreEvents, ...capture.finalStateRecords].filter((record) => record.fixtureId === fixtureId);
  const fixture = capture.fixtures.find((record) => record.fixtureId === fixtureId)?.raw ?? { FixtureId: Number(fixtureId) || fixtureId };
  const payload = {
    schemaVersion: "txodds-sanitized-historical-replay-v1",
    data_mode: "REPLAY",
    label: "SANITIZED_RECORDED_TXODDS_HISTORICAL",
    notes: "Recorded from authenticated read-only TxLINE devnet history; credentials and authorization material removed.",
    provenance: {
      source: "TXODDS",
      network: "devnet",
      fixtureId,
      sourceEndpoints: [...new Set([...odds, ...scores].map((record) => record.endpoint))].sort(),
    },
    fixture,
    fixtures: [fixture],
    updates: odds.map((record) => record.raw),
    oddsRecords: odds.map((record) => ({ update: record.raw, receiveTime: record.receiveTimestamp, sourceTime: record.sourceTimestamp, endpoint: record.endpoint })),
    scoreEvents: scores.map((record) => ({ ...record.raw, receiveTime: record.receiveTimestamp, sourceTime: record.sourceTimestamp, endpoint: record.endpoint })),
  };
  return sanitizeReplayPayload(payload) as Record<string, unknown>;
}
