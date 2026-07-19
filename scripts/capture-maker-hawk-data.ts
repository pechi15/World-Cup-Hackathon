import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOLANA_DEVNET_RPC,
  TXLINE_DEVNET_ORIGIN,
  resolveDataRuntimeConfig,
  TxlineReadOnlyAdapter,
  type TxlineOddsUpdate,
  type TxlineScoreEvent,
} from "../packages/market-data/src/index.js";
import {
  buildCurrentFixtureSample,
  buildHistoricalReplay,
  containsCredentialMaterial,
  findFixtureByTeams,
  findScoreFixtureByTeams,
  type ScoreFixtureMatch,
} from "../packages/live-agents/src/fixture-discovery.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const currentOutput = path.join(root, "data", "samples", "txodds", "current", "argentina-spain.json");
const replayOutput = path.join(root, "data", "samples", "txodds", "replay", "england-france-third-place.json");

function readOnlyConfig() {
  return resolveDataRuntimeConfig({
    DATA_MODE: "txline",
    DEMO_MODE: "false",
    TXLINE_NETWORK: "devnet",
    TXLINE_API_ORIGIN: process.env.TXLINE_API_ORIGIN ?? TXLINE_DEVNET_ORIGIN,
    TXLINE_API_TOKEN: process.env.TXLINE_API_TOKEN,
    SOLANA_RPC_URL: SOLANA_DEVNET_RPC,
    ENABLE_REAL_EXECUTION: "false",
    ENABLE_WALLET_OPERATIONS: "false",
    ENABLE_TXODDS_ACTIVATION: "false",
  });
}

async function captureCurrent(adapter: TxlineReadOnlyAdapter): Promise<Record<string, unknown>> {
  const fixtures = await adapter.fetchFixtureRows();
  const match = findFixtureByTeams(fixtures, "Argentina", "Spain");
  if (!match) throw new Error("ARGENTINA_SPAIN_FIXTURE_NOT_FOUND");
  const firstSnapshot = await adapter.fetchOddsUpdatesForFixture(match.fixtureId);
  const streamUpdates: TxlineOddsUpdate[] = [];
  let streamAvailable = false;
  const abort = new AbortController();
  const durationMs = Number(process.env.TXLINE_SSE_CAPTURE_MS ?? 5_000);
  const timer = setTimeout(() => abort.abort(), durationMs);
  try {
    await adapter.streamOddsEvents(
      (update) => {
        if (String(update.FixtureId) === match.fixtureId) streamUpdates.push(update);
      },
      abort.signal,
      (event) => {
        if (event.event === "SSE_OPEN") streamAvailable = true;
      },
    );
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
  }
  const quiet = streamUpdates.length === 0;
  const fallback = quiet ? await adapter.fetchOddsUpdatesForFixture(match.fixtureId) : [];
  return buildCurrentFixtureSample({
    match,
    snapshotUpdates: [...firstSnapshot, ...fallback],
    streamUpdates,
    capturedAt: new Date().toISOString(),
    stream: { attempted: true, available: streamAvailable, quiet, fallbackPollPerformed: quiet },
  });
}

async function discoverCompletedFixture(
  adapter: TxlineReadOnlyAdapter,
  lookbackDays: number,
): Promise<{ match: ScoreFixtureMatch; epochDay: number; scoreEvents: TxlineScoreEvent[] }> {
  const today = Math.floor(Date.now() / 86_400_000);
  for (let offset = 0; offset <= lookbackDays; offset += 1) {
    const epochDay = today - offset;
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, (_, hour) => adapter.fetchScoreUpdates(epochDay, hour, 0)),
    );
    const scoreEvents = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const fixtureIds = [...new Set(scoreEvents.map((row) => String((row as Record<string, unknown>).FixtureId ?? "")).filter(Boolean))];
    const snapshotResults = await Promise.allSettled(
      fixtureIds.map((fixtureId) => adapter.fetchScoreEventsForFixture(fixtureId)),
    );
    const snapshots = snapshotResults.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const match = findScoreFixtureByTeams([...scoreEvents, ...snapshots], "England", "France");
    if (match) return { match, epochDay, scoreEvents: [...scoreEvents, ...snapshots] };
  }
  throw new Error("ENGLAND_FRANCE_COMPLETED_FIXTURE_NOT_FOUND");
}

async function captureReplay(adapter: TxlineReadOnlyAdapter): Promise<Record<string, unknown>> {
  const discovered = await discoverCompletedFixture(adapter, Number(process.env.TXLINE_HISTORY_LOOKBACK_DAYS ?? 7));
  const oddsResults = await Promise.allSettled(
    Array.from({ length: 24 }, (_, hour) => adapter.fetchOddsUpdates(discovered.epochDay, hour, 0)),
  );
  const oddsUpdates = oddsResults.flatMap((result) => result.status === "fulfilled" ? result.value : [])
    .filter((update) => String(update.FixtureId) === discovered.match.fixtureId);
  const scoreResults = await Promise.allSettled([
    adapter.fetchScoreEventsForFixture(discovered.match.fixtureId),
    adapter.fetchScoreUpdatesForFixture(discovered.match.fixtureId),
    adapter.fetchHistoricalScoresForFixture(discovered.match.fixtureId),
  ]);
  const scoreEvents = [
    ...discovered.scoreEvents,
    ...scoreResults.flatMap((result) => result.status === "fulfilled" ? result.value : []),
  ].filter((row) => String((row as Record<string, unknown>).FixtureId) === discovered.match.fixtureId);
  if (oddsUpdates.length === 0) throw new Error("ENGLAND_FRANCE_HISTORICAL_ODDS_NOT_FOUND");
  return buildHistoricalReplay({
    match: discovered.match,
    oddsUpdates,
    scoreEvents,
    discoveredEpochDay: discovered.epochDay,
  });
}

async function main(): Promise<void> {
  const config = readOnlyConfig();
  if (!config.valid || config.mode !== "txline") throw new Error("READ_ONLY_DEVNET_CONFIGURATION_REQUIRED");
  const adapter = new TxlineReadOnlyAdapter(config);
  await adapter.connect(); // Always obtains a fresh ephemeral guest JWT.
  const [current, replay] = await Promise.all([captureCurrent(adapter), captureReplay(adapter)]);
  if (containsCredentialMaterial(current) || containsCredentialMaterial(replay)) {
    throw new Error("SANITIZED_OUTPUT_CONTAINS_CREDENTIAL_MATERIAL");
  }
  await Promise.all([
    mkdir(path.dirname(currentOutput), { recursive: true }),
    mkdir(path.dirname(replayOutput), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(currentOutput, `${JSON.stringify(current, null, 2)}\n`, "utf8"),
    writeFile(replayOutput, `${JSON.stringify(replay, null, 2)}\n`, "utf8"),
  ]);
  const currentRecord = current as { marketSnapshots?: unknown[]; stream?: Record<string, unknown> };
  const replayRecord = replay as { marketEvents?: unknown[]; scoreEvents?: unknown[]; finalState?: unknown; contentHash?: string };
  process.stdout.write(`${JSON.stringify({
    status: "COMPLETE",
    network: "devnet",
    currentFixtureFound: true,
    currentMarketSnapshots: currentRecord.marketSnapshots?.length ?? 0,
    stream: currentRecord.stream ?? null,
    historicalFixtureFound: true,
    historicalOddsEvents: replayRecord.marketEvents?.length ?? 0,
    historicalScoreEvents: replayRecord.scoreEvents?.length ?? 0,
    finalStateRetrieved: replayRecord.finalState !== null,
    replayContentHash: replayRecord.contentHash ?? null,
    credentialsIncluded: false,
    currentOutput: path.relative(root, currentOutput),
    replayOutput: path.relative(root, replayOutput),
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "MAKER_HAWK_CAPTURE_FAILED"}\n`);
  process.exitCode = 1;
});
