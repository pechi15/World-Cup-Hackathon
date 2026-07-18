import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EventStore } from "../../market-data/src/event-store.js";
import {
  mapFixture,
  mapOddsUpdateToMarket,
  selectMarketProbabilities,
  type TxlineFixtureRow,
  type TxlineOddsUpdate,
} from "../../market-data/src/mapper.js";
import { settleScoreMarket } from "../../market-model/src/index.js";

export const SUPPORTED_MARKOUT_HORIZONS_SECONDS = [10, 30, 60, 300] as const;
export const DATASET_SCHEMA_VERSION = "1.0.0";

export type CapturedOddsRecord = { update: TxlineOddsUpdate; receiveTime: string };
export type ExplicitSettlement = {
  fixtureId: string;
  marketId: string;
  selectionId: string;
  payout: number;
  settledAt: string;
  availableAt: string;
  provenance?: Record<string, unknown>;
};

export type ResearchCapture = {
  fixture?: TxlineFixtureRow;
  fixtures?: TxlineFixtureRow[];
  updates?: TxlineOddsUpdate[];
  oddsRecords?: CapturedOddsRecord[];
  scoreEvents?: Array<Record<string, unknown>>;
  settlements?: ExplicitSettlement[];
  sourceNetwork?: string;
};

export type ResearchTables = {
  fixtures: Array<Record<string, unknown>>;
  markets: Array<Record<string, unknown>>;
  market_events: Array<Record<string, unknown>>;
  score_events: Array<Record<string, unknown>>;
  settlements: Array<Record<string, unknown>>;
  markout_observations: Array<Record<string, unknown>>;
  data_quality: Array<Record<string, unknown>>;
  raw_events: Array<Record<string, unknown>>;
  prediction_observations: Array<Record<string, unknown>>;
};

const SECRET_KEY_FRAGMENTS = [
  "authorization", "apitoken", "token", "jwt", "secret", "privatekey", "wallet",
  "signature", "activation", "keypair", "anchorwallet",
];

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export function sanitizeForResearch(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForResearch);
  if (value && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!isSecretKey(key)) sanitized[key] = sanitizeForResearch(child);
    }
    return sanitized;
  }
  if (typeof value === "string" && /^Bearer\s+/i.test(value)) return "<redacted>";
  return value;
}

export function assertSecretFree(value: unknown): void {
  const walk = (candidate: unknown, path: string): void => {
    if (Array.isArray(candidate)) return candidate.forEach((item, index) => walk(item, `${path}[${index}]`));
    if (candidate && typeof candidate === "object") {
      for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
        if (isSecretKey(key)) throw new Error(`SECRET_FIELD_PRESENT:${path}.${key}`);
        walk(child, `${path}.${key}`);
      }
    }
    if (typeof candidate === "string" && /^Bearer\s+/i.test(candidate)) throw new Error(`AUTHORIZATION_VALUE_PRESENT:${path}`);
  };
  walk(value, "$bundle");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function timestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function get(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}

function idValue(record: Record<string, unknown>, ...keys: string[]): string | null {
  const value = get(record, ...keys);
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function numberValue(record: Record<string, unknown>, ...keys: string[]): number | null {
  const value = get(record, ...keys);
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeScoreEvents(capture: ResearchCapture, sourceNetwork: string, source: "TXODDS" | "REPLAY"): Array<Record<string, unknown>> {
  return (capture.scoreEvents ?? []).map((raw, index) => {
    const sanitized = sanitizeForResearch(raw) as Record<string, unknown>;
    const eventTime = timestamp(get(raw, "Ts", "ts", "timestamp", "eventTime"));
    const receiveTime = timestamp(get(raw, "receiveTime", "receivedAt", "availableAt")) ?? eventTime;
    if (!eventTime || !receiveTime) throw new Error(`SCORE_EVENT_TIMESTAMP_MISSING:${index}`);
    if (Date.parse(receiveTime) < Date.parse(eventTime)) throw new Error(`SCORE_EVENT_RECEIVED_BEFORE_EVENT:${index}`);
    return {
      score_event_id: idValue(raw, "MessageId", "messageId", "seq", "Seq") ?? `score-${index + 1}`,
      fixture_id: idValue(raw, "FixtureId", "fixtureId") ?? "unknown",
      event_time: eventTime,
      receive_time: receiveTime,
      available_at: receiveTime,
      sequence_id: idValue(raw, "seq", "Seq"),
      message_id: idValue(raw, "MessageId", "messageId"),
      action: idValue(raw, "action", "Action"),
      status_id: numberValue(raw, "statusId", "StatusId"),
      period: numberValue(raw, "period", "Period"),
      home_score: numberValue(raw, "homeScore", "HomeScore", "homeGoals", "HomeGoals"),
      away_score: numberValue(raw, "awayScore", "AwayScore", "awayGoals", "AwayGoals"),
      source,
      source_network: sourceNetwork,
      provenance: { source, source_network: sourceNetwork, raw_preserved: true },
      raw_fields: sanitized,
    };
  }).sort((left, right) => String(left.available_at).localeCompare(String(right.available_at)) || String(left.score_event_id).localeCompare(String(right.score_event_id)));
}

function deriveSettlements(
  capture: ResearchCapture,
  marketDefinitions: ReturnType<typeof mapOddsUpdateToMarket>[],
  scoreEvents: Array<Record<string, unknown>>,
  sourceNetwork: string,
  source: "TXODDS" | "REPLAY",
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = (capture.settlements ?? []).map((settlement) => ({
    fixture_id: settlement.fixtureId,
    market_id: settlement.marketId,
    selection_id: settlement.selectionId,
    payout: settlement.payout,
    settled_at: new Date(settlement.settledAt).toISOString(),
    available_at: new Date(settlement.availableAt).toISOString(),
    source,
    source_network: sourceNetwork,
    provenance: sanitizeForResearch(settlement.provenance ?? { source, explicit: true }),
  }));

  for (const event of scoreEvents) {
    const isFinal = event.action === "game_finalised" || (event.status_id === 100 && event.period === 100);
    const homeGoals = event.home_score as number | null;
    const awayGoals = event.away_score as number | null;
    if (!isFinal || homeGoals === null || awayGoals === null) continue;
    for (const market of marketDefinitions.filter((item) => item.fixtureId === event.fixture_id)) {
      const settlement = settleScoreMarket(market, {
        scenarioId: `final-${event.fixture_id}`,
        fixtureId: String(event.fixture_id),
        homeGoals,
        awayGoals,
        provenance: { source },
      });
      if (settlement.status !== "SETTLED") continue;
      for (const [selectionId, payout] of Object.entries(settlement.selectionPayouts)) {
        rows.push({
          fixture_id: event.fixture_id,
          market_id: market.marketId,
          selection_id: selectionId,
          payout,
          settled_at: event.event_time,
          available_at: event.available_at,
          source,
          source_network: sourceNetwork,
          provenance: { source, score_event_id: event.score_event_id, settlement_rule: market.settlementRules[0]?.ruleId ?? null },
        });
      }
    }
  }
  const deduped = new Map<string, Record<string, unknown>>();
  for (const row of rows) deduped.set(`${row.market_id}:${row.selection_id}`, row);
  return [...deduped.values()].sort((left, right) => `${left.market_id}:${left.selection_id}`.localeCompare(`${right.market_id}:${right.selection_id}`));
}

export function buildResearchTables(capture: ResearchCapture): ResearchTables {
  const sourceNetwork = capture.sourceNetwork ?? "sanitized-replay";
  const source: "TXODDS" | "REPLAY" = sourceNetwork === "txline-devnet" ? "TXODDS" : "REPLAY";
  const fixtureRows = capture.fixtures ?? (capture.fixture ? [capture.fixture] : []);
  const oddsRecords: CapturedOddsRecord[] = capture.oddsRecords ?? (capture.updates ?? []).map((update) => ({
    update,
    receiveTime: new Date(update.Ts).toISOString(),
  }));
  const store = new EventStore();
  for (const [index, record] of oddsRecords.entries()) {
    const receiveTime = new Date(record.receiveTime).toISOString();
    if (Date.parse(receiveTime) < record.update.Ts) throw new Error(`MARKET_EVENT_RECEIVED_BEFORE_EVENT:${index}`);
    store.appendRaw({
      recordId: `capture-${index + 1}`,
      receivedAt: receiveTime,
      transport: "file",
      endpoint: "sanitized-research-capture",
      body: sanitizeForResearch(record.update) as TxlineOddsUpdate,
      dataMode: source === "TXODDS" ? "TXODDS" : "REPLAY",
    });
  }
  const events = store.events();
  const marketDefinitionsById = new Map<string, ReturnType<typeof mapOddsUpdateToMarket>>();
  for (const event of events) marketDefinitionsById.set(event.marketKey, mapOddsUpdateToMarket(event.update, "REPLAY"));
  const marketDefinitions = [...marketDefinitionsById.values()].sort((left, right) => left.marketId.localeCompare(right.marketId));
  const scoreEvents = normalizeScoreEvents(capture, sourceNetwork, source);
  const settlements = deriveSettlements(capture, marketDefinitions, scoreEvents, sourceNetwork, source);
  const settlementBySelection = new Map(settlements.map((row) => [`${row.market_id}:${row.selection_id}`, row]));

  const fixtures = fixtureRows.map((row) => {
    const fixture = mapFixture(row, "REPLAY");
    return {
      fixture_id: fixture.fixtureId,
      competition_id: fixture.competitionId,
      home_team_id: fixture.homeTeamId,
      away_team_id: fixture.awayTeamId,
      start_time: fixture.startTime ?? null,
      status: fixture.status,
      source,
      source_network: sourceNetwork,
      provenance: { source, sanitized: true, raw_fixture_id: row.FixtureId },
    };
  }).sort((left, right) => left.fixture_id.localeCompare(right.fixture_id));

  const markets = marketDefinitions.map((market) => ({
    fixture_id: market.fixtureId ?? null,
    market_id: market.marketId,
    market_type: market.marketType,
    title: market.title,
    period: market.period,
    parameters: market.parameters,
    selections: market.selections.map((selection) => ({ selection_id: selection.selectionId, label: selection.label, outcome_type: selection.outcomeType })),
    settlement_rules: market.settlementRules,
    source,
    source_network: sourceNetwork,
    provenance: { source, sanitized: true },
  }));

  const marketEvents: Array<Record<string, unknown>> = [];
  const rawEvents: Array<Record<string, unknown>> = [];
  for (const event of events) {
    const selected = selectMarketProbabilities(event.update);
    const market = marketDefinitionsById.get(event.marketKey)!;
    rawEvents.push({
      event_id: event.eventId,
      event_time: event.eventTime,
      receive_time: event.receiveTime,
      available_at: event.receiveTime,
      sequence_id: event.sequenceId,
      source_network: sourceNetwork,
      raw_fields: sanitizeForResearch(event.update),
    });
    for (const [index, selection] of market.selections.entries()) {
      const joinedSettlement = settlementBySelection.get(`${market.marketId}:${selection.selectionId}`);
      marketEvents.push({
        observation_id: `${event.eventId}:${selection.selectionId}`,
        fixture_id: event.fixtureId,
        market_id: market.marketId,
        selection_id: selection.selectionId,
        event_time: event.eventTime,
        receive_time: event.receiveTime,
        available_at: event.receiveTime,
        decision_time: null,
        sequence_id: event.sequenceId,
        message_id: event.update.MessageId ?? null,
        market_probability: selected.probabilities[index] ?? null,
        probability_field: selected.field,
        demargining_status: selected.demarginingStatus,
        source,
        source_network: sourceNetwork,
        provenance: {
          source,
          data_mode: "SANITIZED_TXODDS",
          bookmaker: event.update.Bookmaker ?? null,
          bookmaker_id: event.update.BookmakerId ?? null,
          reason_codes: selected.reasonCodes,
        },
        data_quality_flags: selected.reasonCodes,
        raw_fields: {
          price_name: event.update.PriceNames[index] ?? null,
          price: event.update.Prices[index] ?? null,
          pct: event.update.Pct?.[index] ?? null,
          stable_price: event.update.StablePrice?.[index] ?? null,
        },
        settled_outcome: joinedSettlement?.payout ?? null,
        settlement_available_at: joinedSettlement?.available_at ?? null,
      });
    }
  }
  marketEvents.sort((left, right) => String(left.available_at).localeCompare(String(right.available_at)) || String(left.observation_id).localeCompare(String(right.observation_id)));

  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const row of marketEvents) {
    const key = `${row.market_id}:${row.selection_id}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  const markouts: Array<Record<string, unknown>> = [];
  for (const rows of grouped.values()) {
    rows.sort((left, right) => String(left.event_time).localeCompare(String(right.event_time)) || String(left.available_at).localeCompare(String(right.available_at)));
    for (const row of rows) {
      for (const horizon of SUPPORTED_MARKOUT_HORIZONS_SECONDS) {
        const target = Date.parse(String(row.event_time)) + horizon * 1000;
        const future = rows.find((candidate) => Date.parse(String(candidate.event_time)) >= target && String(candidate.available_at) >= String(row.available_at));
        const currentProbability = row.market_probability as number;
        const futureProbability = future?.market_probability as number | undefined;
        markouts.push({
          observation_id: row.observation_id,
          fixture_id: row.fixture_id,
          market_id: row.market_id,
          selection_id: row.selection_id,
          event_time: row.event_time,
          receive_time: row.receive_time,
          available_at: row.available_at,
          decision_time: row.decision_time,
          horizon_seconds: horizon,
          target_event_time: new Date(target).toISOString(),
          observed_event_time: future?.event_time ?? null,
          target_available_at: future?.available_at ?? null,
          market_probability: currentProbability,
          future_probability: futureProbability ?? null,
          markout: futureProbability === undefined ? null : futureProbability - currentProbability,
          status: future ? "AVAILABLE" : "MISSING_FUTURE_OBSERVATION",
          source: row.source,
          provenance: row.provenance,
        });
      }
    }
  }

  const predictionObservations = marketEvents.flatMap((row) => {
    const outcome = row.settled_outcome;
    const targetAvailable = row.settlement_available_at;
    if ((outcome !== 0 && outcome !== 1) || typeof targetAvailable !== "string" || targetAvailable <= String(row.available_at)) return [];
    return [{
      observation_id: row.observation_id,
      fixture_id: row.fixture_id,
      event_time: row.event_time,
      available_at: row.available_at,
      decision_time: row.available_at,
      target_available_at: targetAvailable,
      probability: row.market_probability,
      baseline_probability: row.market_probability,
      outcome,
      strategy_return: null,
    }];
  });

  const dataQuality: Array<Record<string, unknown>> = [{
    flag_id: "dataset-probability-semantics",
    scope: "DATASET",
    severity: "INFO",
    code: "PCT_SEMANTICS_UNVERIFIED",
    details: "Pct is preserved but never selected. StablePrice is already de-margined; raw Prices are de-vigged once.",
  }];
  if (store.rawCount() > store.uniqueCount()) dataQuality.push({
    flag_id: "dataset-duplicates-removed",
    scope: "DATASET",
    severity: "WARNING",
    code: "DUPLICATES_REMOVED",
    details: { raw_count: store.rawCount(), unique_count: store.uniqueCount(), duplicate_rate: store.duplicateRate() },
  });
  if (settlements.length === 0) dataQuality.push({
    flag_id: "dataset-no-settlements",
    scope: "DATASET",
    severity: "WARNING",
    code: "SETTLED_OUTCOMES_UNAVAILABLE",
    details: "PredictionObservation rows remain absent until a final outcome is available after decision time.",
  });

  const tables = {
    fixtures,
    markets,
    market_events: marketEvents,
    score_events: scoreEvents,
    settlements,
    markout_observations: markouts,
    data_quality: dataQuality,
    raw_events: rawEvents,
    prediction_observations: predictionObservations,
  };
  assertSecretFree(tables);
  return tables;
}

export const TABLE_SCHEMAS: Record<keyof ResearchTables, Record<string, unknown>> = {
  fixtures: { required: ["fixture_id", "competition_id", "home_team_id", "away_team_id", "source", "provenance"] },
  markets: { required: ["fixture_id", "market_id", "market_type", "selections", "settlement_rules", "source", "provenance"] },
  market_events: { required: ["fixture_id", "market_id", "selection_id", "event_time", "receive_time", "available_at", "decision_time", "market_probability", "source", "provenance"] },
  score_events: { required: ["score_event_id", "fixture_id", "event_time", "receive_time", "available_at", "source", "provenance"] },
  settlements: { required: ["fixture_id", "market_id", "selection_id", "payout", "settled_at", "available_at", "source", "provenance"] },
  markout_observations: { required: ["observation_id", "fixture_id", "market_id", "selection_id", "event_time", "available_at", "horizon_seconds", "future_probability", "markout", "status"] },
  data_quality: { required: ["flag_id", "scope", "severity", "code", "details"] },
  raw_events: { required: ["event_id", "event_time", "receive_time", "available_at", "sequence_id", "raw_fields"] },
  prediction_observations: { required: ["observation_id", "fixture_id", "event_time", "available_at", "decision_time", "target_available_at", "probability", "baseline_probability", "outcome", "strategy_return"], pydantic_contract: "quant_research.contracts.PredictionObservation" },
};

export const DATA_DICTIONARY = {
  timestamp_unit: "RFC3339 UTC with millisecond precision",
  probability_unit: "decimal probability in [0,1]",
  event_time: "Timestamp assigned by the source event.",
  receive_time: "Timestamp the backend received or captured the event.",
  available_at: "Earliest timestamp the row was available to research; equal to receive_time for source events.",
  decision_time: "Research/runtime decision timestamp; null in source-only market events.",
  target_available_at: "Timestamp a future markout or settlement target became observable; null when unavailable.",
  market_probability: "Selected StablePrice consensus probability, or one-time de-vigged raw decimal Prices probability.",
  stable_price: "TxLINE consensus StablePrice; already de-margined and never de-vigged again.",
  prices: "Raw decimal bookmaker odds; converted to implied probabilities and proportionally de-vigged once when StablePrice is absent.",
  pct: "Raw TxLINE Pct value preserved for audit; semantics unverified and never selected as probability.",
  markout: "future_probability minus market_probability; null when no future event exists at or after the horizon.",
  payout: "Settled selection payout in [0,1] under the mapped market settlement rule.",
};

function jsonl(rows: Array<Record<string, unknown>>): string {
  return rows.map((row) => canonicalJson(row)).join("\n") + (rows.length ? "\n" : "");
}

export type BundleOptions = {
  outputRoot: string;
  exportGitCommit: string;
  exportTimestamp: string;
  sourceNetwork: string;
  sourceUri: string;
};

export async function writeResearchBundle(tables: ResearchTables, options: BundleOptions): Promise<{ datasetId: string; datasetHash: string; outputDirectory: string; manifest: Record<string, unknown> }> {
  const dataFiles = Object.fromEntries((Object.keys(tables) as Array<keyof ResearchTables>).map((name) => [`${name}.jsonl`, jsonl(tables[name])]));
  const datasetHashInput = Object.entries(dataFiles).sort(([left], [right]) => left.localeCompare(right)).map(([name, content]) => `${name}\0${content}`).join("\0");
  const datasetHash = sha256(datasetHashInput);
  const datasetId = `txodds-${datasetHash.slice(0, 16)}`;
  const outputDirectory = join(options.outputRoot, datasetId);
  await mkdir(join(outputDirectory, "schemas"), { recursive: true });
  for (const [name, content] of Object.entries(dataFiles)) await writeFile(join(outputDirectory, name), content, "utf8");
  for (const [table, schema] of Object.entries(TABLE_SCHEMAS)) {
    await writeFile(join(outputDirectory, "schemas", `${table}.schema.json`), `${JSON.stringify({ schema_version: DATASET_SCHEMA_VERSION, table, ...schema }, null, 2)}\n`, "utf8");
  }
  await writeFile(join(outputDirectory, "dataset-schema.json"), `${JSON.stringify({ schema_version: DATASET_SCHEMA_VERSION, format: "JSONL", tables: TABLE_SCHEMAS }, null, 2)}\n`, "utf8");
  await writeFile(join(outputDirectory, "data-dictionary.json"), `${JSON.stringify(DATA_DICTIONARY, null, 2)}\n`, "utf8");
  await writeFile(join(outputDirectory, "dataset-hash.txt"), `${datasetHash}\n`, "utf8");
  const researchManifest = {
    schema_version: DATASET_SCHEMA_VERSION,
    dataset_id: datasetId,
    data_mode: "SANITIZED_TXODDS",
    source_type: "TXODDS_REPLAY",
    source_uri: options.sourceUri,
    content_hash: datasetHash,
    record_count: tables.market_events.length,
    fixture_count: tables.fixtures.length,
    contains_settled_outcomes: tables.settlements.length > 0,
    sanitized: true,
    generator: null,
  };
  await writeFile(join(outputDirectory, "research-dataset-manifest.json"), `${JSON.stringify(researchManifest, null, 2)}\n`, "utf8");
  const files = Object.entries(dataFiles).sort(([left], [right]) => left.localeCompare(right)).map(([path, content]) => ({ path, sha256: sha256(content), size_bytes: Buffer.byteLength(content), rows: tables[path.replace(/\.jsonl$/, "") as keyof ResearchTables].length }));
  const manifest = {
    schema_version: DATASET_SCHEMA_VERSION,
    dataset_id: datasetId,
    dataset_hash: datasetHash,
    export_git_commit: options.exportGitCommit,
    export_timestamp: new Date(options.exportTimestamp).toISOString(),
    source_network: options.sourceNetwork,
    source_uri: options.sourceUri,
    sanitized: true,
    supported_markout_horizons_seconds: [...SUPPORTED_MARKOUT_HORIZONS_SECONDS],
    files,
    research_contract: researchManifest,
  };
  assertSecretFree(manifest);
  await writeFile(join(outputDirectory, "dataset-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { datasetId, datasetHash, outputDirectory, manifest };
}
