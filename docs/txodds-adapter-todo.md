# TxODDS Adapter TODO

The current adapter is disabled for live calls unless credentials are configured. Replay uses `ReplayTxoddsAdapter` + sanitized fixtures.

## Implemented (cursor/quant-agents)

- TxLINE-shaped odds update → internal `MarketDefinition` / ticks (`packages/market-data/src/mapper.ts`)
- Append-only `EventStore` with dedupe + event-time order
- `ReplayTxoddsAdapter` for offline demo
- Research pipeline theo: normalized observation → unchanged MarketBaseline →
  StateSpace posterior with innovation diagnostics
- Autonomous replay loop + `/api/replay/*` + `/api/demo/snapshot`

## Still future (live)

- Discover fixtures from TxODDS TxLINE (authenticated).
- Discover actual market types and supported market parameters.
- Receive live odds snapshots.
- Receive historical odds pagination at scale (beyond first-hour probe).
- Consume SSE updates into `EventStore`.
- Refresh guest JWT authentication without replacing the activated API token unnecessarily.
- Map TxODDS fixture, market, selection, timestamp, and sequence identifiers into the internal model with production edge cases.
- Preserve provenance as `TXODDS` only for authenticated live or historical TxODDS responses.
