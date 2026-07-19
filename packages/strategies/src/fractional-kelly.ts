export type IndependentTheoStatus = "AVAILABLE" | "UNAVAILABLE" | "NON_INDEPENDENT";

export type CalibrationStatus = {
  status: "CALIBRATED" | "UNAVAILABLE";
  method?: string;
  sampleSize?: number;
  asOf?: string;
};

export type ExecutableKellyPrice =
  | {
      kind: "DECIMAL_ODDS";
      decimalOdds: number;
      priceSource: "ASK";
    }
  | {
      kind: "BINARY_CONTRACT";
      price: number;
      side: "BUY";
      priceSource: "ASK";
    }
  | {
      kind: "BINARY_CONTRACT";
      price: number;
      side: "SELL";
      priceSource: "BID";
    };

export type KellyCaps = {
  selection: number;
  market: number;
  fixture: number;
  portfolioWorstCaseLoss: number;
};

export type KellyInput = {
  modelProbability: number | null;
  executable: ExecutableKellyPrice;
  bankroll: number;
  kellyFraction: number;
  maximumBankrollFraction: number;
  fees: number;
  slippage: number;
  independentTheoStatus: IndependentTheoStatus;
  calibration: CalibrationStatus | null;
  theoMode: string;
  caps: KellyCaps;
};

export type KellyResult = {
  size: number | null;
  stake: number | null;
  quantity: number | null;
  fraction: number | null;
  fullKelly: number | null;
  estimatedEdge: number | null;
  effectivePriceOrOdds: number | null;
  status:
    | "AVAILABLE"
    | "NO_EDGE"
    | "THEO_UNAVAILABLE"
    | "CALIBRATION_UNAVAILABLE"
    | "DISABLED_NON_INDEPENDENT_THEO"
    | "INVALID_INPUT";
  limitingCap: keyof KellyCaps | "maximumBankrollFraction" | null;
  reasonCodes: string[];
};

const nullResult = (
  status: "THEO_UNAVAILABLE" | "CALIBRATION_UNAVAILABLE" | "DISABLED_NON_INDEPENDENT_THEO",
  reasonCode: string,
): KellyResult => ({
  size: null,
  stake: null,
  quantity: null,
  fraction: null,
  fullKelly: null,
  estimatedEdge: null,
  effectivePriceOrOdds: null,
  status,
  limitingCap: null,
  reasonCodes: [reasonCode],
});

const invalidResult = (reasonCode: string): KellyResult => ({
  size: 0,
  stake: 0,
  quantity: 0,
  fraction: null,
  fullKelly: null,
  estimatedEdge: null,
  effectivePriceOrOdds: null,
  status: "INVALID_INPUT",
  limitingCap: null,
  reasonCodes: [reasonCode],
});

/**
 * Guarded single-opportunity fractional Kelly calculation.
 *
 * This utility does not place orders. Simultaneous/correlated opportunities are
 * bounded by externally calculated market, fixture, and portfolio worst-case
 * loss budgets. The runtime fraction is hard-limited to quarter Kelly.
 */
export function fractionalKelly(input: KellyInput): KellyResult {
  if (input.theoMode.trim().toLowerCase() === "market_baseline") {
    return nullResult("DISABLED_NON_INDEPENDENT_THEO", "KELLY_DISABLED_NON_INDEPENDENT_THEO");
  }
  if (input.independentTheoStatus === "NON_INDEPENDENT") {
    return nullResult("DISABLED_NON_INDEPENDENT_THEO", "KELLY_DISABLED_NON_INDEPENDENT_THEO");
  }
  if (input.independentTheoStatus !== "AVAILABLE" || input.modelProbability === null) {
    return nullResult("THEO_UNAVAILABLE", "INDEPENDENT_THEO_UNAVAILABLE");
  }
  if (!input.calibration || input.calibration.status !== "CALIBRATED") {
    return nullResult("CALIBRATION_UNAVAILABLE", "CALIBRATION_METADATA_UNAVAILABLE");
  }

  const p = input.modelProbability;
  const capEntries = Object.entries(input.caps) as Array<[keyof KellyCaps, number]>;
  if (
    !Number.isFinite(p) || p < 0 || p > 1
    || !Number.isFinite(input.bankroll) || input.bankroll <= 0
    || !Number.isFinite(input.kellyFraction) || input.kellyFraction < 0
    || !Number.isFinite(input.maximumBankrollFraction) || input.maximumBankrollFraction < 0 || input.maximumBankrollFraction > 1
    || !Number.isFinite(input.fees) || input.fees < 0
    || !Number.isFinite(input.slippage) || input.slippage < 0
    || capEntries.some(([, cap]) => !Number.isFinite(cap) || cap < 0)
  ) return invalidResult("INVALID_KELLY_INPUT");

  let sideProbability = p;
  let effective: number;
  let fullKelly: number;
  let edge: number;
  let quantityDenominator = 1;

  if (input.executable.kind === "DECIMAL_ODDS") {
    if (input.executable.priceSource !== "ASK" || !Number.isFinite(input.executable.decimalOdds) || input.executable.decimalOdds <= 1) {
      return invalidResult("EXECUTABLE_DECIMAL_ASK_REQUIRED");
    }
    effective = input.executable.decimalOdds - input.fees - input.slippage;
    if (effective <= 1) return invalidResult("NON_POSITIVE_NET_DECIMAL_ODDS");
    edge = p * effective - 1;
    fullKelly = edge / (effective - 1);
  } else {
    const executablePrice = input.executable.price;
    if (!Number.isFinite(executablePrice) || executablePrice <= 0 || executablePrice >= 1) return invalidResult("INVALID_EXECUTABLE_CONTRACT_PRICE");
    if (input.executable.side === "BUY") {
      if (input.executable.priceSource !== "ASK") return invalidResult("EXECUTABLE_ASK_REQUIRED_FOR_BUY");
      effective = executablePrice + input.fees + input.slippage;
    } else {
      if (input.executable.priceSource !== "BID") return invalidResult("EXECUTABLE_BID_REQUIRED_FOR_SELL");
      sideProbability = 1 - p;
      effective = 1 - executablePrice + input.fees + input.slippage;
    }
    if (effective <= 0 || effective >= 1) return invalidResult("INVALID_NET_CONTRACT_PRICE");
    edge = sideProbability - effective;
    fullKelly = edge / (1 - effective);
    quantityDenominator = effective;
  }

  if (edge <= 0 || fullKelly <= 0) {
    return {
      size: 0,
      stake: 0,
      quantity: 0,
      fraction: 0,
      fullKelly,
      estimatedEdge: edge,
      effectivePriceOrOdds: effective,
      status: "NO_EDGE",
      limitingCap: null,
      reasonCodes: ["NON_POSITIVE_EDGE"],
    };
  }

  const runtimeKellyFraction = Math.min(input.kellyFraction, 0.25);
  const reasons = input.kellyFraction > 0.25 ? ["KELLY_FRACTION_CAPPED_AT_QUARTER"] : [];
  const fraction = Math.max(0, fullKelly * runtimeKellyFraction);
  const candidates: Array<[keyof KellyCaps | "maximumBankrollFraction", number]> = [
    ["maximumBankrollFraction", input.bankroll * input.maximumBankrollFraction],
    ...capEntries,
  ];
  const [limitingCap, hardCap] = candidates.reduce((minimum, candidate) => candidate[1] < minimum[1] ? candidate : minimum);
  const uncappedStake = input.bankroll * fraction;
  const stake = Math.max(0, Math.min(uncappedStake, hardCap));
  if (stake < uncappedStake) reasons.push(`KELLY_CAPPED_BY_${limitingCap}`);
  return {
    size: stake,
    stake,
    quantity: stake / quantityDenominator,
    fraction,
    fullKelly,
    estimatedEdge: edge,
    effectivePriceOrOdds: effective,
    status: "AVAILABLE",
    limitingCap: stake < uncappedStake ? limitingCap : null,
    reasonCodes: reasons,
  };
}
