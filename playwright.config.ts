import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: /browser-smoke\.spec\.ts/,
  webServer: [
    {
      command: "npm.cmd run dev:api",
      env: {
        PORT: "8790",
        HOST: "127.0.0.1",
        DATA_MODE: "replay",
        DEMO_MODE: "true",
        THEO_MODE: "market_baseline",
        TRADING_MODE: "paper",
        ENABLE_REAL_EXECUTION: "false",
        ENABLE_WALLET_OPERATIONS: "false",
        ENABLE_TXODDS_ACTIVATION: "false",
        ALLOWED_ORIGINS: "http://127.0.0.1:5174",
      },
      url: "http://127.0.0.1:8790/ready",
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: "npm.cmd run dev:web -- --port 5174 --strictPort",
      env: {
        VITE_API_BASE_URL: "http://127.0.0.1:8790",
      },
      url: "http://127.0.0.1:5174",
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
  use: {
    headless: true,
  },
});
