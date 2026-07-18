# Lovable API Contract

The API is intended for a future Lovable frontend. It starts without TxODDS credentials.

## Endpoints

- `GET /health`
- `GET /api/config`
- `GET /api/fixtures`
- `GET /api/markets`
- `GET /api/markets/:marketId`
- `GET /api/theo/:marketId`
- `GET /api/quotes`
- `GET /api/positions`
- `GET /api/portfolio`
- `GET /api/risk`
- `POST /api/risk/scenario`
- `GET /api/fills`
- `GET /api/orders`
- `GET /api/performance`
- `GET /api/strategies`
- `POST /api/strategies/:strategyId/enable`
- `POST /api/strategies/:strategyId/disable`
- `POST /api/orders/paper`
- `POST /api/kill-switch/enable`
- `POST /api/kill-switch/disable`

## Missing Theo Display

`GET /api/theo/:marketId` currently returns:

```json
{
  "marketId": "m-total-001",
  "probabilities": null,
  "uncertainty": null,
  "status": "AWAITING_TXODDS_API",
  "modelVersion": null,
  "source": null,
  "reasonCodes": ["TXODDS_API_NOT_CONNECTED"]
}
```

The UI should display:

```text
Awaiting TxODDS API
```

The UI must not show missing theo as `0%`, `50%`, unexplained `N/A`, a midpoint, or a fake model price.

## UI Fields

The contracts support market browser, fixture browser, theo, market prices, edge, width, lean, height, bid, ask, positions, maker P&L, directional P&L, risk sheets, scenario matrices, strategy status, kill-switch status, and system-data status.
