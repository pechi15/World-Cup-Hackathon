import { describe, expect, it } from "vitest";
import { fractionalKelly, type KellyInput } from "../packages/strategies/src/index.js";

function binaryInput(overrides: Partial<KellyInput> = {}): KellyInput {
  return {
    modelProbability: 0.6,
    executable: { kind: "BINARY_CONTRACT", price: 0.5, side: "BUY", priceSource: "ASK" },
    bankroll: 1_000,
    kellyFraction: 0.25,
    maximumBankrollFraction: 0.2,
    fees: 0,
    slippage: 0,
    independentTheoStatus: "AVAILABLE",
    calibration: { status: "CALIBRATED", method: "held-out reliability", sampleSize: 1_000 },
    theoMode: "research",
    caps: { selection: 1_000, market: 1_000, fixture: 1_000, portfolioWorstCaseLoss: 1_000 },
    ...overrides,
  };
}

describe("guarded fractional Kelly", () => {
  it("returns zero when independent p equals the executable contract price", () => {
    const result = fractionalKelly(binaryInput({ modelProbability: 0.5 }));
    expect(result).toMatchObject({ status: "NO_EDGE", size: 0, fraction: 0, fullKelly: 0 });
  });

  it("returns zero for a negative edge", () => {
    const result = fractionalKelly(binaryInput({ modelProbability: 0.49 }));
    expect(result.status).toBe("NO_EDGE");
    expect(result.size).toBe(0);
    expect(result.estimatedEdge).toBeLessThan(0);
  });

  it("returns null when independent theo is unavailable", () => {
    const result = fractionalKelly(binaryInput({ modelProbability: null, independentTheoStatus: "UNAVAILABLE" }));
    expect(result).toMatchObject({ status: "THEO_UNAVAILABLE", size: null, fraction: null });
  });

  it("returns null when calibration metadata is unavailable", () => {
    const result = fractionalKelly(binaryInput({ calibration: null }));
    expect(result).toMatchObject({ status: "CALIBRATION_UNAVAILABLE", size: null, fraction: null });
  });

  it("applies the fractional multiplier to the binary full-Kelly identity", () => {
    const result = fractionalKelly(binaryInput());
    expect(result.fullKelly).toBeCloseTo((0.6 - 0.5) / (1 - 0.5), 12);
    expect(result.fraction).toBeCloseTo(0.25 * 0.2, 12);
    expect(result.stake).toBeCloseTo(50, 12);
    expect(result.quantity).toBeCloseTo(100, 12);
  });

  it("implements the decimal-odds Kelly identity", () => {
    const result = fractionalKelly(binaryInput({
      modelProbability: 0.55,
      executable: { kind: "DECIMAL_ODDS", decimalOdds: 2, priceSource: "ASK" },
    }));
    expect(result.fullKelly).toBeCloseTo((0.55 * 2 - 1) / (2 - 1), 12);
    expect(result.stake).toBeCloseTo(25, 12);
  });

  it("enforces maximum bankroll, selection, market, fixture, and portfolio caps", () => {
    const capCases: Array<[keyof KellyInput["caps"] | "maximumBankrollFraction", Partial<KellyInput>]> = [
      ["maximumBankrollFraction", { maximumBankrollFraction: 0.01 }],
      ["selection", { caps: { selection: 9, market: 1_000, fixture: 1_000, portfolioWorstCaseLoss: 1_000 } }],
      ["market", { caps: { selection: 1_000, market: 8, fixture: 1_000, portfolioWorstCaseLoss: 1_000 } }],
      ["fixture", { caps: { selection: 1_000, market: 1_000, fixture: 7, portfolioWorstCaseLoss: 1_000 } }],
      ["portfolioWorstCaseLoss", { caps: { selection: 1_000, market: 1_000, fixture: 1_000, portfolioWorstCaseLoss: 6 } }],
    ];
    for (const [limitingCap, overrides] of capCases) {
      const result = fractionalKelly(binaryInput(overrides));
      expect(result.limitingCap).toBe(limitingCap);
    }
  });

  it("fees and slippage reduce Kelly size", () => {
    const withoutCosts = fractionalKelly(binaryInput());
    const withCosts = fractionalKelly(binaryInput({ fees: 0.01, slippage: 0.01 }));
    expect(withCosts.stake).toBeLessThan(withoutCosts.stake!);
    expect(withCosts.effectivePriceOrOdds).toBeCloseTo(0.52, 12);
  });

  it("never permits a runtime fraction above quarter Kelly", () => {
    const result = fractionalKelly(binaryInput({ kellyFraction: 1 }));
    expect(result.fraction).toBeCloseTo(0.05, 12);
    expect(result.reasonCodes).toContain("KELLY_FRACTION_CAPPED_AT_QUARTER");
  });

  it("cannot invoke Kelly in market-baseline mode", () => {
    const result = fractionalKelly(binaryInput({ theoMode: "market_baseline" }));
    expect(result).toMatchObject({ status: "DISABLED_NON_INDEPENDENT_THEO", size: null });
    expect(result.reasonCodes).toEqual([
      "INDEPENDENT_THEO_UNAVAILABLE",
      "MARKET_BASELINE_IS_NOT_ALPHA",
      "KELLY_DISABLED",
    ]);
  });

  it("correlated portfolio worst-case loss overrides individual Kelly", () => {
    const result = fractionalKelly(binaryInput({
      caps: { selection: 500, market: 500, fixture: 500, portfolioWorstCaseLoss: 3 },
    }));
    expect(result).toMatchObject({ status: "AVAILABLE", stake: 3, limitingCap: "portfolioWorstCaseLoss" });
  });

  it("uses the executable bid for a sell by sizing the complementary contract", () => {
    const result = fractionalKelly(binaryInput({
      modelProbability: 0.4,
      executable: { kind: "BINARY_CONTRACT", price: 0.5, side: "SELL", priceSource: "BID" },
    }));
    expect(result.fullKelly).toBeCloseTo((0.6 - 0.5) / (1 - 0.5), 12);
    expect(result.status).toBe("AVAILABLE");
  });
});
