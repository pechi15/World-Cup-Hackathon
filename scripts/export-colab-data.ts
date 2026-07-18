import { execFileSync } from "node:child_process";
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataRuntimeConfig, TxlineReadOnlyAdapter } from "../packages/market-data/src/index.js";
import { buildResearchTables, writeResearchBundle, type ResearchCapture } from "../packages/research-data/src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function captureFromEnvironment(): Promise<{ capture: ResearchCapture; sourceUri: string; sourceNetwork: string }> {
  const inputPath = process.env.COLAB_EXPORT_INPUT;
  if (inputPath) {
    const absolute = path.resolve(root, inputPath);
    const capture = JSON.parse(await readFile(absolute, "utf8")) as ResearchCapture;
    return { capture, sourceUri: path.relative(root, absolute).replaceAll("\\", "/"), sourceNetwork: capture.sourceNetwork ?? "sanitized-replay" };
  }

  const config = resolveDataRuntimeConfig(process.env);
  if (!config.valid) throw new Error(`Data export configuration invalid: ${config.reasonCodes.join(",")}`);
  if (config.mode === "replay") {
    const relative = process.env.REPLAY_FIXTURE_PATH ?? "data/samples/txodds/sanitized/replay-fixture.json";
    const absolute = path.resolve(root, relative);
    const capture = JSON.parse(await readFile(absolute, "utf8")) as ResearchCapture;
    capture.sourceNetwork = "sanitized-replay";
    return { capture, sourceUri: relative.replaceAll("\\", "/"), sourceNetwork: "sanitized-replay" };
  }

  const adapter = new TxlineReadOnlyAdapter(config);
  await adapter.connect();
  const fixtures = await adapter.fetchFixtureRows();
  const limit = Math.max(1, Math.min(Number(process.env.COLAB_FIXTURE_LIMIT ?? 25), 500));
  const selectedFixtures = fixtures.slice(0, limit);
  const oddsRecords: NonNullable<ResearchCapture["oddsRecords"]> = [];
  const scoreEvents: NonNullable<ResearchCapture["scoreEvents"]> = [];
  for (const fixture of selectedFixtures) {
    const updates = await adapter.fetchOddsUpdatesForFixture(String(fixture.FixtureId));
    const receiveTime = new Date().toISOString();
    oddsRecords.push(...updates.map((update) => ({ update, receiveTime })));
    const scores = await adapter.fetchScoreEventsForFixture(String(fixture.FixtureId));
    scoreEvents.push(...scores.map((score) => ({ ...score, receiveTime: new Date().toISOString() })));
  }
  return {
    capture: { fixtures: selectedFixtures, oddsRecords, scoreEvents, sourceNetwork: "txline-devnet" },
    sourceUri: "txline-devnet-readonly-snapshot",
    sourceNetwork: "txline-devnet",
  };
}

async function main(): Promise<void> {
  const { capture, sourceUri, sourceNetwork } = await captureFromEnvironment();
  const tables = buildResearchTables(capture);
  const exportGitCommit = process.env.EXPORT_GIT_COMMIT ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const exportTimestamp = process.env.EXPORT_TIMESTAMP ?? new Date().toISOString();
  const outputRoot = path.resolve(root, process.env.COLAB_EXPORT_OUTPUT_ROOT ?? ".local/colab-export");
  const result = await writeResearchBundle(tables, { outputRoot, exportGitCommit, exportTimestamp, sourceNetwork, sourceUri });
  await copyFile(path.join(root, "scripts/colab/jsonl_to_parquet.py"), path.join(result.outputDirectory, "jsonl_to_parquet.py"));
  process.stdout.write(`${JSON.stringify({ datasetId: result.datasetId, datasetHash: result.datasetHash, outputDirectory: result.outputDirectory })}\n`);
}

main().catch((error) => {
  process.stderr.write(`Colab export failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
