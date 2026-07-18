# TxODDS Adapter TODO

The current adapter is disabled unless credentials are configured. It must not make authenticated calls without approved local credentials.

Future integration points:

- Discover fixtures from TxODDS TxLINE.
- Discover actual market types and supported market parameters.
- Receive odds snapshots.
- Receive historical odds.
- Consume SSE updates.
- Refresh guest JWT authentication without replacing the activated API token unnecessarily.
- Map TxODDS fixture, market, selection, timestamp, and sequence identifiers into the internal model.
- Preserve provenance as `TXODDS` only for authenticated live or historical TxODDS responses.
