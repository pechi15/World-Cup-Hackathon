export const TXLINE_DEVNET_ORIGIN = "https://txline-dev.txodds.com";
export const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";

export type Environment = Record<string, string | undefined>;

type SafetyFlags = {
  enableRealExecution: false;
  enableWalletOperations: false;
  enableTxoddsActivation: false;
};

export type ReplayDataConfig = SafetyFlags & {
  valid: true;
  mode: "replay";
  demoMode: true;
};

export type TxlineDataConfig = SafetyFlags & {
  valid: true;
  mode: "txline";
  demoMode: false;
  network: "devnet";
  apiOrigin: typeof TXLINE_DEVNET_ORIGIN;
  apiToken: string;
  solanaRpcUrl: typeof SOLANA_DEVNET_RPC;
};

export type InvalidDataConfig = {
  valid: false;
  mode: "replay" | "txline" | "unknown";
  status: "NOT_CONFIGURED" | "AWAITING_CREDENTIALS";
  reasonCodes: string[];
};

export type DataRuntimeConfig = ReplayDataConfig | TxlineDataConfig | InvalidDataConfig;

function exactBoolean(env: Environment, name: string, expected: boolean, reasons: string[]): void {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") reasons.push(`MISSING_${name}`);
  else if (value !== String(expected)) reasons.push(`INVALID_${name}`);
}

function safetyReasons(env: Environment): string[] {
  const reasons: string[] = [];
  exactBoolean(env, "ENABLE_REAL_EXECUTION", false, reasons);
  exactBoolean(env, "ENABLE_WALLET_OPERATIONS", false, reasons);
  exactBoolean(env, "ENABLE_TXODDS_ACTIVATION", false, reasons);
  return reasons;
}

/**
 * Resolves Railway/runtime configuration without reading files or applying a
 * replay fallback. Railway injects variables directly into process.env.
 */
export function resolveDataRuntimeConfig(env: Environment): DataRuntimeConfig {
  const requestedMode = env.DATA_MODE?.trim().toLowerCase();
  if (requestedMode !== "replay" && requestedMode !== "txline") {
    return {
      valid: false,
      mode: "unknown",
      status: "NOT_CONFIGURED",
      reasonCodes: [requestedMode ? "INVALID_DATA_MODE" : "MISSING_DATA_MODE"],
    };
  }

  const reasons = safetyReasons(env);
  if (requestedMode === "replay") {
    exactBoolean(env, "DEMO_MODE", true, reasons);
    if (reasons.length > 0) return { valid: false, mode: "replay", status: "NOT_CONFIGURED", reasonCodes: reasons };
    return {
      valid: true,
      mode: "replay",
      demoMode: true,
      enableRealExecution: false,
      enableWalletOperations: false,
      enableTxoddsActivation: false,
    };
  }

  exactBoolean(env, "DEMO_MODE", false, reasons);
  if (env.TXLINE_NETWORK !== "devnet") reasons.push(env.TXLINE_NETWORK ? "INVALID_TXLINE_NETWORK" : "MISSING_TXLINE_NETWORK");
  if (env.TXLINE_API_ORIGIN !== TXLINE_DEVNET_ORIGIN) reasons.push(env.TXLINE_API_ORIGIN ? "INVALID_TXLINE_API_ORIGIN" : "MISSING_TXLINE_API_ORIGIN");
  if (env.SOLANA_RPC_URL !== SOLANA_DEVNET_RPC) reasons.push(env.SOLANA_RPC_URL ? "INVALID_SOLANA_RPC_URL" : "MISSING_SOLANA_RPC_URL");
  if (!env.TXLINE_API_TOKEN?.trim()) reasons.push("MISSING_TXLINE_API_TOKEN");
  if (reasons.length > 0) {
    return {
      valid: false,
      mode: "txline",
      status: reasons.every((reason) => reason === "MISSING_TXLINE_API_TOKEN") ? "AWAITING_CREDENTIALS" : "NOT_CONFIGURED",
      reasonCodes: reasons,
    };
  }
  return {
    valid: true,
    mode: "txline",
    demoMode: false,
    network: "devnet",
    apiOrigin: TXLINE_DEVNET_ORIGIN,
    apiToken: env.TXLINE_API_TOKEN!.trim(),
    solanaRpcUrl: SOLANA_DEVNET_RPC,
    enableRealExecution: false,
    enableWalletOperations: false,
    enableTxoddsActivation: false,
  };
}

export function invalidConfigStatus(config: InvalidDataConfig) {
  return {
    status: config.status,
    display: "TxODDS configuration invalid",
    mode: config.mode,
    network: null,
    readOnly: true,
    reasonCodes: [...config.reasonCodes],
  };
}
