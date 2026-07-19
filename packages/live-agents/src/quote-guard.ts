import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const ProvenanceSchema = z.enum(["SANITIZED_TXODDS", "RECORDED_TXODDS_REPLAY", "DETERMINISTIC_REPLAY", "SYNTHETIC_TEST"]);

export const QuoteGuardRowSchema = z.object({
  timestamp: z.string().datetime(),
  fixtureId: z.string(),
  marketId: z.string(),
  selectionId: z.string(),
  marketProbability: z.number().min(0).max(1),
  regime: z.enum(["QUIET", "VOLATILE", "SHOCK"]),
  riskScore: z.number().min(0).max(1),
  widthMultiplier: z.number().min(1),
  sizeMultiplier: z.number().min(0).max(1),
  recommendedAction: z.enum(["BASELINE", "DEFENSIVE", "SUSPEND", "HOLD_SUSPENDED", "RESUME"]),
  provenance: ProvenanceSchema,
  featureDrivers: z.array(z.string()).optional(),
  lookaheadUsed: z.literal(false),
  maxSourceTimestampUsed: z.string().datetime(),
});

export type QuoteGuardRow = z.infer<typeof QuoteGuardRowSchema>;

const PolicySchema = z.object({
  provenance: ProvenanceSchema,
  labels: z.array(z.string()),
  paperOnly: z.literal(true),
  widthMultiplier: z.object({ formula: z.literal("1 + 1.75 * riskScore") }),
  sizeMultiplier: z.object({ formula: z.literal("max(0.15, (1 - riskScore)^2)") }),
  controlledResumption: z.object({ freshObservationsBelowDefensiveThresholdRequired: z.literal(3) }),
  allowedEffects: z.array(z.string()),
  forbiddenEffects: z.array(z.string()),
});

const AuditSchema = z.object({
  provenance: ProvenanceSchema,
  sanitized: z.literal(true),
  credentialsDetected: z.literal(false),
  labels: z.array(z.string()),
});

const MetricsSchema = z.object({
  model: z.object({ converged: z.literal(true) }),
  timelineRowCount: z.number().int().positive(),
});

const expectedChecksums: Record<string, string> = {
  "data-audit.json": "2ddba65320c15bf72eeb558c0627616404845548a527ee9a921aec60cb61e395",
  "demo-risk-timeline.json": "a55ab25fd94b81e6b858be652c2140042d3afcd530ef8b263fb3536105ca1c07",
  "metrics.json": "1fd7a9ea1c415c8d6e25819b1104fa98ba10cc8d4484f2e0d5da455e934f455e",
  "model-card.md": "930d9f0be15d8f8433b34e631f737f9c17b3fb06cfcf8b593f62e3bab4d5e259",
  "quote-risk-policy.json": "deca035e239e821327656ec4312f348c87333910c7d78a4e11ee2b968d385231",
};

function hash(value: Buffer): string {
  // Git may materialize text artifacts with CRLF on Windows. The source ZIP
  // checksums use LF, so validate canonical text bytes without weakening the
  // content check.
  return createHash("sha256").update(value.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");
}

function streamKey(row: Pick<QuoteGuardRow, "fixtureId" | "marketId" | "selectionId">): string {
  return `${row.fixtureId}|${row.marketId}|${row.selectionId}`;
}

export type QuoteGuardLookup =
  | { available: true; row: QuoteGuardRow; reasonCodes: string[] }
  | { available: false; row: null; reasonCodes: string[] };

export class AdaptiveQuoteGuard {
  private readonly byStream = new Map<string, QuoteGuardRow[]>();

  constructor(
    readonly rows: QuoteGuardRow[],
    readonly provenance: z.infer<typeof ProvenanceSchema>,
    readonly labels: string[],
    readonly validatedChecksums = true,
  ) {
    for (const row of rows) {
      const key = streamKey(row);
      const list = this.byStream.get(key) ?? [];
      list.push(row);
      this.byStream.set(key, list);
    }
    for (const list of this.byStream.values()) list.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  lookup(input: { timestamp: string; fixtureId: string; marketId: string; selectionId: string }): QuoteGuardLookup {
    const rows = this.byStream.get(streamKey(input));
    if (!rows?.length) return { available: false, row: null, reasonCodes: ["QUOTE_GUARD_DATA_UNAVAILABLE", "BASELINE_POLICY_PRESERVED"] };
    let selected: QuoteGuardRow | null = null;
    for (const row of rows) {
      if (Date.parse(row.timestamp) > Date.parse(input.timestamp)) break;
      selected = row;
    }
    if (!selected) return { available: false, row: null, reasonCodes: ["QUOTE_GUARD_NO_PAST_ROW", "FUTURE_LOOKAHEAD_FORBIDDEN", "BASELINE_POLICY_PRESERVED"] };
    return { available: true, row: selected, reasonCodes: ["QUOTE_GUARD_PAST_ROW_APPLIED"] };
  }

  status() {
    return {
      status: "AVAILABLE",
      provenance: this.provenance,
      labels: [...this.labels],
      timelineRows: this.rows.length,
      checksumsValidated: this.validatedChecksums,
      effects: ["WIDTH", "SIZE", "PAPER_SUSPENSION", "CONTROLLED_RESUMPTION"],
      forbiddenEffects: ["QUOTE_CENTRE", "DIRECTIONAL_EDGE", "KELLY", "REAL_EXECUTION"],
    };
  }
}

export function loadAdaptiveQuoteGuard(directory: string): AdaptiveQuoteGuard {
  const contents = Object.fromEntries(
    Object.entries(expectedChecksums).map(([name, expected]) => {
      const bytes = readFileSync(path.join(directory, name));
      if (hash(bytes) !== expected) throw new Error(`QUOTE_GUARD_CHECKSUM_MISMATCH:${name}`);
      return [name, bytes.toString("utf8")];
    }),
  );
  const audit = AuditSchema.parse(JSON.parse(contents["data-audit.json"]!));
  const policy = PolicySchema.parse(JSON.parse(contents["quote-risk-policy.json"]!));
  const metrics = MetricsSchema.parse(JSON.parse(contents["metrics.json"]!));
  const rows = z.array(QuoteGuardRowSchema).parse(JSON.parse(contents["demo-risk-timeline.json"]!));
  if (audit.provenance !== policy.provenance) throw new Error("QUOTE_GUARD_PROVENANCE_MISMATCH");
  if (audit.provenance === "SYNTHETIC_TEST") throw new Error("SYNTHETIC_QUOTE_GUARD_CANNOT_CONTROL_DEFAULT_MODE");
  if (rows.length !== metrics.timelineRowCount) throw new Error("QUOTE_GUARD_TIMELINE_COUNT_MISMATCH");
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.provenance !== audit.provenance) throw new Error("QUOTE_GUARD_ROW_PROVENANCE_MISMATCH");
    if (Date.parse(row.maxSourceTimestampUsed) > Date.parse(row.timestamp)) throw new Error("QUOTE_GUARD_FUTURE_LOOKAHEAD");
    if (index > 0 && rows[index - 1]!.timestamp > row.timestamp) throw new Error("QUOTE_GUARD_TIMELINE_UNORDERED");
  }
  return new AdaptiveQuoteGuard(rows, audit.provenance, policy.labels, true);
}
