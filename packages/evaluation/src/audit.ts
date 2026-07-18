export type AuditEvent = {
  eventId: string;
  eventTime: string;
  fixtureId: string;
  marketId: string;
  selectionId: string;
  marketPrice: number | null;
  theo: number | null;
  baseline: number | null;
  uncertainty: number | null;
  innovation: number;
  bid: number | null;
  ask: number | null;
  width: number | null;
  inventoryLean: number;
  directionalLean: number;
  quoteSize: number | null;
  quoteStatus: string;
  makerInventory: number;
  directionalPosition: number;
  realizedPnl: number;
  fees: number;
  killSwitch: boolean;
  quoteSuspended: boolean;
  markout10s: number | null;
  markout30s: number | null;
  markout60s: number | null;
  markout300s: number | null;
  reasonCodes: string[];
};

export function appendAuditEvent(log: AuditEvent[], event: AuditEvent): AuditEvent {
  log.push(event);
  return event;
}
