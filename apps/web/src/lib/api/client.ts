import { DemoStateSchema, type DemoState } from "../../../../../packages/contracts/src/index.js";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? "http://localhost:8787" : "");

export type SystemHealth = {
  ok: boolean;
  dataStatus: {
    status: string;
    display: string;
    reasonCodes: string[];
  };
};

async function request<T>(path: string, init?: RequestInit, parse?: (value: unknown) => T): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`API ${path} failed with ${response.status}`);
  const json = await response.json();
  return parse ? parse(json) : json as T;
}

export const demoApi = {
  health: () => request<SystemHealth>("/health"),
  state: () => request<DemoState>("/api/demo/state", undefined, (value) => DemoStateSchema.parse(value)),
  start: () => request<DemoState>("/api/demo/start", { method: "POST" }, (value) => DemoStateSchema.parse(value)),
  pause: () => request<DemoState>("/api/demo/pause", { method: "POST" }, (value) => DemoStateSchema.parse(value)),
  resume: () => request<DemoState>("/api/demo/resume", { method: "POST" }, (value) => DemoStateSchema.parse(value)),
  reset: () => request<DemoState>("/api/demo/reset", { method: "POST" }, (value) => DemoStateSchema.parse(value)),
  step: () => request<DemoState>("/api/demo/step", { method: "POST" }, (value) => DemoStateSchema.parse(value)),
  injectShock: () => request<DemoState>("/api/demo/inject-shock", { method: "POST" }, (value) => DemoStateSchema.parse(value)),
  speed: (speed: number) => request<DemoState>("/api/demo/speed", { method: "POST", body: JSON.stringify({ speed }) }, (value) => DemoStateSchema.parse(value)),
  replays: () => request<{ selected: string; options: Array<{ id: string; label: string; available: boolean }> }>("/api/demo/replays"),
  selectReplay: (replayId: string) => request<DemoState>("/api/demo/replay", { method: "POST", body: JSON.stringify({ replayId }) }, (value) => DemoStateSchema.parse(value)),
};
