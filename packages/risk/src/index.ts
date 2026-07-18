import type { MarketDefinition, MarketPrice, Portfolio, RiskLimit, RiskSnapshot, ScoreScenario, TheoEstimate } from "../../contracts/src/index.js";
import { settleScoreMarket, validateMutuallyExclusiveProbabilities } from "../../market-model/src/index.js";
import { exposureByMarket } from "../../portfolio/src/index.js";

export type RiskCheck = {
  accepted: boolean;
  reasonCodes: string[];
};

export function checkOrderRisk(portfolio: Portfolio, market: MarketDefinition, selectionId: string, size: number, limits: RiskLimit): RiskCheck {
  const reasons: string[] = [];
  if (limits.killSwitch) reasons.push("KILL_SWITCH_ENABLED");
  if (size > limits.maxOrderSize) reasons.push("MAX_ORDER_SIZE_EXCEEDED");
  const position = portfolio.positions.find((item) => item.marketId === market.marketId && item.selectionId === selectionId);
  if (Math.abs((position?.quantity ?? 0) + size) > limits.maxPositionPerSelection) reasons.push("MAX_POSITION_PER_SELECTION_EXCEEDED");
  const marketExposure = (exposureByMarket(portfolio)[market.marketId] ?? 0) + Math.abs(size);
  if (marketExposure > limits.maxExposurePerMarket) reasons.push("MAX_EXPOSURE_PER_MARKET_EXCEEDED");
  return { accepted: reasons.length === 0, reasonCodes: reasons };
}

export type TerminalPayoffRow = {
  scenarioId: string;
  pnl: number;
  positionValue: number;
  selectionPayouts: Record<string, number>;
};

export function terminalOutcomeRisk(portfolio: Portfolio, markets: MarketDefinition[], scenarios: ScoreScenario[], theoDistribution?: Record<string, number> | null) {
  const rows: TerminalPayoffRow[] = scenarios.map((scenario) => {
    let pnl = 0;
    let positionValue = 0;
    const payouts: Record<string, number> = {};
    for (const market of markets) {
      if (market.fixtureId !== scenario.fixtureId) continue;
      const settlement = settleScoreMarket(market, scenario);
      Object.assign(payouts, settlement.selectionPayouts);
      for (const position of portfolio.positions.filter((item) => item.marketId === market.marketId)) {
        const payout = settlement.selectionPayouts[position.selectionId] ?? 0;
        const entry = position.averageEntryPrice ?? 0;
        const value = position.quantity * payout;
        positionValue += value;
        pnl += position.quantity * (payout - entry) - position.fees;
      }
    }
    return { scenarioId: scenario.scenarioId, pnl, positionValue, selectionPayouts: payouts };
  });
  const pnls = rows.map((row) => row.pnl);
  const expectedPnl = theoDistribution && validateMutuallyExclusiveProbabilities(theoDistribution)
    ? rows.reduce((acc, row) => acc + row.pnl * (theoDistribution[row.scenarioId] ?? 0), 0)
    : null;
  return {
    rows,
    worstCasePnl: pnls.length ? Math.min(...pnls) : null,
    bestCasePnl: pnls.length ? Math.max(...pnls) : null,
    expectedPnl,
  };
}

export function probabilityShock(prices: Record<string, number>, shock: number): Record<string, number> {
  const keys = Object.keys(prices);
  if (keys.length === 0) return {};
  if (keys.length === 2) {
    const first = Math.min(1, Math.max(0, prices[keys[0]] + shock));
    return { [keys[0]]: first, [keys[1]]: 1 - first };
  }
  const shockedFirst = Math.min(1, Math.max(0, prices[keys[0]] + shock));
  const remainingOriginal = keys.slice(1).reduce((acc, key) => acc + prices[key], 0);
  const remaining = 1 - shockedFirst;
  const result: Record<string, number> = { [keys[0]]: shockedFirst };
  for (const key of keys.slice(1)) {
    result[key] = remainingOriginal === 0 ? remaining / (keys.length - 1) : remaining * (prices[key] / remainingOriginal);
  }
  return result;
}

export function markToMarketShockRisk(portfolio: Portfolio, current: MarketPrice[], shocked: MarketPrice[]) {
  const rows = portfolio.positions.map((position) => {
    const currentMid = current.find((price) => price.marketId === position.marketId && price.selectionId === position.selectionId)?.mid ?? 0;
    const shockedMid = shocked.find((price) => price.marketId === position.marketId && price.selectionId === position.selectionId)?.mid ?? currentMid;
    const pnlChange = position.quantity * (shockedMid - currentMid);
    return { marketId: position.marketId, selectionId: position.selectionId, pnlChange, positionValue: position.quantity * shockedMid, exposure: Math.abs(position.quantity) };
  });
  return {
    rows,
    portfolioPnlChange: rows.reduce((acc, row) => acc + row.pnlChange, 0),
  };
}

export function buildRiskSnapshot(portfolio: Portfolio, limits: RiskLimit, terminalRisk: ReturnType<typeof terminalOutcomeRisk>): RiskSnapshot {
  const marketExposure = exposureByMarket(portfolio);
  const maxMarketUtil = Math.max(0, ...Object.values(marketExposure).map((value) => value / limits.maxExposurePerMarket));
  return {
    riskSnapshotId: `risk-${Date.now()}`,
    portfolioPnl: null,
    worstCasePnl: terminalRisk.worstCasePnl,
    bestCasePnl: terminalRisk.bestCasePnl,
    expectedPnl: terminalRisk.expectedPnl,
    utilization: {
      maxMarketExposure: maxMarketUtil,
      worstCaseLoss: terminalRisk.worstCasePnl === null ? 0 : Math.abs(Math.min(0, terminalRisk.worstCasePnl)) / limits.maxWorstCaseLoss,
      killSwitch: limits.killSwitch ? 1 : 0,
    },
    generatedAt: new Date().toISOString(),
    provenance: { source: "SYNTHETIC" },
  };
}
