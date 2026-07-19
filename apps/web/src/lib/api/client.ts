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
  directional: string;
  kelly: string;
  kellyImplemented: boolean;
  kellyEnabled: boolean;
  realExecution: string;
  walletOperations: string;
  subscriptionActivation: string;
  directionalAction: "NO_ACTION";
  kellySize: null;
  labels: string[];
  reasonCodes: string[];
  executionMode?: string;
  shadowExecution?: string;
  decisionBookEnabled?: boolean;
};

export type AgentStatus = {
  executionMode: "SHADOW";
  maker: {
    state: string;
    latestAction: string;
    bid: number | null;
    ask: number | null;
    width: number | null;
    size: number | null;
    inventoryLean: number;
    quoteGuardRiskScore: number | null;
    runId: string | null;
    eventIndex: number;
    sourceTimestamp: string | null;
    currentMarketObservation: {
      fixtureId: string;
      marketId: string;
      selectionId: string;
      marketReference: number;
      uncertainty: number;
      volatility: number;
      standardizedInnovation: number;
    } | null;
    activeQuote: {
      bid: number;
      ask: number;
      width: number;
      size: number;
      createdAtEventIndex: number;
      createdAtSourceTimestamp: string;
      validThroughEventIndex: number;
      fixtureId: string;
      marketId: string;
      selectionId: string;
      status: "ACTIVE" | "CANCELLED" | "SUSPENDED";
    } | null;
    latestDecision: {
      action: string;
      decisionTimestamp: string;
      decisionEventIndex: number;
      reasonCodes: string[];
    } | null;
    reasonCodes: string[];
  };
  hawk: {
    state: string;
    latestAction: string;
    signalType: string;
    signalConfidence: number | null;
    paperPosition: number;
    labels: string[];
    reasonCodes: string[];
  };
  sharedRisk: {
    grossExposure: number;
    remainingCapacity: number;
    killSwitches: { manual: boolean; latency: boolean; staleData: boolean; sequenceGap: boolean };
    realFunds: "DISABLED";
  };
  quoteGuard: {
    status: string;
    provenance: string;
    checksumsValidated: boolean;
  };
};

export type DecisionBook = {
  noLookaheadVerificationStatus: string;
  decisions: Array<{
    decisionId: string;
    decisionTime: string;
    strategy: string;
    action: string;
    proposedPrice: number | null;
    proposedSize: number;
    reasonCodes: string[];
    status: string;
    fillPrice: number | null;
    realizedPnl: number;
    unrealizedPnl: number;
    noLookaheadVerificationStatus: string;
  }>;
};

export type RuntimeSnapshot = {
  runId: string | null;
  eventIndex: number;
  sourceTimestamp: string | null;
  fixtureId: string | null;
  marketId: string | null;
  selectionId: string | null;
  marketReference: number | null;
  activeQuote: AgentStatus["maker"]["activeQuote"];
  latestDecision: AgentStatus["maker"]["latestDecision"];
  state: DemoState;
  agentStatus: AgentStatus;
  decisionBook: DecisionBook;
};

export type CurrentFixtureSample = {
  provenance: string;
  resultStatus: string;
  fixture: {
    participant1: string;
    participant2: string;
    startTime: string | null;
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
  tradingStatus: () => request<TradingStatus>("/api/trading/status"),
  agentStatus: () => request<AgentStatus>("/api/agent/status"),
  decisionBook: () => request<DecisionBook>("/api/decision-book"),
  currentFixture: () => request<CurrentFixtureSample>("/api/fixtures/current"),
  state: () => request<DemoState>("/api/demo/state", undefined, (value) => DemoStateSchema.parse(value)),
  snapshot: () => request<RuntimeSnapshot>("/api/runtime/snapshot", undefined, (value) => {
    const snapshot = value as Omit<RuntimeSnapshot, "state"> & { state: unknown };
    return { ...snapshot, state: DemoStateSchema.parse(snapshot.state) };
  }),
  start: () => request<DemoState>("/api/demo/start", { method: "POST" }, (value) => DemoStateSchema.parse(value)),
  pause: () => request<DemoState>("/api/demo/pause", { method: "POST" }, (value) => DemoStateSchema.parse(value)),
  resume: () => request<DemoState>("/api/demo/resume", { method: "POST" }, (value) => DemoStateSchema.parse(value)),
  reset: () => request<DemoState>("/api/demo/reset", { method: "POST" }, (value) => DemoStateSchema.parse(value)),
  step: () => request<DemoState>("/api/demo/step", { method: "POST" }, (value) => DemoStateSchema.parse(value)),
  injectShock: () => request<DemoState>("/api/demo/inject-shock", { method: "POST" }, (value) => DemoStateSchema.parse(value)),
  speed: (speed: number) => request<DemoState>("/api/demo/speed", { method: "POST", body: JSON.stringify({ speed }) }, (value) => DemoStateSchema.parse(value)),
  replays: () => request<{ selected: string; options: Array<{ id: string; label: string; available: boolean; sourceType?: string }> }>("/api/demo/replays"),
  selectReplay: (replayId: string) => request<DemoState>("/api/demo/replay", { method: "POST", body: JSON.stringify({ replayId }) }, (value) => DemoStateSchema.parse(value)),
};
