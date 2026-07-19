import { describe, expect, it } from "vitest";
import {
  resolveDataRuntimeConfig,
  TxlineReadOnlyAdapter,
  type FetchLike,
} from "../packages/market-data/src/index.js";
import { ProductRuntime } from "../apps/api/src/product-runtime.js";

function liveEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    DATA_MODE: "txline",
    DEMO_MODE: "false",
    TXLINE_NETWORK: "devnet",
    TXLINE_API_ORIGIN: "https://txline-dev.txodds.com",
    TXLINE_API_TOKEN: "backend-only-token",
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
    ENABLE_REAL_EXECUTION: "false",
    ENABLE_WALLET_OPERATIONS: "false",
    ENABLE_TXODDS_ACTIVATION: "false",
    ...overrides,
  };
}

describe("two-mode runtime configuration", () => {
  it("accepts the exact replay mode", () => {
    expect(resolveDataRuntimeConfig({
      DATA_MODE: "replay",
      DEMO_MODE: "true",
      ENABLE_REAL_EXECUTION: "false",
      ENABLE_WALLET_OPERATIONS: "false",
      ENABLE_TXODDS_ACTIVATION: "false",
    })).toMatchObject({ valid: true, mode: "replay", demoMode: true });
  });

  it("accepts configured live read-only devnet without a static guest JWT", () => {
    const config = resolveDataRuntimeConfig(liveEnv());
    expect(config).toMatchObject({
      valid: true,
      mode: "txline",
      network: "devnet",
      enableRealExecution: false,
      enableWalletOperations: false,
      enableTxoddsActivation: false,
    });
    expect("guestJwt" in config).toBe(false);
  });

  it("never falls back from an invalid txline request to replay", () => {
    const config = resolveDataRuntimeConfig(liveEnv({ TXLINE_API_TOKEN: undefined }));
    expect(config).toMatchObject({ valid: false, mode: "txline", status: "AWAITING_CREDENTIALS" });
    if (config.valid) throw new Error("expected invalid txline config");
    expect(config.reasonCodes).toContain("MISSING_TXLINE_API_TOKEN");
  });

  it("does not report maker pricing ready when market-baseline mode is disabled", () => {
    const runtime = new ProductRuntime({
      DATA_MODE: "replay",
      DEMO_MODE: "true",
      ENABLE_REAL_EXECUTION: "false",
      ENABLE_WALLET_OPERATIONS: "false",
      ENABLE_TXODDS_ACTIVATION: "false",
    });
    expect(runtime.baselineConfig).toMatchObject({ enabled: false, valid: true });
    expect(runtime.theoStatus()).toMatchObject({ status: "UNAVAILABLE" });
    expect(runtime.tradingStatus()).toMatchObject({ maker: "DISABLED" });
  });
});

describe("ephemeral guest authentication", () => {
  it("obtains a fresh guest JWT before using the backend API token", async () => {
    const calls: Array<{ url: string; authorization: string | null; apiToken: string | null }> = [];
    const fetcher: FetchLike = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, authorization: headers.get("authorization"), apiToken: headers.get("x-api-token") });
      if (url.endsWith("/auth/guest/start")) return Response.json({ token: "ephemeral-guest-one" });
      return Response.json([]);
    };
    const config = resolveDataRuntimeConfig(liveEnv());
    if (!config.valid || config.mode !== "txline") throw new Error("expected live config");
    const adapter = new TxlineReadOnlyAdapter(config, fetcher);
    await adapter.connect();
    expect(calls[0]).toMatchObject({ url: "https://txline-dev.txodds.com/auth/guest/start", authorization: null, apiToken: null });
    expect(calls[1]).toMatchObject({ authorization: "Bearer ephemeral-guest-one", apiToken: "backend-only-token" });
    expect(adapter.getSystemDataStatus().credentials).toEqual({ apiToken: "configured", guestJwt: "ephemeral-active" });
  });

  it("renews the guest JWT once after HTTP 401", async () => {
    let authCalls = 0;
    let apiCalls = 0;
    const authorizations: string[] = [];
    const fetcher: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) {
        authCalls += 1;
        return Response.json({ token: `ephemeral-${authCalls}` });
      }
      apiCalls += 1;
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return apiCalls === 1 ? new Response(null, { status: 401 }) : Response.json([]);
    };
    const config = resolveDataRuntimeConfig(liveEnv());
    if (!config.valid || config.mode !== "txline") throw new Error("expected live config");
    const adapter = new TxlineReadOnlyAdapter(config, fetcher);
    await adapter.connect();
    expect(authCalls).toBe(2);
    expect(authorizations).toEqual(["Bearer ephemeral-1", "Bearer ephemeral-2"]);
    expect(adapter.status).toBe("CONNECTED");
  });
});
