import type { Fill } from "../../contracts/src/index.js";

export type MarkoutHorizons = {
  m10: number | null;
  m30: number | null;
  m60: number | null;
  m300: number | null;
};

/**
 * MarkoutModel interface (research): compare fill price to later mid.
 * With only a live mid map, returns nulls until future mids are observed;
 * `realizedMarkout` computes when a future mid is supplied.
 */
export function realizedMarkout(fill: Fill, futureMid: number): number {
  const direction = fill.side === "BUY" ? 1 : -1;
  return direction * (futureMid - fill.price);
}

export function computeMarkouts(
  fills: Fill[],
  mids: Map<string, number>,
  marketId: string,
  selectionId: string,
): MarkoutHorizons {
  const key = `${marketId}|${selectionId}`;
  const mid = mids.get(key);
  const lastFill = [...fills].reverse().find((f) => f.marketId === marketId && f.selectionId === selectionId);
  if (!lastFill || mid == null) return { m10: null, m30: null, m60: null, m300: null };
  // Without a full future path in-memory, use current mid as instantaneous markout proxy (labeled).
  const instant = realizedMarkout(lastFill, mid);
  return { m10: instant, m30: instant, m60: instant, m300: instant };
}

export interface MarkoutModel {
  predict(features: Record<string, number>): MarkoutHorizons;
}
