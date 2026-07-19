import { DemoStateSchema, type DemoState } from "../../../../../packages/contracts/src/index.js";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? "http://localhost:8787" : "");

export type SystemHealth = {
  ok: boolean;
  dataStatus: { status: string; display: string; mode: string; reasonCodes: string[] };
  dataMode: string;
  theoMode: string;
  tradingMode: string;
};

export type TradingStatus = {
  maker: string;
  directional?: string;
  hawk?: string;
  kelly: string;
  kellyImplemented?: boolean;
  kellyEnabled?: boolean;
  agentAutonomous?: boolean;
  executionMode?: "SHADOW" | string;
  shadowExecution?: "ENABLED" | string;
  decisionBookEnabled?: boolean;
  realExecutionEnabled?: boolean;
  realExecution: string;
  walletOperations?: string;
  subscriptionActivation?: string;
  directionalAction?: string;
  kellySize?: null;
  labels?: string[];
  reasonCodes?: string[];
  sharedRisk?: {
    displayName?: string;
    executionMode?: string;
    grossExposure?: number;
    remainingCapacity?: number;
    killSwitches?: { manual?: boolean; latency?: boolean; staleData?: boolean; sequenceGap?: boolean };
  };
};

export type AgentStatus = {
  agentId: "maker" | "hawk";
  displayName: string;
  technicalRole: string;
  technicalSubtitle?: string;
  state: string;
  latestAction: string | null;
  latestDecisionId?: string | null;
  executionMode: string;
  reasonCodes: string[];
  bid?: number | null;
  ask?: number | null;
  width?: number | null;
  size?: number | null;
  inventoryLean?: number;
  quoteGuardRiskScore?: number | null;
  signalType?: string;
  signalConfidence?: number;
  paperPosition?: number;
};

export type DecisionRecord = {
  decisionId: string;
  decisionTime: string;
  strategy: string;
  action: string;
  side: string;
  proposedPrice: number | null;
  proposedSize: number;
  status: string;
  realizedPnl: number;
  unrealizedPnl: number;
  reasonCodes: string[];
  noLookaheadVerificationStatus: string;
  provenance: string;
};

export type CurrentFixture = {
  fixture?: {
    fixtureId?: string;
    participant1?: string;
    participant2?: string;
    startTime?: string | null;
    gameState?: string | null;
  };
  provenance?: string;
  resultStatus?: string;
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
  tradingStatus: () => request<TradingStatus>("/api/trading/status"),
  makerStatus: () => request<AgentStatus>("/api/agent/maker"),
  hawkStatus: () => request<AgentStatus>("/api/agent/hawk"),
  decisionBook: () => request<{ displayName: string; executionMode: string; decisions: DecisionRecord[] }>("/api/decision-book"),
  currentFixture: () => request<CurrentFixture>("/api/fixtures/current"),
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
