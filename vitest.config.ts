import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: {
      DATA_MODE: "replay",
      DEMO_MODE: "true",
      THEO_MODE: "market_baseline",
      TRADING_MODE: "paper",
      ENABLE_REAL_EXECUTION: "false",
      ENABLE_WALLET_OPERATIONS: "false",
      ENABLE_TXODDS_ACTIVATION: "false",
    },
  },
});
