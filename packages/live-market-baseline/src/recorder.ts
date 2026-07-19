import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TxlineFixtureRow, TxlineOddsUpdate } from "../../market-data/src/mapper.js";

const secretKey = /(authorization|api[_-]?token|jwt|private[_-]?key|wallet|signature|activation|secret|credential)/i;

function sanitizeForRecording(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForRecording);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !secretKey.test(key))
    .map(([key, item]) => [key, sanitizeForRecording(item)]));
}

function assertSecretFree(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (/Bearer\s+[^"\s]+/i.test(serialized) || secretKey.test(Object.keys(value && typeof value === "object" ? value as object : {}).join("|"))) {
    throw new Error("RECORDING_CONTAINS_FORBIDDEN_SECRET");
  }
}

export type RecordingKind =
  | "CONNECTION"
  | "FIXTURE"
  | "ODDS_SNAPSHOT"
  | "ODDS_SSE"
  | "SCORE"
  | "NORMALIZED_MARKET"
  | "PAPER_QUOTE"
  | "QUOTE_CANCELLATION"
  | "PAPER_FILL"
  | "POSITION"
  | "PNL"
  | "RISK"
  | "AUDIT";

export type RecordedLine = {
  kind: RecordingKind;
  recordedAt: string;
  payload: unknown;
};

export class SanitizedLiveRecorder {
  readonly lines: RecordedLine[] = [];
  readonly fixtures: TxlineFixtureRow[] = [];
  readonly updates: Array<{ update: TxlineOddsUpdate; receiveTime: string }> = [];
  readonly scoreEvents: Array<Record<string, unknown>> = [];
  private readonly fixtureKeys = new Set<string>();
  private readonly updateKeys = new Set<string>();
  private readonly scoreKeys = new Set<string>();

  record(kind: RecordingKind, payload: unknown, recordedAt = new Date().toISOString()): void {
    const sanitized = sanitizeForRecording(payload);
    assertSecretFree(sanitized);
    this.lines.push({ kind, recordedAt, payload: sanitized });
    if (kind === "FIXTURE") {
      const fixture = sanitized as TxlineFixtureRow;
      const key = String(fixture.FixtureId);
      if (!this.fixtureKeys.has(key)) {
        this.fixtureKeys.add(key);
        this.fixtures.push(fixture);
      }
    }
    if (kind === "ODDS_SNAPSHOT" || kind === "ODDS_SSE") {
      const value = sanitized as { update?: TxlineOddsUpdate; receiveTime?: string };
      if (value.update) {
        const key = `${value.update.MessageId ?? ""}|${value.update.FixtureId}|${value.update.Ts}|${value.update.SuperOddsType}|${value.update.MarketParameters ?? ""}|${value.update.MarketPeriod ?? ""}`;
        if (!this.updateKeys.has(key)) {
          this.updateKeys.add(key);
          this.updates.push({ update: value.update, receiveTime: value.receiveTime ?? recordedAt });
        }
      }
    }
    if (kind === "SCORE") {
      const score = sanitized as Record<string, unknown>;
      const key = `${score.MessageId ?? score.messageId ?? ""}|${score.FixtureId ?? score.fixtureId ?? ""}|${score.Ts ?? score.ts ?? score.eventTime ?? ""}|${score.action ?? score.Action ?? ""}`;
      if (!this.scoreKeys.has(key)) {
        this.scoreKeys.add(key);
        this.scoreEvents.push(score);
      }
    }
  }

  async write(outputRoot: string, startedAt: string, endedAt: string): Promise<{ outputDirectory: string; recordingPath: string; replayPath: string }> {
    const id = `txodds-market-baseline-${startedAt.replace(/[^0-9]/g, "").slice(0, 17)}`;
    const outputDirectory = join(outputRoot, id);
    await mkdir(outputDirectory, { recursive: true });
    const recordingPath = join(outputDirectory, "recording.jsonl");
    const replayPath = join(outputDirectory, "sanitized-replay.json");
    const jsonl = this.lines.map((line) => JSON.stringify(line)).join("\n") + (this.lines.length ? "\n" : "");
    const replay = {
      schemaVersion: "txodds-sanitized-replay-v1",
      startedAt,
      endedAt,
      fixture: this.fixtures[0] ?? null,
      fixtures: this.fixtures,
      updates: this.updates.map((entry) => entry.update),
      oddsRecords: this.updates,
      scoreEvents: this.scoreEvents,
      provenance: {
        source: "TXODDS",
        network: "devnet",
        sanitized: true,
        quoteMode: "MARKET_BASELINE_MAKER_ONLY",
        independentAlpha: false,
      },
    };
    assertSecretFree(replay);
    const eventCountsByKind = Object.fromEntries([...new Set(this.lines.map((line) => line.kind))]
      .sort()
      .map((kind) => [kind, this.lines.filter((line) => line.kind === kind).length]));
    await writeFile(recordingPath, jsonl, "utf8");
    await writeFile(replayPath, `${JSON.stringify(replay, null, 2)}\n`, "utf8");
    await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify({
      schemaVersion: "live-market-baseline-recording-v1",
      startedAt,
      endedAt,
      durationMs: Date.parse(endedAt) - Date.parse(startedAt),
      eventCount: this.lines.length,
      eventCountsByKind,
      fixtureCount: this.fixtures.length,
      oddsEventCount: this.updates.length,
      scoreEventCount: this.scoreEvents.length,
      sanitized: true,
      credentialsIncluded: false,
    }, null, 2)}\n`, "utf8");
    return { outputDirectory, recordingPath, replayPath };
  }
}
