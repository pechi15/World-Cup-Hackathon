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
  });
});
