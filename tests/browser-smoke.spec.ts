import { test, expect } from "@playwright/test";

test("dashboard can run the deterministic demo", async ({ page }) => {
  await page.goto(process.env.DEMO_WEB_URL ?? "http://localhost:5173");
  await expect(page.getByText("World Cup market-consensus market maker")).toBeVisible();
  await expect(page.getByText("Backend")).toBeVisible();
  await page.getByRole("button", { name: /Run Full Demo/i }).click();
  await expect(page.getByText("Market Board")).toBeVisible();
  await expect(page.getByText("Audit Trail")).toBeVisible();
  await expect(page.getByText("TXODDS_MARKET_BASELINE").first()).toBeVisible();
});
