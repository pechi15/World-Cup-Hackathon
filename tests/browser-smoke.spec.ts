import { test, expect } from "@playwright/test";

test("dashboard completes the maker-only replay lifecycle", async ({ page, request }) => {
  test.setTimeout(45_000);
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const ready = await request.get(process.env.DEMO_API_URL ?? "http://127.0.0.1:8790/ready");
  expect(ready.ok()).toBe(true);
  await expect(ready.json()).resolves.toMatchObject({ ready: true, mode: "replay" });

  await page.goto(process.env.DEMO_WEB_URL ?? "http://127.0.0.1:5174");
  await expect(page.getByRole("heading", { name: "World Cup market-consensus market maker" })).toBeVisible();
  await expect(page.locator(".status-bar")).toContainText("CONNECTED");

  const marketBoard = page.getByRole("heading", { name: "Market Board" }).locator("..");
  const makerAgent = page.locator(".maker-agent");
  const foragerAgent = page.locator(".forager-agent");
  const positions = page.getByRole("heading", { name: "Positions" }).locator("..");
  const riskSheet = page.getByRole("heading", { name: "Risk Sheet" }).locator("..");
  const performance = page.getByRole("heading", { name: "Performance" }).locator("..");
  const fillHistory = page.getByRole("heading", { name: "Maker Fill History" }).locator("..");
  const auditTrail = page.getByRole("heading", { name: "Audit Trail" }).locator("..");
  await expect(makerAgent).toContainText("PAPER EXECUTION");
  await expect(makerAgent).toContainText("Latest action");
  await expect(makerAgent).toContainText("Bid / Ask");
  await expect(makerAgent).toContainText("Inventory lean");
  await expect(makerAgent).toContainText("QUOTING");
  await expect(foragerAgent).toContainText("HEURISTIC SIGNAL");
  await expect(foragerAgent).toContainText("Paper position");
  await expect(foragerAgent).toContainText("Abstention reason");
  const replaySources = page.getByLabel("Replay source");
  await expect(replaySources.locator("option")).toHaveCount(3);
  await expect(replaySources).toContainText("Live Argentina–Spain (unavailable)");
  await expect(replaySources).toContainText("Historical England–France");
  await expect(replaySources).toContainText("Built-in deterministic fallback");
  const initialRisk = await riskSheet.textContent();
  const initialPerformance = await performance.textContent();

  await page.getByRole("button", { name: /Run Full Demo/i }).click();
  await expect(page.locator(".status-bar")).toContainText("RUNNING @ 1x");

  await page.getByRole("button", { name: /Inject information shock/i }).click();
  await expect(page.getByText(/INFO_SHOCK #/)).toBeVisible();
  await expect(auditTrail).toContainText("INFORMATION_SHOCK_REPRICE");

  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.locator(".status-bar")).toContainText("READY @ 1x");
  await expect(auditTrail.locator("article")).toHaveCount(0);

  await page.getByRole("button", { name: /Run Full Demo/i }).click();
  await page.getByRole("button", { name: "5x" }).click();
  await expect(positions).not.toContainText("No current inventory", { timeout: 12_000 });
  await expect(marketBoard).toContainText("LIVE");
  await expect(fillHistory).not.toContainText("Zero fills");
  await expect(auditTrail).toContainText("PAPER_MAKER_FILL");
  await expect(makerAgent).toContainText("QUOTING");
  expect(await riskSheet.textContent()).not.toBe(initialRisk);
  expect(await performance.textContent()).not.toBe(initialPerformance);

  await page.getByRole("button", { name: "60x" }).click();
  await expect(page.locator(".status-bar")).toContainText("COMPLETE @ 60x", { timeout: 30_000 });

  await expect(marketBoard).toContainText("LIVE");
  await expect(fillHistory).not.toContainText("Zero fills");
  await expect(auditTrail.locator("article")).not.toHaveCount(0);
  await expect(page.getByText(/SETTLEMENT #/)).toBeVisible();
  expect(await performance.textContent()).not.toBe(initialPerformance);

  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.locator(".status-bar")).toContainText("READY @ 1x");
  await expect(positions).toContainText("No current inventory");
  await expect(fillHistory).toContainText("Zero fills");
  await expect(auditTrail.locator("article")).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});
