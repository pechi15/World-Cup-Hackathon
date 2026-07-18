import { z } from "zod";

export const SourceSchema = z.enum(["TXODDS", "SYNTHETIC", "REPLAY", "MANUAL_RESEARCH", "TEST_FIXTURE"]);
export type Source = z.infer<typeof SourceSchema>;

export const MarketTypeSchema = z.enum([
  "BINARY_YES_NO",
  "THREE_WAY_MATCH_RESULT",
  "TWO_WAY_MATCH_WINNER",
  "HANDICAP",
  "TOTALS",
  "TEAM_TOTALS",
  "BOTH_TEAMS_TO_SCORE",
  "TOURNAMENT_WINNER",
  "REACH_ROUND",
  "STAGE_OF_ELIMINATION",
  "GROUP_WINNER",
  "GROUP_QUALIFICATION",
  "CONTINENTAL_WINNER",
  "UNBEATEN_CHAMPION",
  "GOLDEN_BOOT",
  "PLAYER_TO_SCORE",
  "MOST_ASSISTS",
  "PLAYER_AWARDS",
  "TEAM_TOP_SCORER",
  "TEAM_TOURNAMENT_PERFORMANCE",
  "COMBINATION",
]);
export type MarketType = z.infer<typeof MarketTypeSchema>;

export const MarketStatusSchema = z.enum(["DRAFT", "OPEN", "SUSPENDED", "SETTLED", "CANCELLED"]);
export const OutcomeTypeSchema = z.enum(["YES", "NO", "HOME", "DRAW", "AWAY", "OVER", "UNDER", "TEAM", "PLAYER", "OTHER"]);
export const TheoStatusSchema = z.enum(["AVAILABLE", "AVAILABLE_BENCHMARK", "AWAITING_TXODDS_API", "INSUFFICIENT_DATA", "STALE", "MODEL_ERROR", "UNSUPPORTED_MARKET"]);
export const QuoteStatusSchema = z.enum(["LIVE", "QUOTING_DISABLED", "LIMIT_BLOCKED", "MARKET_CLOSED"]);
export const StrategyActionSchema = z.enum(["BUY", "SELL", "HOLD", "NO_ACTION"]);
export const StrategyStatusSchema = z.enum(["READY", "THEO_UNAVAILABLE", "DISABLED", "LIMIT_BLOCKED", "MODEL_ERROR"]);
export const OrderStatusSchema = z.enum(["NEW", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED", "EXPIRED"]);
export const OrderSideSchema = z.enum(["BUY", "SELL"]);
export const ExecutionStyleSchema = z.enum(["MAKER", "TAKER"]);
export const TxoddsAdapterStatusSchema = z.enum(["NOT_CONFIGURED", "AWAITING_CREDENTIALS", "CONNECTING", "CONNECTED", "DEGRADED", "DISCONNECTED", "AUTH_EXPIRED"]);

export const ProvenanceSchema = z.object({
  source: SourceSchema,
  externalId: z.string().optional(),
  collectedAt: z.string().datetime().optional(),
  notes: z.string().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const TeamSchema = z.object({
  teamId: z.string(),
  name: z.string(),
  countryCode: z.string().optional(),
  provenance: ProvenanceSchema,
});
export type Team = z.infer<typeof TeamSchema>;

export const PlayerSchema = z.object({
  playerId: z.string(),
  name: z.string(),
  teamId: z.string().optional(),
  provenance: ProvenanceSchema,
});
export type Player = z.infer<typeof PlayerSchema>;

export const CompetitionSchema = z.object({
  competitionId: z.string(),
  name: z.string(),
  season: z.string().optional(),
  provenance: ProvenanceSchema,
});
export type Competition = z.infer<typeof CompetitionSchema>;

export const FixtureSchema = z.object({
  fixtureId: z.string(),
  competitionId: z.string(),
  homeTeamId: z.string(),
  awayTeamId: z.string(),
  startTime: z.string().datetime().optional(),
  status: z.string(),
  provenance: ProvenanceSchema,
});
export type Fixture = z.infer<typeof FixtureSchema>;

export const ScoreScenarioSchema = z.object({
  scenarioId: z.string(),
  fixtureId: z.string(),
  homeGoals: z.number().int().nonnegative(),
  awayGoals: z.number().int().nonnegative(),
  probability: z.number().min(0).max(1).nullable().optional(),
  provenance: ProvenanceSchema,
});
export type ScoreScenario = z.infer<typeof ScoreScenarioSchema>;

export const MarketParametersSchema = z.object({
  line: z.number().optional(),
  teamId: z.string().optional(),
  playerId: z.string().optional(),
  round: z.string().optional(),
  group: z.string().optional(),
  period: z.string().default("FULL_MATCH"),
  combinationLegs: z.array(z.string()).optional(),
}).passthrough();
export type MarketParameters = z.infer<typeof MarketParametersSchema>;

export const SettlementRuleSchema = z.object({
  ruleId: z.string(),
  marketType: MarketTypeSchema,
  parameters: MarketParametersSchema,
  description: z.string(),
  provenance: ProvenanceSchema,
});
export type SettlementRule = z.infer<typeof SettlementRuleSchema>;

export const MarketSelectionSchema = z.object({
  selectionId: z.string(),
  marketId: z.string(),
  label: z.string(),
  outcomeType: OutcomeTypeSchema,
  externalIds: z.record(z.string(), z.string()).optional(),
  provenance: ProvenanceSchema,
});
export type MarketSelection = z.infer<typeof MarketSelectionSchema>;

export const MarketDefinitionSchema = z.object({
  marketId: z.string(),
  fixtureId: z.string().optional(),
  competitionId: z.string(),
  marketType: MarketTypeSchema,
  title: z.string(),
  description: z.string(),
  parameters: MarketParametersSchema,
  period: z.string(),
  selections: z.array(MarketSelectionSchema).min(1),
  settlementRules: z.array(SettlementRuleSchema).min(1),
  status: MarketStatusSchema,
  provenance: ProvenanceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MarketDefinition = z.infer<typeof MarketDefinitionSchema>;
export type Market = MarketDefinition;

export const MarketPriceSchema = z.object({
  marketId: z.string(),
  selectionId: z.string(),
  bid: z.number().min(0).max(1).nullable(),
  ask: z.number().min(0).max(1).nullable(),
  mid: z.number().min(0).max(1).nullable(),
  last: z.number().min(0).max(1).nullable(),
  timestamp: z.string().datetime(),
  sequenceId: z.string().nullable(),
  provenance: ProvenanceSchema,
});
export type MarketPrice = z.infer<typeof MarketPriceSchema>;

export const MarketSnapshotSchema = z.object({
  snapshotId: z.string(),
  marketId: z.string(),
  prices: z.array(MarketPriceSchema),
  timestamp: z.string().datetime(),
  provenance: ProvenanceSchema,
});
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

export const MarketTickSchema = MarketPriceSchema.extend({
  tickId: z.string(),
});
export type MarketTick = z.infer<typeof MarketTickSchema>;

export const TheoEstimateSchema = z.object({
  marketId: z.string(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).nullable(),
  uncertainty: z.number().min(0).nullable(),
  modelVersion: z.string().nullable(),
  generatedAt: z.string().datetime(),
  source: SourceSchema.nullable(),
  status: TheoStatusSchema,
  reasonCodes: z.array(z.string()),
  provenance: z.string().optional(),
  independentAlpha: z.boolean().optional(),
  probabilityField: z.enum(["STABLE_PRICE", "PRICES_DECIMAL"]).optional(),
});
export type TheoEstimate = z.infer<typeof TheoEstimateSchema>;

export const QuoteSchema = z.object({
  quoteId: z.string(),
  marketId: z.string(),
  selectionId: z.string(),
  bid: z.number().min(0).max(1).nullable(),
  ask: z.number().min(0).max(1).nullable(),
  width: z.number().min(0).nullable(),
  inventoryLean: z.number(),
  directionalLean: z.number(),
  totalLean: z.number(),
  bidSize: z.number().nonnegative().nullable(),
  askSize: z.number().nonnegative().nullable(),
  status: QuoteStatusSchema,
  reasonCodes: z.array(z.string()),
  generatedAt: z.string().datetime(),
  provenance: ProvenanceSchema,
});
export type Quote = z.infer<typeof QuoteSchema>;

export const OrderSchema = z.object({
  orderId: z.string(),
  marketId: z.string(),
  selectionId: z.string(),
  side: OrderSideSchema,
  price: z.number().min(0).max(1),
  size: z.number().positive(),
  status: OrderStatusSchema,
  executionStyle: ExecutionStyleSchema,
  strategyId: z.string().optional(),
  createdAt: z.string().datetime(),
  provenance: ProvenanceSchema,
});
export type Order = z.infer<typeof OrderSchema>;

export const FillSchema = z.object({
  fillId: z.string(),
  orderId: z.string(),
  marketId: z.string(),
  selectionId: z.string(),
  side: OrderSideSchema,
  price: z.number().min(0).max(1),
  size: z.number().positive(),
  fee: z.number().nonnegative(),
  executionStyle: ExecutionStyleSchema,
  strategyId: z.string().optional(),
  filledAt: z.string().datetime(),
  provenance: ProvenanceSchema,
});
export type Fill = z.infer<typeof FillSchema>;

export const PositionSchema = z.object({
  marketId: z.string(),
  selectionId: z.string(),
  quantity: z.number(),
  averageEntryPrice: z.number().min(0).max(1).nullable(),
  markPrice: z.number().min(0).max(1).nullable(),
  realizedPnl: z.number(),
  unrealizedPnl: z.number().nullable(),
  fees: z.number().nonnegative(),
  makerQuantity: z.number(),
  takerQuantity: z.number(),
  strategyAttribution: z.record(z.string(), z.number()),
  provenance: ProvenanceSchema,
});
export type Position = z.infer<typeof PositionSchema>;

export const CashLedgerSchema = z.object({
  cashBalance: z.number(),
  reservedCash: z.number().nonnegative(),
  realizedPnl: z.number(),
  feesPaid: z.number().nonnegative(),
  provenance: ProvenanceSchema,
});
export type CashLedger = z.infer<typeof CashLedgerSchema>;

export const PortfolioSchema = z.object({
  portfolioId: z.string(),
  cash: CashLedgerSchema,
  positions: z.array(PositionSchema),
  updatedAt: z.string().datetime(),
  provenance: ProvenanceSchema,
});
export type Portfolio = z.infer<typeof PortfolioSchema>;

export const RiskLimitSchema = z.object({
  maxPositionPerSelection: z.number().positive(),
  maxExposurePerMarket: z.number().positive(),
  maxExposurePerFixture: z.number().positive(),
  maxExposurePerTeam: z.number().positive(),
  maxWorstCaseLoss: z.number().positive(),
  maxDailyDrawdown: z.number().positive(),
  maxOrderSize: z.number().positive(),
  maxQuoteWidth: z.number().positive(),
  minDataFreshnessMs: z.number().nonnegative(),
  killSwitch: z.boolean(),
  quoteSuspension: z.boolean(),
  directionalTradingSuspension: z.boolean(),
});
export type RiskLimit = z.infer<typeof RiskLimitSchema>;

export const RiskSnapshotSchema = z.object({
  riskSnapshotId: z.string(),
  portfolioPnl: z.number().nullable(),
  worstCasePnl: z.number().nullable(),
  bestCasePnl: z.number().nullable(),
  expectedPnl: z.number().nullable(),
  utilization: z.record(z.string(), z.number()),
  generatedAt: z.string().datetime(),
  provenance: ProvenanceSchema,
});
export type RiskSnapshot = z.infer<typeof RiskSnapshotSchema>;

export const TradingSignalSchema = z.object({
  signalId: z.string(),
  marketId: z.string(),
  selectionId: z.string(),
  directionalLean: z.number(),
  confidence: z.number().min(0).max(1),
  status: z.enum(["AVAILABLE", "DISABLED", "THEO_UNAVAILABLE", "STALE"]),
  reasonCodes: z.array(z.string()),
  generatedAt: z.string().datetime(),
  provenance: ProvenanceSchema,
});
export type TradingSignal = z.infer<typeof TradingSignalSchema>;

export const StrategyDecisionSchema = z.object({
  action: StrategyActionSchema,
  marketId: z.string(),
  selectionId: z.string(),
  proposedSize: z.number().nonnegative().nullable(),
  theo: TheoEstimateSchema.nullable(),
  marketProbability: z.number().min(0).max(1).nullable(),
  estimatedEdge: z.number().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  reasonCodes: z.array(z.string()),
  strategyVersion: z.string(),
  status: StrategyStatusSchema,
});
export type StrategyDecision = z.infer<typeof StrategyDecisionSchema>;

export const PerformanceSnapshotSchema = z.object({
  performanceSnapshotId: z.string(),
  makerPnl: z.number(),
  directionalPnl: z.number(),
  realizedPnl: z.number(),
  unrealizedPnl: z.number().nullable(),
  fees: z.number(),
  generatedAt: z.string().datetime(),
  provenance: ProvenanceSchema,
});
export type PerformanceSnapshot = z.infer<typeof PerformanceSnapshotSchema>;

export const awaitingTxoddsDisplay = "Awaiting TxODDS API";
