import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("frontend demo source", () => {
  it("renders required dashboard labels and disclaimer", () => {
    const source = readFileSync("apps/web/src/App.tsx", "utf8");
    expect(source).toContain("Run Full Demo");
    expect(source).toContain("Market Board");
    expect(source).toContain("Risk Sheet");
    expect(source).toContain("Audit Trail");
    expect(source).toContain("Backend disconnected");
    expect(source).toContain("PAPER MARKET MAKING");
    expect(source).toContain("MARKET CONSENSUS BASELINE");
    expect(source).toContain("Maker Fill History");
    expect(source).toContain("LIVE TXLINE INPUT");
    expect(source).toContain("CURRENT FIXTURE");
    expect(source).toContain("AUTONOMOUS AGENT");
    expect(source).toContain("Maker Bee + Forager Bee");
    expect(source).toContain("Hive Risk Engine");
    expect(source).toContain("LATEST DECISION");
    expect(source).toContain("LATEST QUOTE");
    expect(source).toContain("LATEST POSITION");
    expect(source).toContain("SHADOW EXECUTION");
    expect(source).toContain("REAL FUNDS DISABLED");
  });
});
