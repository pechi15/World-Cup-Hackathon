import { z } from "zod";

export const HistoricalDataQualitySchema = z.object({
  grade: z.enum(["VERIFIED", "ACCEPTABLE", "REJECTED"]),
  missingFields: z.array(z.string()).default([]),
  issues: z.array(z.string()).default([]),
}).strict();
export type HistoricalDataQuality = z.infer<typeof HistoricalDataQualitySchema>;

export const HistoricalFixtureProvenanceSchema = z.object({
  source: z.literal("HISTORICAL_DIXON_COLES"),
  externalId: z.string().optional(),
  collectedAt: z.string().datetime().optional(),
  notes: z.string().optional(),
}).strict();
export type HistoricalFixtureProvenance = z.infer<typeof HistoricalFixtureProvenanceSchema>;

export const SettledHistoricalFixtureSchema = z.object({
  fixtureId: z.string().min(1),
  competitionId: z.string().min(1),
  homeTeamId: z.string().min(1),
  awayTeamId: z.string().min(1),
  kickoffTime: z.string().datetime(),
  homeGoals: z.number().int().nonnegative(),
  awayGoals: z.number().int().nonnegative(),
  neutralVenue: z.boolean(),
  availableAt: z.string().datetime(),
  status: z.literal("SETTLED"),
  provenance: HistoricalFixtureProvenanceSchema,
  dataQuality: HistoricalDataQualitySchema,
}).strict().superRefine((fixture, context) => {
  if (fixture.homeTeamId === fixture.awayTeamId) {
    context.addIssue({ code: "custom", message: "HOME_AND_AWAY_TEAM_MUST_DIFFER" });
  }
  if (fixture.dataQuality.grade === "REJECTED") {
    context.addIssue({ code: "custom", message: "REJECTED_DATA_QUALITY" });
  }
  if (fixture.dataQuality.missingFields.length > 0) {
    context.addIssue({ code: "custom", message: "DECLARED_MISSING_FIELDS" });
  }
  if (Date.parse(fixture.availableAt) < Date.parse(fixture.kickoffTime)) {
    context.addIssue({ code: "custom", message: "RESULT_AVAILABLE_BEFORE_KICKOFF" });
  }
});
export type SettledHistoricalFixture = z.infer<typeof SettledHistoricalFixtureSchema>;

export type HistoricalDataSufficiencyRequirements = {
  minimumSettledFixtures: number;
  minimumTeams: number;
  minimumFixturesPerTeam: number;
  minimumCoverageDays: number;
  minimumCompetitions: number;
  maximumMissingValueRate: number;
  maximumDuplicateRate: number;
};

export const defaultHistoricalDataRequirements: HistoricalDataSufficiencyRequirements = {
  minimumSettledFixtures: 100,
  minimumTeams: 8,
  minimumFixturesPerTeam: 5,
  minimumCoverageDays: 180,
  minimumCompetitions: 1,
  maximumMissingValueRate: 0,
  maximumDuplicateRate: 0,
};

export type HistoricalDataAudit = {
  settledFixtureCount: number;
  numberOfTeams: number;
  dateCoverage: { earliest: string | null; latest: string | null; days: number };
  fixturesPerTeam: Record<string, number>;
  competitionsRepresented: string[];
  missingValueRate: number;
  duplicateRate: number;
  rejectedRowCount: number;
  fixtureGraphConnected: boolean;
  trainingCutoff: string;
};

export type HistoricalDataSufficiency = {
  status: "SUFFICIENT_REAL_DATA" | "INSUFFICIENT_REAL_DATA";
  audit: HistoricalDataAudit;
  requirements: HistoricalDataSufficiencyRequirements;
  reasonCodes: string[];
};

export class HistoricalDataError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "HistoricalDataError";
  }
}

const requiredFields = [
  "fixtureId",
  "competitionId",
  "homeTeamId",
  "awayTeamId",
  "kickoffTime",
  "homeGoals",
  "awayGoals",
  "neutralVenue",
  "availableAt",
  "status",
  "provenance",
  "dataQuality",
] as const;

function rawMissingValueRate(rows: unknown[]): number {
  if (rows.length === 0) return 0;
  let missing = 0;
  for (const row of rows) {
    const record = row && typeof row === "object" ? row as Record<string, unknown> : {};
    for (const field of requiredFields) {
      if (record[field] === undefined || record[field] === null || record[field] === "") missing += 1;
    }
  }
  return missing / (rows.length * requiredFields.length);
}

function rawDuplicateRate(rows: unknown[]): number {
  if (rows.length === 0) return 0;
  const seenIds = new Set<string>();
  const seenEvents = new Set<string>();
  let duplicates = 0;
  for (const row of rows) {
    const record = row && typeof row === "object" ? row as Record<string, unknown> : {};
    const fixtureId = record.fixtureId;
    if (typeof fixtureId !== "string") continue;
    const canonical = [record.competitionId, record.kickoffTime, record.homeTeamId, record.awayTeamId].join("|");
    if (seenIds.has(fixtureId) || seenEvents.has(canonical)) duplicates += 1;
    seenIds.add(fixtureId);
    seenEvents.add(canonical);
  }
  return duplicates / rows.length;
}

export function validateHistoricalFixtures(
  rows: unknown[],
  trainingCutoff: string,
): SettledHistoricalFixture[] {
  const cutoffMs = Date.parse(trainingCutoff);
  if (!Number.isFinite(cutoffMs)) throw new HistoricalDataError("INVALID_TRAINING_CUTOFF");
  const fixtures: SettledHistoricalFixture[] = [];
  const seen = new Set<string>();
  const seenCanonicalFixtures = new Set<string>();
  for (const row of rows) {
    const record = row && typeof row === "object" ? row as Record<string, unknown> : {};
    if (record.status !== "SETTLED") {
      throw new HistoricalDataError("UNSETTLED_FIXTURE_REJECTED");
    }
    if (record.homeGoals === undefined || record.homeGoals === null || record.awayGoals === undefined || record.awayGoals === null) {
      throw new HistoricalDataError("MISSING_SCORE_REJECTED");
    }
    const parsed = SettledHistoricalFixtureSchema.safeParse(row);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((issue) => issue.message);
      const code = "INVALID_HISTORICAL_FIXTURE";
      throw new HistoricalDataError(code, `${code}: ${messages.join("; ")}`);
    }
    const fixture = parsed.data;
    if (seen.has(fixture.fixtureId)) {
      throw new HistoricalDataError("DUPLICATE_FIXTURE_REJECTED");
    }
    seen.add(fixture.fixtureId);
    const canonicalKey = [
      fixture.competitionId,
      fixture.kickoffTime,
      fixture.homeTeamId,
      fixture.awayTeamId,
    ].join("|");
    if (seenCanonicalFixtures.has(canonicalKey)) {
      throw new HistoricalDataError("DUPLICATE_FIXTURE_EVENT_REJECTED");
    }
    seenCanonicalFixtures.add(canonicalKey);
    if (Date.parse(fixture.kickoffTime) > cutoffMs) {
      throw new HistoricalDataError("FIXTURE_AFTER_TRAINING_CUTOFF");
    }
    if (Date.parse(fixture.availableAt) > cutoffMs) {
      throw new HistoricalDataError("OBSERVATION_UNAVAILABLE_AT_TRAINING_CUTOFF");
    }
    fixtures.push(fixture);
  }
  return fixtures.sort((a, b) => {
    const kickoff = a.kickoffTime.localeCompare(b.kickoffTime);
    return kickoff !== 0 ? kickoff : a.fixtureId.localeCompare(b.fixtureId);
  });
}

export function auditHistoricalFixtures(
  rows: unknown[],
  fixtures: SettledHistoricalFixture[],
  trainingCutoff: string,
): HistoricalDataAudit {
  const fixturesPerTeam = new Map<string, number>();
  for (const fixture of fixtures) {
    fixturesPerTeam.set(fixture.homeTeamId, (fixturesPerTeam.get(fixture.homeTeamId) ?? 0) + 1);
    fixturesPerTeam.set(fixture.awayTeamId, (fixturesPerTeam.get(fixture.awayTeamId) ?? 0) + 1);
  }
  const kickoffTimes = fixtures.map((fixture) => Date.parse(fixture.kickoffTime));
  const earliestMs = kickoffTimes.length > 0 ? Math.min(...kickoffTimes) : null;
  const latestMs = kickoffTimes.length > 0 ? Math.max(...kickoffTimes) : null;
  return {
    settledFixtureCount: fixtures.length,
    numberOfTeams: fixturesPerTeam.size,
    dateCoverage: {
      earliest: earliestMs === null ? null : new Date(earliestMs).toISOString(),
      latest: latestMs === null ? null : new Date(latestMs).toISOString(),
      days: earliestMs === null || latestMs === null ? 0 : (latestMs - earliestMs) / 86_400_000,
    },
    fixturesPerTeam: Object.fromEntries([...fixturesPerTeam.entries()].sort(([a], [b]) => a.localeCompare(b))),
    competitionsRepresented: [...new Set(fixtures.map((fixture) => fixture.competitionId))].sort(),
    missingValueRate: rawMissingValueRate(rows),
    duplicateRate: rawDuplicateRate(rows),
    rejectedRowCount: Math.max(0, rows.length - fixtures.length),
    fixtureGraphConnected: isFixtureGraphConnected(fixtures),
    trainingCutoff,
  };
}

function isFixtureGraphConnected(fixtures: SettledHistoricalFixture[]): boolean {
  const teams = [...new Set(fixtures.flatMap((fixture) => [fixture.homeTeamId, fixture.awayTeamId]))];
  if (teams.length < 2) return false;
  const adjacency = new Map(teams.map((team) => [team, new Set<string>()]));
  for (const fixture of fixtures) {
    adjacency.get(fixture.homeTeamId)!.add(fixture.awayTeamId);
    adjacency.get(fixture.awayTeamId)!.add(fixture.homeTeamId);
  }
  const visited = new Set<string>();
  const queue = [teams[0]!];
  while (queue.length > 0) {
    const team = queue.shift()!;
    if (visited.has(team)) continue;
    visited.add(team);
    queue.push(...(adjacency.get(team) ?? []));
  }
  return visited.size === teams.length;
}

export function assessHistoricalDataSufficiency(
  rows: unknown[],
  trainingCutoff: string,
  requirements: Partial<HistoricalDataSufficiencyRequirements> = {},
): HistoricalDataSufficiency {
  const configured = { ...defaultHistoricalDataRequirements, ...requirements };
  if (
    !Number.isInteger(configured.minimumSettledFixtures)
    || configured.minimumSettledFixtures < 1
    || !Number.isInteger(configured.minimumTeams)
    || configured.minimumTeams < 2
    || !Number.isInteger(configured.minimumFixturesPerTeam)
    || configured.minimumFixturesPerTeam < 1
    || !Number.isFinite(configured.minimumCoverageDays)
    || configured.minimumCoverageDays < 0
    || !Number.isInteger(configured.minimumCompetitions)
    || configured.minimumCompetitions < 1
    || !Number.isFinite(configured.maximumMissingValueRate)
    || configured.maximumMissingValueRate < 0
    || configured.maximumMissingValueRate > 1
    || !Number.isFinite(configured.maximumDuplicateRate)
    || configured.maximumDuplicateRate < 0
    || configured.maximumDuplicateRate > 1
  ) {
    throw new HistoricalDataError("INVALID_DATA_SUFFICIENCY_REQUIREMENTS");
  }
  let fixtures: SettledHistoricalFixture[] = [];
  let validationFailure: string | null = null;
  try {
    fixtures = validateHistoricalFixtures(rows, trainingCutoff);
  } catch (error) {
    validationFailure = error instanceof HistoricalDataError ? error.code : "INVALID_HISTORICAL_FIXTURE";
    const cutoffMs = Date.parse(trainingCutoff);
    const seen = new Set<string>();
    const seenCanonical = new Set<string>();
    fixtures = rows.flatMap((row) => {
      const parsed = SettledHistoricalFixtureSchema.safeParse(row);
      const canonical = parsed.success
        ? [parsed.data.competitionId, parsed.data.kickoffTime, parsed.data.homeTeamId, parsed.data.awayTeamId].join("|")
        : "";
      if (
        !parsed.success
        || Date.parse(parsed.data.kickoffTime) > cutoffMs
        || Date.parse(parsed.data.availableAt) > cutoffMs
        || seen.has(parsed.data.fixtureId)
        || seenCanonical.has(canonical)
      ) {
        return [];
      }
      seen.add(parsed.data.fixtureId);
      seenCanonical.add(canonical);
      return [parsed.data];
    });
  }
  const audit = auditHistoricalFixtures(rows, fixtures, trainingCutoff);
  const fixtureCounts = Object.values(audit.fixturesPerTeam);
  const minimumTeamFixtures = fixtureCounts.length > 0 ? Math.min(...fixtureCounts) : 0;
  const reasonCodes: string[] = [];
  if (validationFailure) reasonCodes.push(validationFailure);
  if (audit.settledFixtureCount < configured.minimumSettledFixtures) reasonCodes.push("MINIMUM_SETTLED_FIXTURES_NOT_MET");
  if (audit.numberOfTeams < configured.minimumTeams) reasonCodes.push("MINIMUM_TEAMS_NOT_MET");
  if (minimumTeamFixtures < configured.minimumFixturesPerTeam) reasonCodes.push("MINIMUM_FIXTURES_PER_TEAM_NOT_MET");
  if (audit.dateCoverage.days < configured.minimumCoverageDays) reasonCodes.push("MINIMUM_DATE_COVERAGE_NOT_MET");
  if (audit.competitionsRepresented.length < configured.minimumCompetitions) reasonCodes.push("MINIMUM_COMPETITIONS_NOT_MET");
  if (audit.missingValueRate > configured.maximumMissingValueRate) reasonCodes.push("MAXIMUM_MISSING_VALUE_RATE_EXCEEDED");
  if (audit.duplicateRate > configured.maximumDuplicateRate) reasonCodes.push("MAXIMUM_DUPLICATE_RATE_EXCEEDED");
  if (!audit.fixtureGraphConnected) reasonCodes.push("DISCONNECTED_FIXTURE_GRAPH");
  return {
    status: reasonCodes.length === 0 ? "SUFFICIENT_REAL_DATA" : "INSUFFICIENT_REAL_DATA",
    audit,
    requirements: configured,
    reasonCodes,
  };
}
