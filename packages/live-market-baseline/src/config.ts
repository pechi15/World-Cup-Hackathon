import type { Environment } from "../../market-data/src/config.js";

export type MarketBaselineRuntimeConfig = {
  enabled: boolean;
  valid: boolean;
  theoMode: "NULL" | "MARKET_BASELINE";
  tradingMode: "DISABLED" | "PAPER";
  makerEnabled: boolean;
  directionalEnabled: false;
  kellyEnabled: false;
  realExecutionEnabled: false;
  reasonCodes: string[];
  executionLatencyMs: number;
  quoteExpiryMs: number;
  staleAfterMs: number;
  informationShockZ: number;
  feeRate: number;
  slippage: number;
};

function exact(env: Environment, name: string, expected: string, reasons: string[]): void {
  const actual = env[name]?.trim().toLowerCase();
  if (actual === undefined || actual === "") reasons.push(`MISSING_${name}`);
  else if (actual !== expected.toLowerCase()) reasons.push(`INVALID_${name}`);
}

function positiveNumber(env: Environment, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveMarketBaselineRuntimeConfig(env: Environment): MarketBaselineRuntimeConfig {
  const mode = env.THEO_MODE?.trim().toLowerCase();
  if (mode !== "market_baseline") {
    return {
      enabled: false,
      valid: true,
      theoMode: "NULL",
      tradingMode: "DISABLED",
      makerEnabled: false,
      directionalEnabled: false,
      kellyEnabled: false,
      realExecutionEnabled: false,
      reasonCodes: ["MARKET_BASELINE_MODE_NOT_ENABLED"],
      executionLatencyMs: 250,
      quoteExpiryMs: 5_000,
      staleAfterMs: 10_000,
      informationShockZ: 4,
      feeRate: 0.001,
      slippage: 0,
    };
  }

  const reasons: string[] = [];
  exact(env, "DATA_MODE", "txline", reasons);
  exact(env, "DEMO_MODE", "false", reasons);
  exact(env, "TRADING_MODE", "paper", reasons);
  exact(env, "ENABLE_MARKET_MAKING", "true", reasons);
  exact(env, "ENABLE_DIRECTIONAL_TRADING", "false", reasons);
  exact(env, "ENABLE_KELLY", "false", reasons);
  exact(env, "ENABLE_REAL_EXECUTION", "false", reasons);
  exact(env, "ENABLE_WALLET_OPERATIONS", "false", reasons);
  exact(env, "ENABLE_TXODDS_ACTIVATION", "false", reasons);
  if (env.ENABLE_REAL_EXECUTION?.trim().toLowerCase() === "true") {
    reasons.push("UNSAFE_REAL_EXECUTION_FOR_MARKET_BASELINE");
  }

  return {
    enabled: true,
    valid: reasons.length === 0,
    theoMode: "MARKET_BASELINE",
    tradingMode: "PAPER",
    makerEnabled: reasons.length === 0,
    directionalEnabled: false,
    kellyEnabled: false,
    realExecutionEnabled: false,
    reasonCodes: reasons,
    executionLatencyMs: positiveNumber(env, "PAPER_EXECUTION_LATENCY_MS", 250),
    quoteExpiryMs: positiveNumber(env, "PAPER_QUOTE_EXPIRY_MS", 5_000),
    staleAfterMs: positiveNumber(env, "MARKET_DATA_STALE_AFTER_MS", 10_000),
    informationShockZ: positiveNumber(env, "MARKET_INFORMATION_SHOCK_Z", 4),
    feeRate: 0.001,
    slippage: 0,
  };
}

export function assertMarketBaselineStartupSafe(config: MarketBaselineRuntimeConfig): void {
  if (config.reasonCodes.includes("UNSAFE_REAL_EXECUTION_FOR_MARKET_BASELINE")) {
    throw new Error("UNSAFE_CONFIGURATION: market_baseline forbids real execution");
  }
}
