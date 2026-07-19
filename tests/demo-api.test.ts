import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { route } from "../apps/api/src/server.js";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    route(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });
  expect(response.ok).toBe(true);
  return response.json();
}

describe("demo API", () => {
  it("serves readiness and state", async () => {
    const ready = await fetch(`${baseUrl}/ready`).then((res) => res.json());
    expect(ready.ready).toBe(true);
    const state = await fetch(`${baseUrl}/api/demo/state`).then((res) => res.json());
    expect(state.disclaimer).toContain("MARKET CONSENSUS BASELINE");
  });

  it("handles replay controls", async () => {
    const started = await post("/api/demo/start");
    expect(started.replayStatus).toBe("RUNNING");
    const paused = await post("/api/demo/pause");
    expect(paused.replayStatus).toBe("PAUSED");
    const speed = await post("/api/demo/speed", { speed: 5 });
    expect(speed.speed).toBe(5);
    const stepped = await post("/api/demo/step");
    expect(stepped.currentIndex).toBeGreaterThan(0);
  });

  it("exposes truthful pricing, trading, quote, position, risk, performance, and audit status", async () => {
    const txodds = await fetch(`${baseUrl}/api/txodds/status`).then((res) => res.json());
    expect(txodds).toMatchObject({ status: "CONNECTED", mode: "replay", readOnly: true });
    const theo = await fetch(`${baseUrl}/api/theo/status`).then((res) => res.json());
    expect(theo).toMatchObject({ status: "AVAILABLE_BENCHMARK", provenance: "TXODDS_MARKET_BASELINE", independentAlpha: false });
    const trading = await fetch(`${baseUrl}/api/trading/status`).then((res) => res.json());
    expect(trading).toMatchObject({
      maker: "PAPER_ENABLED",
      directional: "DISABLED_NON_INDEPENDENT_THEO",
      kelly: "DISABLED_NON_INDEPENDENT_THEO",
      kellyImplemented: true,
      kellyEnabled: false,
      realExecution: "DISABLED",
      estimatedEdge: null,
      directionalAction: "NO_ACTION",
      kellySize: null,
    });
    expect(trading.reasonCodes).toEqual(expect.arrayContaining(["INDEPENDENT_THEO_UNAVAILABLE", "MARKET_BASELINE_IS_NOT_ALPHA", "KELLY_DISABLED"]));
    for (const path of ["/api/quotes", "/api/positions", "/api/risk", "/api/performance", "/api/audit"]) {
      expect((await fetch(`${baseUrl}${path}`)).ok).toBe(true);
    }
  });

  it("offers truthful live, historical, and deterministic sources", async () => {
    const replays = await fetch(`${baseUrl}/api/demo/replays`).then((res) => res.json());
    expect(replays.options).toEqual([
      expect.objectContaining({ id: "live-current", label: "Live Argentina–Spain", available: false, sourceType: "LIVE_TXODDS" }),
      expect.objectContaining({ id: "historical-recorded", label: "Historical England–France", available: true, sourceType: "RECORDED_TXODDS_REPLAY" }),
      expect.objectContaining({ id: "built-in", label: "Built-in deterministic fallback", available: true, sourceType: "DETERMINISTIC_REPLAY" }),
    ]);
    const recorded = await post("/api/demo/replay", { replayId: "historical-recorded" });
    expect(recorded.dataSource).toBe("RECORDED_TXODDS_HISTORICAL_REPLAY");
    expect(recorded.totalEvents).toBeGreaterThan(0);
    const started = await post("/api/demo/start");
    expect(started.marketRows[0]?.fixture).toContain("recorded TxODDS");
    const firstProbabilities = started.marketRows.map((row: { marketProbability: number }) => row.marketProbability);
    await post("/api/demo/reset");
    const repeated = await post("/api/demo/start");
    expect(repeated.marketRows.map((row: { marketProbability: number }) => row.marketProbability)).toEqual(firstProbabilities);
    const builtIn = await post("/api/demo/replay", { replayId: "built-in" });
    expect(builtIn.dataSource).toBe("SANITIZED_DETERMINISTIC_REPLAY");
  });
});
