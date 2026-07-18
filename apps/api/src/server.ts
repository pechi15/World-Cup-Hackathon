import http from "node:http";
import { URL } from "node:url";
import { markets, fixtures, marketPrices, defaultRiskLimits } from "./sample-data.js";
import { awaitingTxoddsDisplay, type Fill, type Order } from "../../../packages/contracts/src/index.js";
import { DisabledTxoddsAdapter } from "../../../packages/market-data/src/index.js";
import { NullTheoProvider } from "../../../packages/theo/src/index.js";
import { defaultQuoteConfig, generateQuote } from "../../../packages/quoting/src/index.js";
import { createEmptyPortfolio, markPortfolio } from "../../../packages/portfolio/src/index.js";
import { defaultScoreScenarios } from "../../../packages/market-model/src/index.js";
import { buildRiskSnapshot, terminalOutcomeRisk } from "../../../packages/risk/src/index.js";
import { PaperExecutionEngine } from "../../../packages/execution/src/index.js";
import { buildPerformanceSnapshot } from "../../../packages/evaluation/src/index.js";
import { NoTheoNoActionStrategy } from "../../../packages/strategies/src/index.js";

const port = Number(process.env.PORT ?? 8787);
const theoProvider = new NullTheoProvider();
const adapter = new DisabledTxoddsAdapter({
  network: process.env.TXLINE_NETWORK,
  apiOrigin: process.env.TXLINE_API_ORIGIN,
  guestJwt: process.env.TXLINE_GUEST_JWT,
  apiToken: process.env.TXLINE_API_TOKEN,
  solanaRpcUrl: process.env.SOLANA_RPC_URL,
});
const execution = new PaperExecutionEngine();
let riskLimits = { ...defaultRiskLimits };
let portfolio = markPortfolio(createEmptyPortfolio(), marketPrices);
let orders: Order[] = [];
let fills: Fill[] = [];
const strategies = [{ strategyId: "no-theo-no-action", enabled: false, status: "THEO_UNAVAILABLE" }];

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

async function quotes() {
  const result = [];
  for (const market of markets.filter((item) => item.status === "OPEN")) {
    const theo = await theoProvider.getTheo({ market });
    for (const selection of market.selections) {
      result.push(generateQuote({
        market,
        selectionId: selection.selectionId,
        theo,
        inventory: portfolio.positions.find((position) => position.marketId === market.marketId && position.selectionId === selection.selectionId),
        recentVolatility: 0,
        sharpMovementSignal: 0,
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

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true, dataStatus: adapter.getSystemDataStatus() });
  if (req.method === "GET" && path === "/api/config") return send(res, 200, { network: "devnet-ready", txodds: adapter.getSystemDataStatus(), theoDisplay: awaitingTxoddsDisplay, riskLimits });
  if (req.method === "GET" && path === "/api/fixtures") return send(res, 200, fixtures);
  if (req.method === "GET" && path === "/api/markets") return send(res, 200, markets);
  if (req.method === "GET" && path.startsWith("/api/markets/")) {
    const market = markets.find((item) => item.marketId === decodeURIComponent(path.split("/").at(-1) ?? ""));
    return market ? send(res, 200, market) : send(res, 404, { error: "UNKNOWN_MARKET" });
  }
  if (req.method === "GET" && path.startsWith("/api/theo/")) {
    const marketId = decodeURIComponent(path.split("/").at(-1) ?? "");
    const market = markets.find((item) => item.marketId === marketId);
    return market ? send(res, 200, await theoProvider.getTheo({ market })) : send(res, 404, { marketId, probabilities: null, uncertainty: null, status: "UNSUPPORTED_MARKET", modelVersion: null, source: null, reasonCodes: ["UNKNOWN_MARKET"] });
  }
  if (req.method === "GET" && path === "/api/quotes") return send(res, 200, await quotes());
  if (req.method === "GET" && path === "/api/positions") return send(res, 200, portfolio.positions);
  if (req.method === "GET" && path === "/api/portfolio") return send(res, 200, portfolio);
  if (req.method === "GET" && path === "/api/risk") {
    const scenarios = defaultScoreScenarios("fixture-test-001", "TEST_FIXTURE");
    const terminal = terminalOutcomeRisk(portfolio, markets, scenarios, null);
    return send(res, 200, { snapshot: buildRiskSnapshot(portfolio, riskLimits, terminal), terminal });
  }
  if (req.method === "POST" && path === "/api/risk/scenario") {
    const body = await readJson(req) as { fixtureId?: string };
    const scenarios = defaultScoreScenarios(body.fixtureId ?? "fixture-test-001", "TEST_FIXTURE");
    return send(res, 200, terminalOutcomeRisk(portfolio, markets, scenarios, null));
  }
  if (req.method === "GET" && path === "/api/fills") return send(res, 200, fills);
  if (req.method === "GET" && path === "/api/orders") return send(res, 200, orders);
  if (req.method === "GET" && path === "/api/performance") return send(res, 200, buildPerformanceSnapshot(portfolio));
  if (req.method === "GET" && path === "/api/strategies") return send(res, 200, strategies);
  if (req.method === "POST" && path.match(/^\/api\/strategies\/[^/]+\/enable$/)) return send(res, 409, { status: "THEO_UNAVAILABLE", reasonCodes: ["TXODDS_API_NOT_CONNECTED"] });
  if (req.method === "POST" && path.match(/^\/api\/strategies\/[^/]+\/disable$/)) return send(res, 200, { status: "DISABLED" });
  if (req.method === "POST" && path === "/api/orders/paper") {
    const body = await readJson(req) as Partial<Order>;
    const market = markets.find((item) => item.marketId === body.marketId);
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
  if (req.method === "POST" && path === "/api/kill-switch/enable") {
    riskLimits = { ...riskLimits, killSwitch: true };
    return send(res, 200, { killSwitch: true });
  }
  if (req.method === "POST" && path === "/api/kill-switch/disable") {
    riskLimits = { ...riskLimits, killSwitch: false };
    return send(res, 200, { killSwitch: false });
  }

  return send(res, 404, { error: "NOT_FOUND" });
}

if (process.argv[1]?.endsWith("server.ts")) {
  http.createServer((req, res) => {
    route(req, res).catch((error) => send(res, 500, { error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) }));
  }).listen(port, () => {
    console.log(`World Cup market-making API listening on http://localhost:${port}`);
  });
}

export { route };
