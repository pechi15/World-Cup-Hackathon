import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { markets as sampleMarkets, fixtures as sampleFixtures, marketPrices, defaultRiskLimits } from "./sample-data.js";
import { awaitingTxoddsDisplay, type Fill, type Order } from "../../../packages/contracts/src/index.js";
import { DisabledTxoddsAdapter, ReplayTxoddsAdapter, mapOddsUpdateToMarket } from "../../../packages/market-data/src/index.js";
import { NullTheoProvider, PipelineTheoProvider, resolveResearchTheoMode } from "../../../packages/theo/src/index.js";
import { defaultQuoteConfig, generateQuote } from "../../../packages/quoting/src/index.js";
import { createEmptyPortfolio, markPortfolio } from "../../../packages/portfolio/src/index.js";
import { defaultScoreScenarios } from "../../../packages/market-model/src/index.js";
import { buildRiskSnapshot, terminalOutcomeRisk } from "../../../packages/risk/src/index.js";
import { PaperExecutionEngine } from "../../../packages/execution/src/index.js";
import { buildPerformanceSnapshot } from "../../../packages/evaluation/src/index.js";
import { ReplayClock } from "../../../packages/replay/src/index.js";
import { AutonomousTradingLoop } from "../../../packages/agent/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8787);
const replayPath = process.env.REPLAY_FIXTURE_PATH
  ?? path.resolve(__dirname, "../../../data/samples/txodds/sanitized/replay-fixture.json");

const liveAdapter = new DisabledTxoddsAdapter({
  network: process.env.TXLINE_NETWORK,
  apiOrigin: process.env.TXLINE_API_ORIGIN,
  guestJwt: process.env.TXLINE_GUEST_JWT,
  apiToken: process.env.TXLINE_API_TOKEN,
  solanaRpcUrl: process.env.SOLANA_RPC_URL,
});

const replayAdapter = new ReplayTxoddsAdapter();
let replayLoaded = false;
try {
  const raw = JSON.parse(fs.readFileSync(replayPath, "utf8")) as {
    fixture: Parameters<ReplayTxoddsAdapter["loadFixtures"]>[0][number];
    updates: Parameters<ReplayTxoddsAdapter["loadOddsUpdates"]>[0];
  };
  replayAdapter.loadFixtures([raw.fixture]);
  replayAdapter.loadOddsUpdates(raw.updates);
  replayLoaded = true;
} catch {
  replayLoaded = false;
}

const requestedTheoMode = resolveResearchTheoMode(process.env.THEO_MODE);
const pipelineTheo = new PipelineTheoProvider(requestedTheoMode ?? "REPLAY");
const nullTheo = new NullTheoProvider();
const useReplayTheo = replayLoaded && requestedTheoMode !== null;
const theoProvider = useReplayTheo ? pipelineTheo : nullTheo;

const execution = new PaperExecutionEngine();
let pipelineSeeded = false;
let riskLimits = { ...defaultRiskLimits };
let portfolio = markPortfolio(createEmptyPortfolio(), marketPrices);
let orders: Order[] = [];
let fills: Fill[] = [];
const strategies = [
  { strategyId: "no-theo-no-action", enabled: false, status: "THEO_UNAVAILABLE" },
  { strategyId: "autonomous-maker", enabled: true, status: useReplayTheo ? "READY" : "THEO_UNAVAILABLE" },
  { strategyId: "autonomous-directional", enabled: true, status: useReplayTheo ? "READY" : "THEO_UNAVAILABLE" },
];

const loop = new AutonomousTradingLoop({
  riskLimits,
  bankroll: 100_000,
  kellyFraction: 0.1,
  makerFillProbability: 0.35,
  innovationSuspendThreshold: 2.5,
});

let clock = new ReplayClock(replayAdapter.store.events());
let lastAudit = loop.state.audit.at(-1) ?? null;

function send(res: http.ServerResponse, statusCode: number, body: unknown) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function activeMarkets() {
  if (useReplayTheo) {
    const discovered = await replayAdapter.discoverMarkets();
    if (discovered.length) return discovered;
  }
  return sampleMarkets;
}

async function activeFixtures() {
  if (useReplayTheo) {
    const discovered = await replayAdapter.discoverFixtures();
    if (discovered.length) return discovered;
  }
  return sampleFixtures;
}

async function ensureTheoSeeded() {
  if (!useReplayTheo || pipelineSeeded) return;
  for (const event of replayAdapter.store.events()) {
    pipelineTheo.ingestEvent(event);
    const market = mapOddsUpdateToMarket(event.update, event.source);
    await pipelineTheo.getTheo({ market, asOf: event.receiveTime });
  }
  pipelineSeeded = true;
}

async function quotes() {
  await ensureTheoSeeded();
  const markets = await activeMarkets();
  const result = [];
  for (const market of markets.filter((item) => item.status === "OPEN")) {
    const theo = await theoProvider.getTheo({ market });
    for (const selection of market.selections) {
      result.push(generateQuote({
        market,
        selectionId: selection.selectionId,
        theo,
        inventory: portfolio.positions.find((position) => position.marketId === market.marketId && position.selectionId === selection.selectionId),
        recentVolatility: loop.theo.getInnovation(market.marketId) * 0.05,
        sharpMovementSignal: loop.theo.getInnovation(market.marketId),
        dataAgeMs: Date.now() - Date.parse(market.updatedAt),
        marketConcentration: 0,
        remainingMarketRiskBudget: riskLimits.maxExposurePerMarket,
        remainingFixtureRiskBudget: riskLimits.maxExposurePerFixture,
        remainingPortfolioRiskBudget: riskLimits.maxWorstCaseLoss,
        worstCaseMarginalLiability: 1,
        directionalSignal: null,
        riskLimits,
        config: defaultQuoteConfig,
      }));
    }
  }
  return result;
}

function demoSnapshot() {
  const audit = lastAudit;
  const terminal = null;
  return {
    mode: useReplayTheo ? "REPLAY" : "NULL_THEO",
    replay: clock.status(),
    killSwitch: riskLimits.killSwitch,
    marketPrice: audit?.marketPrice ?? null,
    theo: audit?.theo ?? null,
    baseline: audit?.baseline ?? null,
    uncertainty: audit?.uncertainty ?? null,
    bid: audit?.bid ?? null,
    ask: audit?.ask ?? null,
    width: audit?.width ?? null,
    inventoryLean: audit?.inventoryLean ?? 0,
    directionalLean: audit?.directionalLean ?? 0,
    quoteSize: audit?.quoteSize ?? null,
    quoteStatus: audit?.quoteStatus ?? null,
    makerInventory: audit?.makerInventory ?? 0,
    directionalPosition: audit?.directionalPosition ?? 0,
    worstCaseLiability: terminal,
    markout: {
      m10: audit?.markout10s ?? null,
      m30: audit?.markout30s ?? null,
      m60: audit?.markout60s ?? null,
      m300: audit?.markout300s ?? null,
    },
    pnl: {
      realized: loop.state.portfolio.cash.realizedPnl,
      fees: loop.state.portfolio.cash.feesPaid,
    },
    innovation: audit?.innovation ?? 0,
    quoteSuspended: audit?.quoteSuspended ?? false,
    reasonCodes: audit?.reasonCodes ?? ["AWAITING_REPLAY_STEP"],
    dataStatus: useReplayTheo ? replayAdapter.getSystemDataStatus() : liveAdapter.getSystemDataStatus(),
  };
}

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathName = url.pathname;

  if (req.method === "GET" && pathName === "/health") {
    return send(res, 200, {
      ok: true,
      dataStatus: useReplayTheo ? replayAdapter.getSystemDataStatus() : liveAdapter.getSystemDataStatus(),
      theoMode: useReplayTheo ? "PIPELINE_REPLAY" : "NULL",
      replayLoaded,
    });
  }
  if (req.method === "GET" && pathName === "/api/config") {
    return send(res, 200, {
      network: "devnet-ready",
      txodds: useReplayTheo ? replayAdapter.getSystemDataStatus() : liveAdapter.getSystemDataStatus(),
      theoDisplay: useReplayTheo ? "Research pipeline theo (MarketBaseline→StateSpace posterior)" : awaitingTxoddsDisplay,
      riskLimits,
      theoMode: useReplayTheo ? "replay" : "null",
    });
  }
  if (req.method === "GET" && pathName === "/api/fixtures") return send(res, 200, await activeFixtures());
  if (req.method === "GET" && pathName === "/api/markets") return send(res, 200, await activeMarkets());
  if (req.method === "GET" && pathName.startsWith("/api/markets/")) {
    const markets = await activeMarkets();
    const market = markets.find((item) => item.marketId === decodeURIComponent(pathName.split("/").at(-1) ?? ""));
    return market ? send(res, 200, market) : send(res, 404, { error: "UNKNOWN_MARKET" });
  }
  if (req.method === "GET" && pathName.startsWith("/api/theo/")) {
    await ensureTheoSeeded();
    const marketId = decodeURIComponent(pathName.split("/").at(-1) ?? "");
    const markets = await activeMarkets();
    const market = markets.find((item) => item.marketId === marketId) ?? sampleMarkets.find((item) => item.marketId === marketId);
    return market
      ? send(res, 200, await theoProvider.getTheo({ market }))
      : send(res, 404, {
        marketId,
        probabilities: null,
        uncertainty: null,
        status: "UNSUPPORTED_MARKET",
        modelVersion: null,
        source: null,
        reasonCodes: ["UNKNOWN_MARKET"],
      });
  }
  if (req.method === "GET" && pathName === "/api/quotes") return send(res, 200, await quotes());
  if (req.method === "GET" && pathName === "/api/positions") {
    return send(res, 200, useReplayTheo ? loop.state.portfolio.positions : portfolio.positions);
  }
  if (req.method === "GET" && pathName === "/api/portfolio") {
    return send(res, 200, useReplayTheo ? loop.state.portfolio : portfolio);
  }
  if (req.method === "GET" && pathName === "/api/risk") {
    const markets = await activeMarkets();
    const fixtureId = (await activeFixtures())[0]?.fixtureId ?? "fixture-test-001";
    const scenarios = defaultScoreScenarios(fixtureId, useReplayTheo ? "REPLAY" : "TEST_FIXTURE");
    const pf = useReplayTheo ? loop.state.portfolio : portfolio;
    const terminal = terminalOutcomeRisk(pf, markets, scenarios, null);
    return send(res, 200, { snapshot: buildRiskSnapshot(pf, riskLimits, terminal), terminal });
  }
  if (req.method === "POST" && pathName === "/api/risk/scenario") {
    const body = await readJson(req) as { fixtureId?: string };
    const markets = await activeMarkets();
    const scenarios = defaultScoreScenarios(body.fixtureId ?? "fixture-test-001", useReplayTheo ? "REPLAY" : "TEST_FIXTURE");
    return send(res, 200, terminalOutcomeRisk(useReplayTheo ? loop.state.portfolio : portfolio, markets, scenarios, null));
  }
  if (req.method === "GET" && pathName === "/api/fills") return send(res, 200, useReplayTheo ? loop.state.fills : fills);
  if (req.method === "GET" && pathName === "/api/orders") return send(res, 200, orders);
  if (req.method === "GET" && pathName === "/api/performance") {
    return send(res, 200, buildPerformanceSnapshot(useReplayTheo ? loop.state.portfolio : portfolio));
  }
  if (req.method === "GET" && pathName === "/api/strategies") return send(res, 200, strategies);
  if (req.method === "POST" && pathName.match(/^\/api\/strategies\/[^/]+\/enable$/)) {
    if (!useReplayTheo) return send(res, 409, { status: "THEO_UNAVAILABLE", reasonCodes: ["TXODDS_API_NOT_CONNECTED"] });
    return send(res, 200, { status: "READY" });
  }
  if (req.method === "POST" && pathName.match(/^\/api\/strategies\/[^/]+\/disable$/)) return send(res, 200, { status: "DISABLED" });
  if (req.method === "POST" && pathName === "/api/orders/paper") {
    const body = await readJson(req) as Partial<Order>;
    const markets = await activeMarkets();
    const market = markets.find((item) => item.marketId === body.marketId) ?? sampleMarkets.find((item) => item.marketId === body.marketId);
    if (!market) return send(res, 404, { error: "UNKNOWN_MARKET" });
    const order: Order = {
      orderId: body.orderId ?? `paper-${Date.now()}`,
      marketId: market.marketId,
      selectionId: body.selectionId ?? market.selections[0].selectionId,
      side: body.side ?? "BUY",
      price: body.price ?? 0.5,
      size: body.size ?? 1,
      status: "NEW",
      executionStyle: body.executionStyle ?? "TAKER",
      strategyId: body.strategyId,
      createdAt: new Date().toISOString(),
      provenance: { source: "SYNTHETIC", notes: "Paper-only order submitted through local API." },
    };
    const result = execution.submitOrder(portfolio, market, order, riskLimits);
    portfolio = markPortfolio(result.portfolio, marketPrices);
    orders = [...orders, result.order];
    fills = [...fills, ...result.fills];
    return send(res, result.order.status === "REJECTED" ? 422 : 200, result);
  }
  if (req.method === "POST" && pathName === "/api/kill-switch/enable") {
    riskLimits = { ...riskLimits, killSwitch: true };
    loop.setRiskLimits(riskLimits);
    return send(res, 200, { killSwitch: true });
  }
  if (req.method === "POST" && pathName === "/api/kill-switch/disable") {
    riskLimits = { ...riskLimits, killSwitch: false };
    loop.setRiskLimits(riskLimits);
    return send(res, 200, { killSwitch: false });
  }

  if (pathName.startsWith("/api/replay/") && !useReplayTheo) {
    return send(res, 409, {
      status: "THEO_UNAVAILABLE",
      reasonCodes: ["RESEARCH_MODE_NOT_ENABLED", "SET_THEO_MODE_TO_REPLAY_OR_RESEARCH"],
    });
  }
  if (req.method === "GET" && pathName === "/api/replay/status") return send(res, 200, clock.status());
  if (req.method === "POST" && pathName === "/api/replay/reset") {
    loop.reset();
    pipelineTheo.clear();
    pipelineSeeded = false;
    clock = new ReplayClock(replayAdapter.store.events());
    lastAudit = null;
    portfolio = loop.state.portfolio;
    fills = [];
    return send(res, 200, clock.status());
  }
  if (req.method === "POST" && pathName === "/api/replay/pause") {
    clock.pause();
    return send(res, 200, clock.status());
  }
  if (req.method === "POST" && pathName === "/api/replay/play") {
    clock.play();
    return send(res, 200, clock.status());
  }
  if (req.method === "POST" && pathName === "/api/replay/speed") {
    const body = await readJson(req) as { speed?: number };
    clock.setSpeed(body.speed ?? 1);
    return send(res, 200, clock.status());
  }
  if (req.method === "POST" && pathName === "/api/replay/step") {
    const event = clock.step();
    if (!event) return send(res, 200, { done: true, status: clock.status(), audit: lastAudit });
    lastAudit = await loop.onEvent(event);
    portfolio = loop.state.portfolio;
    fills = loop.state.fills;
    return send(res, 200, { done: false, status: clock.status(), audit: lastAudit, demo: demoSnapshot() });
  }
  if (req.method === "POST" && pathName === "/api/replay/run") {
    const body = await readJson(req) as { maxSteps?: number };
    const maxSteps = body.maxSteps ?? 10_000;
    let steps = 0;
    for (let i = 0; i < maxSteps; i++) {
      const event = clock.step();
      if (!event) break;
      lastAudit = await loop.onEvent(event);
      steps += 1;
    }
    portfolio = loop.state.portfolio;
    fills = loop.state.fills;
    return send(res, 200, { steps, status: clock.status(), demo: demoSnapshot(), lastAudit });
  }

  if (req.method === "GET" && pathName === "/api/demo/snapshot") return send(res, 200, demoSnapshot());
  if (req.method === "GET" && pathName === "/api/audit") return send(res, 200, loop.state.audit);

  return send(res, 404, { error: "NOT_FOUND" });
}

if (process.argv[1]?.endsWith("server.ts")) {
  http.createServer((req, res) => {
    route(req, res).catch((error) => send(res, 500, {
      error: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    }));
  }).listen(port, () => {
    console.log(`World Cup market-making API listening on http://localhost:${port}`);
    console.log(`Theo mode: ${useReplayTheo ? "replay pipeline" : "null"}; replayLoaded=${replayLoaded}`);
  });
}

export { route, loop, clock, replayAdapter, pipelineTheo, useReplayTheo, nullTheo };
