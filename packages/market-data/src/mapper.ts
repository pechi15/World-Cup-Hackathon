/** TxLINE → internal contract mappers (odds updates shaped like /api/odds/updates). */

import type { Fixture, MarketDefinition, MarketPrice, MarketTick, Provenance, Source } from "../../contracts/src/index.js";

export type TxlineOddsUpdate = {
  FixtureId: number;
  MessageId?: string;
  Ts: number;
  Bookmaker?: string;
  BookmakerId?: number;
  SuperOddsType: string;
  GameState?: number | null;
  InRunning?: boolean;
  MarketParameters?: string;
  MarketPeriod?: string;
  PriceNames: string[];
  Prices: number[];
  Pct?: string[];
  /** TxLINE consensus probability, when supplied by an authenticated payload. */
  StablePrice?: number[];
};

export type TxlineProbabilityField = "PRICES_DECIMAL" | "STABLE_PRICE";
export type DemarginingStatus = "VERIFIED_RAW_REQUIRES_DEVIG" | "VERIFIED_ALREADY_DEMARGINED";

export type SelectedMarketProbabilities = {
  probabilities: number[];
  field: TxlineProbabilityField;
  demarginingStatus: DemarginingStatus;
  reasonCodes: string[];
};

export type TxlineFixtureRow = {
  FixtureId: number;
  CompetitionId?: number;
  Competition?: string;
  Participant1Id?: number;
  Participant1?: string;
  Participant2Id?: number;
  Participant2?: string;
  Participant1IsHome?: boolean;
  StartTime?: number;
  Ts?: number;
  GameState?: number;
};

const provenance = (source: Source, notes?: string): Provenance => ({
  source,
  notes: notes ?? "Mapped from TxLINE-shaped payload; not fabricated live production theo.",
});

export function decimalOddsToImplied(odds: number): number {
  if (!Number.isFinite(odds) || odds <= 1) return 0;
  return 1 / odds;
}

export function proportionalDevig(
  implied: number[],
  semantics: "RAW_BOOK_IMPLIED" | "ALREADY_DEMARGINED",
): number[] {
  if (semantics === "ALREADY_DEMARGINED") {
    throw new Error("DOUBLE_DEVIG_FORBIDDEN: already de-margined probabilities must not be de-vigged");
  }
  const sum = implied.reduce((a, b) => a + b, 0);
  if (sum <= 0) return implied.map(() => 0);
  return implied.map((p) => p / sum);
}

function numericalProbabilityCleanup(probabilities: number[], tolerance = 0.02): number[] {
  if (probabilities.length === 0 || probabilities.some((p) => !Number.isFinite(p) || p < 0 || p > 1)) {
    throw new Error("INVALID_DEMARGINED_PROBABILITIES");
  }
  const mass = probabilities.reduce((sum, probability) => sum + probability, 0);
  if (Math.abs(mass - 1) > tolerance) {
    throw new Error(`INVALID_DEMARGINED_PROBABILITY_MASS:${mass}`);
  }
  // This is numerical cleanup, not a second margin-removal transformation.
  return probabilities.map((probability) => probability / mass);
}

function isTxlineDemarginedStablePrice(update: TxlineOddsUpdate): boolean {
  return update.Bookmaker?.trim().toLowerCase() === "txlinestablepricedemargined";
}

function decodeTxlineDecimalOdds(price: number): number {
  // Authenticated history currently represents StablePrice decimal odds as
  // integer milliodds (3276 => 3.276). Raw Prices remain untouched in storage.
  return Number.isInteger(price) && price >= 1_000 ? price / 1_000 : price;
}

/**
 * Selects and verifies the probability semantics before any model sees the data.
 *
 * StablePrice is documented by TxLINE as already de-margined and receives only
 * bounded numerical cleanup. Raw decimal Prices are converted to implied
 * probabilities and de-vigged exactly once. Pct is preserved in raw storage but
 * is not selected because its probability semantics are not verified.
 */
export function selectMarketProbabilities(update: TxlineOddsUpdate): SelectedMarketProbabilities {
  if (update.PriceNames.length === 0) {
    throw new Error("EMPTY_MARKET_SELECTIONS");
  }
  if (update.StablePrice !== undefined) {
    if (update.StablePrice.length !== update.PriceNames.length) {
      throw new Error("STABLE_PRICE_SELECTION_COUNT_MISMATCH");
    }
    return {
      probabilities: numericalProbabilityCleanup(update.StablePrice),
      field: "STABLE_PRICE",
      demarginingStatus: "VERIFIED_ALREADY_DEMARGINED",
      reasonCodes: ["STABLE_PRICE_ALREADY_DEMARGINED", "DOUBLE_DEVIG_SKIPPED", "PCT_NOT_SELECTED_UNVERIFIED"],
    };
  }

  if (update.Prices.length !== update.PriceNames.length) {
    throw new Error("PRICES_SELECTION_COUNT_MISMATCH");
  }
  if (isTxlineDemarginedStablePrice(update)) {
    const impliedStable = update.Prices.map((price) => decimalOddsToImplied(decodeTxlineDecimalOdds(price)));
    if (impliedStable.some((probability) => probability <= 0)) throw new Error("INVALID_STABLE_PRICE_DECIMAL_ODDS");
    return {
      probabilities: numericalProbabilityCleanup(impliedStable),
      field: "STABLE_PRICE",
      demarginingStatus: "VERIFIED_ALREADY_DEMARGINED",
      reasonCodes: [
        "TXLINE_STABLE_PRICE_DEMARGINED_SOURCE_VERIFIED",
        "MILLIODDS_DECODED_WHEN_PRESENT",
        "DOUBLE_DEVIG_SKIPPED",
        "PCT_NOT_SELECTED_UNVERIFIED",
      ],
    };
  }
  const implied = update.Prices.map((price) => decimalOddsToImplied(decodeTxlineDecimalOdds(price)));
  if (implied.some((probability) => probability <= 0)) {
    throw new Error("INVALID_RAW_DECIMAL_PRICE");
  }
  return {
    probabilities: proportionalDevig(implied, "RAW_BOOK_IMPLIED"),
    field: "PRICES_DECIMAL",
    demarginingStatus: "VERIFIED_RAW_REQUIRES_DEVIG",
    reasonCodes: ["PRICES_DECIMAL_SELECTED", "DEVIG_APPLIED_ONCE", "PCT_NOT_SELECTED_UNVERIFIED"],
  };
}

export function marketKey(update: TxlineOddsUpdate): string {
  const params = update.MarketParameters ?? "";
  const period = update.MarketPeriod ?? "FULL_MATCH";
  return `${update.FixtureId}:${update.SuperOddsType}:${params}:${period}`;
}

export function mapSuperOddsType(superOddsType: string): MarketDefinition["marketType"] {
  const t = superOddsType.toUpperCase();
  if (t.includes("1X2") || t.includes("MATCH_RESULT") || t.includes("MATCHODDS") || t === "THREE_WAY") {
    return "THREE_WAY_MATCH_RESULT";
  }
  if (t.includes("TOTAL") || t.includes("OVER_UNDER") || t.includes("OU")) return "TOTALS";
  if (t.includes("HANDICAP") || t.includes("SPREAD") || t.includes("AH")) return "HANDICAP";
  if (t.includes("BTTS") || t.includes("BOTH_TEAMS")) return "BOTH_TEAMS_TO_SCORE";
  return "BINARY_YES_NO";
}

function outcomeTypeForName(name: string, marketType: MarketDefinition["marketType"]): MarketDefinition["selections"][number]["outcomeType"] {
  const n = name.toLowerCase();
  if (n.includes("home") || n === "1" || n === "h") return "HOME";
  if (n.includes("away") || n === "2" || n === "a") return "AWAY";
  if (n.includes("draw") || n === "x") return "DRAW";
  if (n.includes("over")) return "OVER";
  if (n.includes("under")) return "UNDER";
  if (n.includes("yes")) return "YES";
  if (n.includes("no")) return "NO";
  if (marketType === "THREE_WAY_MATCH_RESULT") return "OTHER";
  return "OTHER";
}

export function mapFixture(row: TxlineFixtureRow, source: Source = "REPLAY"): Fixture {
  const homeIsP1 = row.Participant1IsHome !== false;
  return {
    fixtureId: String(row.FixtureId),
    competitionId: String(row.CompetitionId ?? "txline"),
    homeTeamId: String(homeIsP1 ? row.Participant1Id ?? "home" : row.Participant2Id ?? "home"),
    awayTeamId: String(homeIsP1 ? row.Participant2Id ?? "away" : row.Participant1Id ?? "away"),
    startTime: row.StartTime ? new Date(row.StartTime).toISOString() : undefined,
    status: row.GameState != null ? String(row.GameState) : "UNKNOWN",
    provenance: provenance(source, `TxLINE fixture ${row.FixtureId}`),
  };
}

export function mapOddsUpdateToMarket(update: TxlineOddsUpdate, source: Source = "REPLAY"): MarketDefinition {
  const marketId = marketKey(update);
  const marketType = mapSuperOddsType(update.SuperOddsType);
  const now = new Date(update.Ts).toISOString();
  let line: number | undefined;
  try {
    const parsed = update.MarketParameters ? JSON.parse(update.MarketParameters) : null;
    if (parsed && typeof parsed === "object" && "line" in parsed) line = Number((parsed as { line: number }).line);
    else if (update.MarketParameters && !Number.isNaN(Number(update.MarketParameters))) line = Number(update.MarketParameters);
  } catch {
    if (update.MarketParameters && !Number.isNaN(Number(update.MarketParameters))) line = Number(update.MarketParameters);
  }
  const selections = update.PriceNames.map((name, index) => {
    const selectionId = `${marketId}:${index}:${name}`.replace(/\s+/g, "_");
    return {
      marketId,
      selectionId,
      label: name,
      outcomeType: outcomeTypeForName(name, marketType),
      externalIds: { priceIndex: String(index), bookmakerId: String(update.BookmakerId ?? "") },
      provenance: provenance(source),
    };
  });
  return {
    marketId,
    fixtureId: String(update.FixtureId),
    competitionId: "txline",
    marketType,
    title: `${update.SuperOddsType} ${update.MarketParameters ?? ""}`.trim(),
    description: `Mapped from TxLINE SuperOddsType=${update.SuperOddsType}`,
    parameters: { line, period: update.MarketPeriod ?? "FULL_MATCH" },
    period: update.MarketPeriod ?? "FULL_MATCH",
    selections,
    settlementRules: [
      {
        ruleId: `${marketId}-rule`,
        marketType,
        parameters: { line, period: update.MarketPeriod ?? "FULL_MATCH" },
        description: "Settlement via score scenario when available.",
        provenance: provenance(source),
      },
    ],
    status: "OPEN",
    provenance: provenance(source, update.InRunning ? "in-running" : "pre-match"),
    createdAt: now,
    updatedAt: now,
  };
}

export function mapOddsUpdateToTicks(update: TxlineOddsUpdate, source: Source = "REPLAY"): MarketTick[] {
  const market = mapOddsUpdateToMarket(update, source);
  const selected = selectMarketProbabilities(update);
  const ts = new Date(update.Ts).toISOString();
  return market.selections.map((selection, index) => {
    const mid = selected.probabilities[index] ?? null;
    return {
      tickId: `${update.MessageId ?? update.Ts}:${selection.selectionId}`,
      marketId: market.marketId,
      selectionId: selection.selectionId,
      bid: mid,
      ask: mid,
      mid,
      last: mid,
      timestamp: ts,
      sequenceId: update.MessageId ?? null,
      provenance: provenance(
        source,
        `bookmaker=${update.Bookmaker ?? "unknown"}; probabilityField=${selected.field}; demargining=${selected.demarginingStatus}`,
      ),
    };
  });
}

export function ticksToPrices(ticks: MarketTick[]): MarketPrice[] {
  return ticks.map(({ tickId: _tickId, ...price }) => price);
}

export function parseDecimalLineFromParameters(marketParameters?: string): number | undefined {
  if (!marketParameters) return undefined;
  try {
    const parsed = JSON.parse(marketParameters) as { line?: number };
    if (typeof parsed.line === "number") return parsed.line;
  } catch {
    const n = Number(marketParameters);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}
