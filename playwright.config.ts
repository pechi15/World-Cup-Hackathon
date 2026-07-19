import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: /browser-smoke\.spec\.ts/,
  webServer: [
    {
      command: "npm.cmd run dev:api",
      env: {
        DATA_MODE: "replay",
        DEMO_MODE: "true",
        THEO_MODE: "market_baseline",
        TRADING_MODE: "paper",
        ENABLE_REAL_EXECUTION: "false",
        ENABLE_WALLET_OPERATIONS: "false",
        ENABLE_TXODDS_ACTIVATION: "false",
      },
      url: "http://127.0.0.1:8787/ready",
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: "npm.cmd run dev:web",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
  use: {
    headless: true,
  },
});
