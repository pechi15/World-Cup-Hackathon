import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRiskLimits } from "../apps/api/src/sample-data.js";
import {
  mapOddsUpdateToMarket,
  resolveDataRuntimeConfig,
  toNormalizedMarketObservation,
  TxlineReadOnlyAdapter,
} from "../packages/market-data/src/index.js";
import {
  assertMarketBaselineStartupSafe,
  LiveMarketBaselineRuntime,
  resolveMarketBaselineRuntimeConfig,
} from "../packages/live-market-baseline/src/index.js";
import { SanitizedLiveRecorder } from "../packages/live-market-baseline/src/recorder.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const durationMs = Number(process.env.LIVE_RECORDING_DURATION_MS ?? 300_000);
const pollIntervalMs = Number(process.env.LIVE_RECORDING_POLL_MS ?? 15_000);
if (!Number.isFinite(durationMs) || durationMs < 1_000) throw new Error("LIVE_RECORDING_DURATION_MS must be at least 1000");
if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1_000) throw new Error("LIVE_RECORDING_POLL_MS must be at least 1000");

const dataConfig = resolveDataRuntimeConfig(process.env);
if (!dataConfig.valid || dataConfig.mode !== "txline") throw new Error("LIVE_RECORDING_REQUIRES_VALID_TXLINE_CONFIG");
const runtimeConfig = resolveMarketBaselineRuntimeConfig(process.env);
assertMarketBaselineStartupSafe(runtimeConfig);
if (!runtimeConfig.valid || !runtimeConfig.enabled) throw new Error(`LIVE_RECORDING_REQUIRES_MARKET_BASELINE:${runtimeConfig.reasonCodes.join(",")}`);

const adapter = new TxlineReadOnlyAdapter(dataConfig);
const runtime = new LiveMarketBaselineRuntime(runtimeConfig, defaultRiskLimits);
const recorder = new SanitizedLiveRecorder();
const startedAt = new Date().toISOString();
const stopAt = Date.now() + durationMs;
const abort = new AbortController();
let seenCancellationCount = 0;
let seenFillCount = 0;

function recordRuntimeState(recordedAt: string): void {
  for (const quote of runtime.activeQuotes()) recorder.record("PAPER_QUOTE", quote, recordedAt);
  for (const cancellation of runtime.cancellations.slice(seenCancellationCount)) recorder.record("QUOTE_CANCELLATION", cancellation, recordedAt);
  seenCancellationCount = runtime.cancellations.length;
  for (const fill of runtime.fills.slice(seenFillCount)) recorder.record("PAPER_FILL", fill, recordedAt);
  seenFillCount = runtime.fills.length;
  for (const position of runtime.portfolio.positions) recorder.record("POSITION", position, recordedAt);
  recorder.record("PNL", {
    realizedPnl: runtime.portfolio.cash.realizedPnl,
    feesPaid: runtime.portfolio.cash.feesPaid,
    unrealizedPnl: runtime.portfolio.positions.reduce((sum, position) => sum + (position.unrealizedPnl ?? 0), 0),
  }, recordedAt);
  recorder.record("RISK", {
    killSwitch: defaultRiskLimits.killSwitch,
    quoteSuspension: defaultRiskLimits.quoteSuspension,
    maxExposurePerFixture: defaultRiskLimits.maxExposurePerFixture,
    maxExposurePerMarket: defaultRiskLimits.maxExposurePerMarket,
    maxWorstCaseLoss: defaultRiskLimits.maxWorstCaseLoss,
  }, recordedAt);
}

async function processUpdate(update: Parameters<typeof mapOddsUpdateToMarket>[0], receiveTime: string, kind: "ODDS_SNAPSHOT" | "ODDS_SSE"): Promise<void> {
  const event = adapter.store.appendRaw({ receivedAt: receiveTime, transport: kind === "ODDS_SSE" ? "sse" : "http", body: update, dataMode: "TXODDS" });
  recorder.record(kind, { update, receiveTime }, receiveTime);
  if (!event) return;
  const market = mapOddsUpdateToMarket(update, "TXODDS");
  const observation = toNormalizedMarketObservation(event);
  recorder.record("NORMALIZED_MARKET", { market, observation }, receiveTime);
  runtime.setConnectionStatus(adapter.status, receiveTime);
  const audit = await runtime.onObservation(market, observation);
  recorder.record("AUDIT", audit, receiveTime);
  recordRuntimeState(receiveTime);
}

async function pollSnapshot(): Promise<void> {
  const capture = await adapter.captureLiveSnapshot();
  runtime.setConnectionStatus(adapter.status, capture.capturedAt);
  recorder.record("CONNECTION", adapter.getSystemDataStatus(), capture.capturedAt);
  for (const fixture of capture.fixtures) recorder.record("FIXTURE", fixture, capture.capturedAt);
  for (const event of capture.oddsEvents) {
    recorder.record("ODDS_SNAPSHOT", { update: event.update, receiveTime: event.receiveTime }, event.receiveTime);
    const market = mapOddsUpdateToMarket(event.update, "TXODDS");
    const observation = toNormalizedMarketObservation(event);
    recorder.record("NORMALIZED_MARKET", { market, observation }, event.receiveTime);
    const audit = await runtime.onObservation(market, observation);
    recorder.record("AUDIT", audit, event.receiveTime);
    recordRuntimeState(event.receiveTime);
  }
  for (const score of capture.scoreEvents) recorder.record("SCORE", score, capture.capturedAt);
}

async function main(): Promise<void> {
  await adapter.connect();
  runtime.setConnectionStatus(adapter.status, new Date().toISOString());
  recorder.record("CONNECTION", adapter.getSystemDataStatus());

  const sse = adapter.streamOddsEvents(
    (update, receiveTime) => processUpdate(update, receiveTime, "ODDS_SSE"),
    abort.signal,
    (event, receiveTime) => recorder.record("CONNECTION", event, receiveTime),
  )
    .catch((error: unknown) => {
      if (!abort.signal.aborted) recorder.record("CONNECTION", { status: adapter.status, error: error instanceof Error ? error.message : "SSE_ERROR" });
    });

  while (Date.now() < stopAt) {
    try {
      await pollSnapshot();
    } catch (error) {
      runtime.setConnectionStatus(adapter.status, new Date().toISOString());
      recorder.record("CONNECTION", { status: adapter.status, error: error instanceof Error ? error.message : "SNAPSHOT_ERROR" });
    }
    const waitMs = Math.min(pollIntervalMs, Math.max(0, stopAt - Date.now()));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  abort.abort();
  await sse;
  const endedAt = new Date().toISOString();
  runtime.expireQuotes(endedAt);
  recordRuntimeState(endedAt);
  const paths = await recorder.write(path.join(root, ".local", "live-market-baseline"), startedAt, endedAt);
  process.stdout.write(`${JSON.stringify({
    status: "COMPLETE",
    startedAt,
    endedAt,
    durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    dataStatus: adapter.status,
    probabilityFields: [...new Set(runtime.audit.map((event) => event.probabilityField))],
    quotes: runtime.audit.reduce((sum, event) => sum + event.quoteIds.length, 0),
    fills: runtime.fills.length,
    credentialsIncluded: false,
    ...paths,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
