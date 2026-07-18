import type { CashLedger, Fill, MarketPrice, Portfolio, Position, Provenance } from "../../contracts/src/index.js";

export function createEmptyPortfolio(portfolioId = "paper-default", startingCash = 100000): Portfolio {
  return {
    portfolioId,
    cash: {
      cashBalance: startingCash,
      reservedCash: 0,
      realizedPnl: 0,
      feesPaid: 0,
      provenance: { source: "SYNTHETIC" },
    },
    positions: [],
    updatedAt: new Date().toISOString(),
    provenance: { source: "SYNTHETIC" },
  };
}

export function applyFill(portfolio: Portfolio, fill: Fill): Portfolio {
  const next: Portfolio = structuredClone(portfolio);
  const signedQuantity = fill.side === "BUY" ? fill.size : -fill.size;
  const cashDelta = fill.side === "BUY" ? -(fill.price * fill.size + fill.fee) : fill.price * fill.size - fill.fee;
  next.cash.cashBalance += cashDelta;
  next.cash.feesPaid += fill.fee;

  let position = next.positions.find((item) => item.marketId === fill.marketId && item.selectionId === fill.selectionId);
  if (!position) {
    position = emptyPosition(fill.marketId, fill.selectionId, fill.provenance);
    next.positions.push(position);
  }

  const oldQuantity = position.quantity;
  const newQuantity = oldQuantity + signedQuantity;
  if (oldQuantity === 0 || Math.sign(oldQuantity) === Math.sign(signedQuantity)) {
    const oldCost = Math.abs(oldQuantity) * (position.averageEntryPrice ?? fill.price);
    const addCost = Math.abs(signedQuantity) * fill.price;
    position.averageEntryPrice = (oldCost + addCost) / Math.max(Math.abs(newQuantity), 1);
  } else {
    const closingSize = Math.min(Math.abs(oldQuantity), Math.abs(signedQuantity));
    const direction = Math.sign(oldQuantity);
    position.realizedPnl += closingSize * (fill.price - (position.averageEntryPrice ?? fill.price)) * direction;
    next.cash.realizedPnl += closingSize * (fill.price - (position.averageEntryPrice ?? fill.price)) * direction;
    if (Math.sign(newQuantity) !== Math.sign(oldQuantity) && newQuantity !== 0) {
      position.averageEntryPrice = fill.price;
    }
  }

  position.quantity = newQuantity;
  position.fees += fill.fee;
  position.makerQuantity += fill.executionStyle === "MAKER" ? fill.size : 0;
  position.takerQuantity += fill.executionStyle === "TAKER" ? fill.size : 0;
  if (fill.strategyId) position.strategyAttribution[fill.strategyId] = (position.strategyAttribution[fill.strategyId] ?? 0) + signedQuantity;
  if (newQuantity === 0) position.averageEntryPrice = null;
  next.updatedAt = new Date().toISOString();
  return next;
}

export function markPortfolio(portfolio: Portfolio, prices: MarketPrice[]): Portfolio {
  const next: Portfolio = structuredClone(portfolio);
  for (const position of next.positions) {
    const mark = prices.find((price) => price.marketId === position.marketId && price.selectionId === position.selectionId)?.mid ?? null;
    position.markPrice = mark;
    position.unrealizedPnl = mark === null || position.averageEntryPrice === null ? null : position.quantity * (mark - position.averageEntryPrice);
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

export function totalUnrealizedPnl(portfolio: Portfolio): number | null {
  let total = 0;
  for (const position of portfolio.positions) {
    if (position.unrealizedPnl === null) return null;
    total += position.unrealizedPnl;
  }
  return total;
}

export function exposureByMarket(portfolio: Portfolio): Record<string, number> {
  const result: Record<string, number> = {};
  for (const position of portfolio.positions) {
    result[position.marketId] = (result[position.marketId] ?? 0) + Math.abs(position.quantity);
  }
  return result;
}

function emptyPosition(marketId: string, selectionId: string, provenance: Provenance): Position {
  return {
    marketId,
    selectionId,
    quantity: 0,
    averageEntryPrice: null,
    markPrice: null,
    realizedPnl: 0,
    unrealizedPnl: null,
    fees: 0,
    makerQuantity: 0,
    takerQuantity: 0,
    strategyAttribution: {},
    provenance,
  };
}
