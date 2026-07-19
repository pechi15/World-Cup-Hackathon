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
    expect(trading).toMatchObject({ maker: "PAPER_ENABLED", directional: "DISABLED_NON_INDEPENDENT_THEO", kelly: "DISABLED_NON_INDEPENDENT_THEO", realExecution: "DISABLED", estimatedEdge: null, kellySize: null });
    for (const path of ["/api/quotes", "/api/positions", "/api/risk", "/api/performance", "/api/audit"]) {
      expect((await fetch(`${baseUrl}${path}`)).ok).toBe(true);
    }
  });
});
