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
    expect(state.disclaimer).toContain("Replay");
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
});
