import type { Fill, Order, Portfolio, RiskLimit } from "../../contracts/src/index.js";
import type { MarketDefinition } from "../../contracts/src/index.js";
import { applyFill } from "../../portfolio/src/index.js";
import { checkOrderRisk } from "../../risk/src/index.js";

export type PaperExecutionResult = {
  order: Order;
  fills: Fill[];
  portfolio: Portfolio;
  reasonCodes: string[];
};

export class PaperExecutionEngine {
  submitOrder(portfolio: Portfolio, market: MarketDefinition, order: Order, limits: RiskLimit, fillRatio = 1): PaperExecutionResult {
    const risk = checkOrderRisk(portfolio, market, order.selectionId, order.size, limits);
    if (!risk.accepted) {
      return { order: { ...order, status: "REJECTED" }, fills: [], portfolio, reasonCodes: risk.reasonCodes };
    }
    const filledSize = Math.max(0, Math.min(order.size, order.size * fillRatio));
    const fill: Fill = {
      fillId: `fill-${order.orderId}`,
      orderId: order.orderId,
      marketId: order.marketId,
      selectionId: order.selectionId,
      side: order.side,
      price: order.price,
      size: filledSize,
      fee: filledSize * order.price * 0.001,
      executionStyle: order.executionStyle,
      strategyId: order.strategyId,
      filledAt: new Date().toISOString(),
      provenance: { source: "SYNTHETIC", notes: "Paper-only deterministic fill." },
    };
    const nextPortfolio = filledSize > 0 ? applyFill(portfolio, fill) : portfolio;
    const status = filledSize === 0 ? "NEW" : filledSize < order.size ? "PARTIALLY_FILLED" : "FILLED";
    return { order: { ...order, status }, fills: filledSize > 0 ? [fill] : [], portfolio: nextPortfolio, reasonCodes: [] };
  }

  cancel(order: Order): Order {
    return { ...order, status: "CANCELLED" };
  }

  expire(order: Order): Order {
    return { ...order, status: "EXPIRED" };
  }
}
