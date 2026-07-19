import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { fixtures, markets, marketPrices, defaultRiskLimits } from "./sample-data.js";
import type { Order } from "../../../packages/contracts/src/index.js";
import { ProductRuntime } from "./product-runtime.js";
import {
  DualStrategyController,
  loadAdaptiveQuoteGuard,
  type SanitizedMarketEvent,
} from "../../../packages/live-agents/src/index.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const product = new ProductRuntime(process.env);
const rateLimit = new Map<string, { count: number; resetAt: number }>();
const backendRoot = path.resolve();
const currentFixtureSample = JSON.parse(readFileSync(
  path.join(backendRoot, "data", "samples", "txodds", "current", "argentina-spain.json"),
  "utf8",
)) as Record<string, unknown> & { marketSnapshots: SanitizedMarketEvent[] };
const historicalReplaySample = JSON.parse(readFileSync(
  path.join(backendRoot, "data", "samples", "txodds", "replay", "england-france-third-place.json"),
  "utf8",
)) as Record<string, unknown> & { marketEvents: SanitizedMarketEvent[] };
const adaptiveQuoteGuard = loadAdaptiveQuoteGuard(
  path.join(backendRoot, "data", "samples", "demo", "adaptive-quote-guard"),
);
const makerHawkController = new DualStrategyController(adaptiveQuoteGuard, { ...defaultRiskLimits });
for (const event of currentFixtureSample.marketSnapshots) makerHawkController.ingest(event, "LIVE");
void product.start();

function send(req: http.IncomingMessage, res: http.ServerResponse, statusCode: number, body: unknown) {
  const origin = req.headers.origin;
  const allowedOrigin = allowedCorsOrigin(origin);
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    vary: "Origin",
  };
  if (allowedOrigin) {
    headers["access-control-allow-origin"] = allowedOrigin;
    headers["access-control-allow-methods"] = "GET,POST,OPTIONS";
    headers["access-control-allow-headers"] = "content-type";
  }
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(body, null, 2));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 64_000) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  if (req.method === "OPTIONS") return send(req, res, 204, {});

  if (req.method === "GET" && path === "/health") {
    return send(req, res, 200, {
      ok: true,
      dataStatus: product.dataStatus(),
      dataMode: product.mode,
      theoMode: product.baselineConfig.theoMode,
      tradingMode: product.baselineConfig.tradingMode,
    });
  }
  if (req.method === "GET" && path === "/ready") {
    const baselineReady = product.baselineConfig.enabled && product.baselineConfig.valid;
    const ready = product.mode === "replay"
      ? baselineReady
      : product.mode === "txline" && product.dataStatus().status === "CONNECTED" && baselineReady;
    return send(req, res, ready ? 200 : 503, { ready, mode: product.mode, dataStatus: product.dataStatus(), reasonCodes: product.baselineConfig.reasonCodes });
  }
  if (req.method === "GET" && path === "/api/txodds/status") return send(req, res, 200, product.dataStatus());
  if (req.method === "GET" && path === "/api/fixtures/current") return send(req, res, 200, currentFixtureSample);
  if (req.method === "GET" && path === "/api/replays") {
    return send(req, res, 200, [{
      id: historicalReplaySample.id,
      provenance: historicalReplaySample.provenance,
      labels: historicalReplaySample.labels,
      fixture: historicalReplaySample.fixture,
      eventCount: historicalReplaySample.marketEvents.length,
      finalState: historicalReplaySample.finalState,
      deterministic: true,
    }]);
  }
  if (req.method === "GET" && path.startsWith("/api/replays/")) {
    const id = decodeURIComponent(path.slice("/api/replays/".length));
    return id === historicalReplaySample.id
      ? send(req, res, 200, historicalReplaySample)
      : send(req, res, 404, { error: "UNKNOWN_REPLAY", id });
  }
  if (req.method === "GET" && path === "/api/agent/status") return send(req, res, 200, makerHawkController.status());
  if (req.method === "GET" && path === "/api/agent/maker") return send(req, res, 200, makerHawkController.maker.status());
  if (req.method === "GET" && path === "/api/agent/hawk") return send(req, res, 200, makerHawkController.hawk.status());
  if (req.method === "GET" && path === "/api/decision-book") {
    return send(req, res, 200, {
      ...makerHawkController.shared.decisionBook.status(),
      decisions: makerHawkController.shared.decisionBook.all(),
    });
  }
  if (req.method === "GET" && path.startsWith("/api/decision-book/")) {
    const decisionId = decodeURIComponent(path.slice("/api/decision-book/".length));
    const decision = makerHawkController.shared.decisionBook.get(decisionId);
    return decision
      ? send(req, res, 200, decision)
      : send(req, res, 404, { error: "UNKNOWN_DECISION", decisionId });
  }
  if (req.method === "GET" && path === "/api/theo/status") return send(req, res, 200, product.theoStatus());
  if (req.method === "GET" && path === "/api/trading/status") {
    return send(req, res, 200, {
      ...product.tradingStatus(),
      hawk: makerHawkController.hawk.status().state,
      sharedRisk: makerHawkController.shared.status(),
      agentAutonomous: true,
      executionMode: "SHADOW",
      shadowExecution: "ENABLED",
      decisionBookEnabled: true,
      realExecutionEnabled: false,
    });
  }

  if (req.method === "GET" && path === "/api/demo/status") {
    const state = product.state();
    return send(req, res, 200, { status: state.replayStatus, backendStatus: state.backendStatus, mode: product.mode });
  }
  if (req.method === "GET" && path === "/api/demo/state") {
    if (product.mode === "replay") product.demo.tick();
    return send(req, res, 200, product.state());
  }
  if (req.method === "GET" && path === "/api/demo/replays") return send(req, res, 200, product.replays());
  if (req.method === "GET" && path === "/api/demo/audit") return send(req, res, 200, product.state().audit);
  if (req.method === "GET" && path === "/api/demo/performance") return send(req, res, 200, product.state().performance);
  if (req.method === "POST" && path.startsWith("/api/demo/")) {
    if (product.mode !== "replay") return send(req, res, 409, { error: "REPLAY_CONTROLS_DISABLED_IN_TXLINE_MODE" });
    if (checkRateLimit(req)) return send(req, res, 429, { error: "RATE_LIMITED" });
    if (path === "/api/demo/start") product.demo.start();
    else if (path === "/api/demo/pause") product.demo.pause();
    else if (path === "/api/demo/resume") product.demo.resume();
    else if (path === "/api/demo/reset") product.demo.reset();
    else if (path === "/api/demo/step") product.demo.step();
    else if (path === "/api/demo/inject-shock") product.demo.injectShock();
    else if (path === "/api/demo/replay") {
      const body = await readJson(req) as { replayId?: string };
      try {
        return send(req, res, 200, product.selectReplay(body.replayId ?? ""));
      } catch (error) {
        const message = error instanceof Error ? error.message : "UNKNOWN_REPLAY";
        return send(req, res, message === "RECORDED_REPLAY_UNAVAILABLE" ? 409 : 400, { error: message });
      }
    }
    else if (path === "/api/demo/speed") {
      const body = await readJson(req) as { speed?: number };
      product.demo.setSpeed(Number(body.speed));
    } else return send(req, res, 404, { error: "NOT_FOUND" });
    return send(req, res, 200, product.state());
  }

  if (req.method === "GET" && path === "/api/quotes") {
    if (product.mode === "txline") return send(req, res, 200, product.live?.activeQuotes() ?? []);
    return send(req, res, 200, product.state().marketRows.map((row) => ({
      marketId: row.marketId,
      selectionId: row.selectionId,
      bid: row.bid,
      ask: row.ask,
      width: row.width,
      inventoryLean: row.inventoryLean,
      directionalLean: 0,
      bidSize: row.bidSize,
      askSize: row.askSize,
      status: row.status,
      reasonCodes: row.reasonCodes,
      quoteMode: "MARKET_BASELINE_MAKER_ONLY",
    })));
  }
  if (req.method === "GET" && path === "/api/positions") return send(req, res, 200, product.state().positions);
  if (req.method === "GET" && path === "/api/risk") return send(req, res, 200, product.state().risk);
  if (req.method === "GET" && path === "/api/performance") return send(req, res, 200, product.state().performance);
  if (req.method === "GET" && path === "/api/audit") return send(req, res, 200, product.mode === "txline" ? product.live?.audit ?? [] : product.state().audit);
  if (req.method === "GET" && path === "/api/fills") return send(req, res, 200, product.mode === "txline" ? product.live?.fills ?? [] : product.state().makerFills ?? []);

  if (req.method === "GET" && path === "/api/config") {
    return send(req, res, 200, {
      mode: product.mode,
      network: product.mode === "txline" ? "devnet" : "local-replay",
      txodds: product.dataStatus(),
      theo: product.theoStatus(),
      trading: product.tradingStatus(),
      riskLimits: product.live?.riskLimits ?? defaultRiskLimits,
    });
  }
  if (req.method === "GET" && path === "/api/fixtures") return send(req, res, 200, fixtures);
  if (req.method === "GET" && path === "/api/markets") return send(req, res, 200, markets);
  if (req.method === "GET" && path.startsWith("/api/markets/")) {
    const market = markets.find((item) => item.marketId === decodeURIComponent(path.split("/").at(-1) ?? ""));
    return market ? send(req, res, 200, market) : send(req, res, 404, { error: "UNKNOWN_MARKET" });
  }

  if (req.method === "POST" && path === "/api/orders/paper") {
    return send(req, res, 409, {
      error: "MANUAL_ORDER_ENTRY_DISABLED",
      reasonCodes: ["AUTONOMOUS_MAKER_ONLY", "DIRECTIONAL_TRADING_DISABLED", "NO_REAL_EXECUTION"],
    });
  }
  if (req.method === "POST" && path === "/api/kill-switch/enable") {
    if (product.live) product.live.setRiskLimits({ ...product.live.riskLimits, killSwitch: true });
    return send(req, res, 200, { killSwitch: true });
  }
  if (req.method === "POST" && path === "/api/kill-switch/disable") {
    if (product.live) product.live.setRiskLimits({ ...product.live.riskLimits, killSwitch: false });
    return send(req, res, 200, { killSwitch: product.live?.riskLimits.killSwitch ?? false });
  }

  return send(req, res, 404, { error: "NOT_FOUND" });
}

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      send(req, res, message === "REQUEST_TOO_LARGE" ? 413 : 500, {
        error: "INTERNAL_ERROR",
        message: process.env.NODE_ENV === "production" ? "Request failed" : message,
      });
    });
  });
  server.listen(port, host, () => console.log(`World Cup paper market maker listening on http://${host}:${port}`));
  process.on("SIGTERM", () => {
    product.stop();
    server.close(() => process.exit(0));
  });
}

export {
  route,
  product,
  makerHawkController,
  currentFixtureSample,
  historicalReplaySample,
  adaptiveQuoteGuard,
};

function allowedCorsOrigin(origin: string | undefined) {
  const allowed = new Set((process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean));
  return origin && allowed.has(origin) ? origin : undefined;
}

function checkRateLimit(req: http.IncomingMessage) {
  const key = req.socket.remoteAddress ?? "local";
  const now = Date.now();
  const bucket = rateLimit.get(key);
  if (!bucket || bucket.resetAt < now) {
    rateLimit.set(key, { count: 1, resetAt: now + 10_000 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > 80;
}
