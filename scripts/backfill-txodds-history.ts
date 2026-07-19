import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOLANA_DEVNET_RPC,
  TXLINE_DEVNET_ORIGIN,
  resolveDataRuntimeConfig,
} from "../packages/market-data/src/config.js";
import {
  captureTxlineHistory,
  createSanitizedHistoricalReplay,
  writeHistoricalExport,
} from "../packages/market-data/src/historical.js";
import { TxlineReadOnlyAdapter } from "../packages/market-data/src/txline-readonly.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, "..");

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`INVALID_${name}`);
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`INVALID_${name}`);
  return value;
}

function intervals(): number[] {
  const values = (process.env.TXLINE_HISTORY_INTERVALS ?? "0").split(",").map((value) => Number(value.trim()));
  if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value < 0)) throw new Error("INVALID_TXLINE_HISTORY_INTERVALS");
  return [...new Set(values)];
}

async function main(): Promise<void> {
  const config = resolveDataRuntimeConfig({
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
  if (!config.valid || config.mode !== "txline") {
    const reasons = "reasonCodes" in config ? config.reasonCodes.join(",") : "INVALID_CONFIGURATION";
    throw new Error(`TXLINE_READ_ONLY_CONFIGURATION_REQUIRED:${reasons}`);
  }

  const currentEpochDay = Math.floor(Date.now() / 86_400_000);
  const endEpochDay = integer("TXLINE_HISTORY_END_EPOCH_DAY", currentEpochDay);
  const lookbackDays = positiveInteger("TXLINE_HISTORY_LOOKBACK_DAYS", 90);
  const startEpochDay = integer("TXLINE_HISTORY_START_EPOCH_DAY", endEpochDay - lookbackDays + 1);
  const adapter = new TxlineReadOnlyAdapter(config);
  const capture = await captureTxlineHistory(adapter, {
    startEpochDay,
    endEpochDay,
    intervals: intervals(),
    emptyDayStop: positiveInteger("TXLINE_HISTORY_EMPTY_DAY_STOP", 14),
  });
  const exported = await writeHistoricalExport(capture, path.join(root, ".local", "txodds-history"));
  const sample = createSanitizedHistoricalReplay(capture, positiveInteger("TXLINE_REPLAY_SAMPLE_MAX_ODDS", 50));
  const sampleDirectory = path.join(root, "data", "samples", "txodds", "replay");
  const samplePath = path.join(sampleDirectory, "recorded-historical-replay.json");
  const auditPath = path.join(root, "docs", "txodds-historical-audit.md");
  await mkdir(sampleDirectory, { recursive: true });
  await Promise.all([
    writeFile(samplePath, `${JSON.stringify(sample, null, 2)}\n`, "utf8"),
    writeFile(auditPath, exported.auditMarkdown, "utf8"),
  ]);

  // Deliberately emit aggregate metadata only. Credentials, headers, and raw
  // payloads stay out of stdout and the tracked audit.
  process.stdout.write(`${JSON.stringify({
    datasetId: exported.datasetId,
    outputDirectory: path.relative(root, exported.outputDirectory),
    fixtureCount: exported.audit.fixtureCount,
    completedFixtureCount: exported.audit.completedFixtureCount,
    oddsUpdateCount: exported.audit.oddsUpdateCount,
    scoreUpdateCount: exported.audit.scoreUpdateCount,
    finalStateRecordCount: exported.audit.finalStateRecordCount,
    earliestSourceTimestamp: exported.audit.earliestSourceTimestamp,
    latestSourceTimestamp: exported.audit.latestSourceTimestamp,
    samplePath: path.relative(root, samplePath),
    auditPath: path.relative(root, auditPath),
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "TXLINE_HISTORY_BACKFILL_FAILED";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
