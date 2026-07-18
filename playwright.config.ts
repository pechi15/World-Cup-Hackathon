import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: /browser-smoke\.spec\.ts/,
  webServer: [
    {
      command: "npm.cmd run dev:api",
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
