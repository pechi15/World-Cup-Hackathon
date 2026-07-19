import { createHash } from "node:crypto";
import {
  selectMarketProbabilities,
  type TxlineFixtureRow,
  type TxlineOddsUpdate,
  type TxlineScoreEvent,
} from "../../market-data/src/index.js";

export type FixtureMatch = {
  fixtureId: string;
  participant1: string;
  participant2: string;
  row: TxlineFixtureRow;
};

export type ScoreFixtureMatch = {
  fixtureId: string;
  participant1: string;
  participant2: string;
  row: TxlineScoreEvent;
};

export type SanitizedMarketEvent = {
  timestamp: string;
  fixtureId: string;
  marketId: string;
  marketType: string;
  marketParameters: string | null;
  marketPeriod: string;
  inRunning: boolean;
  selectionIds: string[];
  selectionLabels: string[];
  marketProbabilities: number[];
  probabilityField: "STABLE_PRICE" | "PRICES_DECIMAL";
  demarginingStatus: "VERIFIED_RAW_REQUIRES_DEVIG" | "VERIFIED_ALREADY_DEMARGINED";
  messageId: string | null;
  reasonCodes: string[];
};

const credentialKey = /authorization|api.?token|guest.?jwt|secret|private.?key|wallet|signature|keypair|activation/i;

export function normalizeTeamName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function directParticipantNames(row: Record<string, unknown>): string[] {
  const pairs = [
    [row.Participant1, row.Participant2],
    [row.HomeTeam, row.AwayTeam],
    [row.Team1, row.Team2],
    [row.Participant1Name, row.Participant2Name],
  ];
  for (const pair of pairs) {
    const names = pair.map(stringValue).filter((value): value is string => value !== null);
    if (names.length === 2) return names;
  }
  return [];
}

function lineupParticipantNames(row: Record<string, unknown>): Array<{ id: number | null; name: string }> {
  if (!Array.isArray(row.Lineups)) return [];
  return row.Lineups.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const team = value as Record<string, unknown>;
    const name = stringValue(team.preferredName ?? team.Name ?? team.name);
    if (!name) return [];
    return [{ id: numberValue(team.normativeId ?? team.ParticipantId ?? team.id), name }];
  });
}

function orderedScoreParticipants(row: Record<string, unknown>): string[] {
  const direct = directParticipantNames(row);
  if (direct.length === 2) return direct;
  const lineups = lineupParticipantNames(row);
  const participant1Id = numberValue(row.Participant1Id);
  const participant2Id = numberValue(row.Participant2Id);
  if (participant1Id !== null && participant2Id !== null) {
    const participant1 = lineups.find((team) => team.id === participant1Id)?.name;
    const participant2 = lineups.find((team) => team.id === participant2Id)?.name;
    if (participant1 && participant2) return [participant1, participant2];
  }
  return lineups.map((team) => team.name).slice(0, 2);
}

export function teamPairMatches(names: string[], left: string, right: string): boolean {
  if (names.length < 2) return false;
  const normalized = names.map(normalizeTeamName);
  const expected = [normalizeTeamName(left), normalizeTeamName(right)];
  return expected.every((team) => normalized.some((candidate) => candidate === team));
}

export function findFixtureByTeams(rows: TxlineFixtureRow[], left: string, right: string): FixtureMatch | null {
  for (const row of rows) {
    const names = directParticipantNames(row as unknown as Record<string, unknown>);
    if (!teamPairMatches(names, left, right)) continue;
    return {
      fixtureId: String(row.FixtureId),
      participant1: names[0]!,
      participant2: names[1]!,
      row,
    };
  }
  return null;
}

export function findScoreFixtureByTeams(rows: TxlineScoreEvent[], left: string, right: string): ScoreFixtureMatch | null {
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const names = orderedScoreParticipants(record);
    if (!teamPairMatches(names, left, right)) continue;
    const fixtureId = numberValue(record.FixtureId) ?? stringValue(record.FixtureId);
    if (fixtureId === null) continue;
    return {
      fixtureId: String(fixtureId),
      participant1: names[0]!,
      participant2: names[1]!,
      row,
    };
  }
  return null;
}

export function txlineTimestamp(row: Record<string, unknown>): string {
  const raw = numberValue(row.Ts) ?? numberValue(row.Timestamp) ?? numberValue(row.timestamp);
  if (raw === null) throw new Error("TXLINE_TIMESTAMP_MISSING");
  const milliseconds = raw < 10_000_000_000 ? raw * 1_000 : raw;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) throw new Error("TXLINE_TIMESTAMP_INVALID");
  return date.toISOString();
}

function marketId(update: TxlineOddsUpdate): string {
  return [
    update.FixtureId,
    update.SuperOddsType,
    update.MarketParameters ?? "",
    update.MarketPeriod ?? "FULL_MATCH",
  ].join(":");
}

export function sanitizeMarketUpdate(update: TxlineOddsUpdate): SanitizedMarketEvent {
  const selected = selectMarketProbabilities(update);
  const id = marketId(update);
  return {
    timestamp: txlineTimestamp(update as unknown as Record<string, unknown>),
    fixtureId: String(update.FixtureId),
    marketId: id,
    marketType: update.SuperOddsType,
    marketParameters: update.MarketParameters ?? null,
    marketPeriod: update.MarketPeriod ?? "FULL_MATCH",
    inRunning: update.InRunning === true,
    selectionIds: update.PriceNames.map((name, index) => `${id}:${index}:${name}`.replace(/\s+/g, "_")),
    selectionLabels: [...update.PriceNames],
    marketProbabilities: selected.probabilities,
    probabilityField: selected.field,
    demarginingStatus: selected.demarginingStatus,
    messageId: update.MessageId ?? null,
    reasonCodes: [...selected.reasonCodes],
  };
}

export function partitionMarketUpdates(updates: TxlineOddsUpdate[]): {
  valid: TxlineOddsUpdate[];
  rejected: Array<{ fixtureId: string; messageId: string | null; reasonCode: string }>;
} {
  const valid: TxlineOddsUpdate[] = [];
  const rejected: Array<{ fixtureId: string; messageId: string | null; reasonCode: string }> = [];
  for (const update of updates) {
    try {
      sanitizeMarketUpdate(update);
      valid.push(update);
    } catch (error) {
      rejected.push({
        fixtureId: String(update.FixtureId),
        messageId: update.MessageId ?? null,
        reasonCode: error instanceof Error ? error.message.split(":", 1)[0]! : "INVALID_MARKET_UPDATE",
      });
    }
  }
  return { valid, rejected };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function identity(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function sortAndDedupeOdds(updates: TxlineOddsUpdate[]): TxlineOddsUpdate[] {
  const unique = new Map<string, TxlineOddsUpdate>();
  for (const update of updates) unique.set(identity(update), update);
  return [...unique.values()].sort((left, right) => {
    const time = left.Ts - right.Ts;
    if (time !== 0) return time;
    return canonicalJson(left).localeCompare(canonicalJson(right));
  });
}

export function sortAndDedupeScores(rows: TxlineScoreEvent[]): TxlineScoreEvent[] {
  const unique = new Map<string, TxlineScoreEvent>();
  for (const row of rows) unique.set(identity(row), row);
  return [...unique.values()].sort((left, right) => {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const time = Date.parse(txlineTimestamp(leftRecord)) - Date.parse(txlineTimestamp(rightRecord));
    if (time !== 0) return time;
    return canonicalJson(left).localeCompare(canonicalJson(right));
  });
}

export function isFinalScoreEvent(row: TxlineScoreEvent): boolean {
  const record = row as Record<string, unknown>;
  const action = String(record.Action ?? record.action ?? "").toLowerCase();
  const statusId = Number(record.StatusId ?? record.statusId ?? NaN);
  const gameState = String(record.GameState ?? record.Status ?? record.State ?? "").toLowerCase();
  return action === "game_finalised"
    || statusId === 100
    || ["final", "finished", "completed", "settled"].includes(gameState);
}

function scoreGoals(side: unknown): number | null {
  if (!side || typeof side !== "object") return null;
  const record = side as Record<string, unknown>;
  const total = record.Total;
  if (!total || typeof total !== "object") return null;
  return numberValue((total as Record<string, unknown>).Goals);
}

export function sanitizeScoreEvent(row: TxlineScoreEvent): Record<string, unknown> {
  const record = row as Record<string, unknown>;
  const score = record.Score && typeof record.Score === "object" ? record.Score as Record<string, unknown> : null;
  return {
    timestamp: txlineTimestamp(record),
    fixtureId: String(record.FixtureId),
    action: stringValue(record.Action ?? record.action),
    statusId: numberValue(record.StatusId ?? record.statusId),
    participant1Goals: scoreGoals(score?.Participant1),
    participant2Goals: scoreGoals(score?.Participant2),
    confirmed: typeof record.Confirmed === "boolean" ? record.Confirmed : null,
    final: isFinalScoreEvent(row),
  };
}

function sanitizedUpdate(update: TxlineOddsUpdate): TxlineOddsUpdate {
  return {
    FixtureId: update.FixtureId,
    MessageId: update.MessageId,
    Ts: update.Ts,
    Bookmaker: update.Bookmaker,
    BookmakerId: update.BookmakerId,
    SuperOddsType: update.SuperOddsType,
    GameState: update.GameState,
    InRunning: update.InRunning,
    MarketParameters: update.MarketParameters,
    MarketPeriod: update.MarketPeriod,
    PriceNames: [...update.PriceNames],
    Prices: [...update.Prices],
    ...(update.StablePrice ? { StablePrice: [...update.StablePrice] } : {}),
  };
}

export function buildCurrentFixtureSample(input: {
  match: FixtureMatch;
  snapshotUpdates: TxlineOddsUpdate[];
  streamUpdates: TxlineOddsUpdate[];
  capturedAt: string;
  stream: { attempted: boolean; available: boolean; quiet: boolean; fallbackPollPerformed: boolean };
}): Record<string, unknown> {
  const candidates = sortAndDedupeOdds([...input.snapshotUpdates, ...input.streamUpdates])
    .filter((update) => String(update.FixtureId) === input.match.fixtureId);
  const updates = partitionMarketUpdates(candidates);
  const startTime = input.match.row.StartTime ? new Date(input.match.row.StartTime).toISOString() : null;
  const futureFixture = startTime !== null && Date.parse(startTime) > Date.parse(input.capturedAt);
  return {
    schemaVersion: "txodds-current-fixture-v1",
    id: "argentina-spain",
    capturedAt: input.capturedAt,
    provenance: "SANITIZED_TXODDS",
    labels: ["LIVE_TXODDS_INPUT", "PAPER_ONLY", "NO_REAL_EXECUTION"],
    fixture: {
      fixtureId: input.match.fixtureId,
      participant1: input.match.participant1,
      participant2: input.match.participant2,
      participant1IsHome: input.match.row.Participant1IsHome !== false,
      competitionId: input.match.row.CompetitionId ? String(input.match.row.CompetitionId) : null,
      competition: input.match.row.Competition ?? null,
      startTime,
      gameState: input.match.row.GameState ?? null,
    },
    stream: input.stream,
    marketSnapshots: updates.valid.map(sanitizeMarketUpdate),
    dataQuality: {
      receivedMarketEvents: candidates.length,
      acceptedMarketEvents: updates.valid.length,
      rejectedMarketEvents: updates.rejected,
    },
    finalState: null,
    resultStatus: futureFixture ? "FUTURE_FIXTURE_NO_RESULT" : "NO_VERIFIED_FINAL_RESULT",
    reasonCodes: futureFixture ? ["FINAL_RESULT_NOT_YET_AVAILABLE", "RESULT_NOT_FABRICATED"] : ["FINAL_RESULT_NOT_RETRIEVED", "RESULT_NOT_FABRICATED"],
    credentialsIncluded: false,
  };
}

export function buildHistoricalReplay(input: {
  match: ScoreFixtureMatch;
  oddsUpdates: TxlineOddsUpdate[];
  scoreEvents: TxlineScoreEvent[];
  discoveredEpochDay: number;
}): Record<string, unknown> {
  const oddsCandidates = sortAndDedupeOdds(input.oddsUpdates)
    .filter((update) => String(update.FixtureId) === input.match.fixtureId);
  const odds = partitionMarketUpdates(oddsCandidates);
  const scores = sortAndDedupeScores(input.scoreEvents)
    .filter((row) => String((row as Record<string, unknown>).FixtureId) === input.match.fixtureId);
  const finalEvent = [...scores].reverse().find(isFinalScoreEvent) ?? null;
  const finalState = finalEvent ? sanitizeScoreEvent(finalEvent) : null;
  const startTimeValue = numberValue((input.match.row as Record<string, unknown>).StartTime);
  const fixture: TxlineFixtureRow = {
    FixtureId: Number(input.match.fixtureId),
    Participant1: input.match.participant1,
    Participant2: input.match.participant2,
    Participant1Id: numberValue((input.match.row as Record<string, unknown>).Participant1Id) ?? undefined,
    Participant2Id: numberValue((input.match.row as Record<string, unknown>).Participant2Id) ?? undefined,
    Participant1IsHome: (input.match.row as Record<string, unknown>).Participant1IsHome !== false,
    CompetitionId: numberValue((input.match.row as Record<string, unknown>).CompetitionId) ?? undefined,
    StartTime: startTimeValue ?? undefined,
  };
  const payload = {
    schemaVersion: "txodds-sanitized-deterministic-replay-v1",
    id: "england-france-third-place",
    provenance: "RECORDED_TXODDS_REPLAY",
    labels: ["REPLAY_HAWK_HEURISTIC", "PAPER_ONLY", "NOT_PROVEN_ALPHA"],
    discoveredBy: { teams: ["England", "France"], epochDay: input.discoveredEpochDay, fixtureIdHardCoded: false },
    fixture,
    fixtures: [fixture],
    marketEvents: odds.valid.map(sanitizeMarketUpdate),
    updates: odds.valid.map(sanitizedUpdate),
    dataQuality: {
      receivedMarketEvents: oddsCandidates.length,
      acceptedMarketEvents: odds.valid.length,
      rejectedMarketEvents: odds.rejected,
    },
    scoreEvents: scores.map(sanitizeScoreEvent),
    finalState,
    finalResultVerified: finalState !== null,
    resultFabricated: false,
    credentialsIncluded: false,
  };
  return { ...payload, contentHash: identity(payload) };
}

export function containsCredentialMaterial(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialMaterial);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => credentialKey.test(key) || containsCredentialMaterial(item));
}
