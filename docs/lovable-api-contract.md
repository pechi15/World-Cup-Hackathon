# Lovable API Contract

The API supports paper trading plus an offline **replay** autonomous maker/taker demo.

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
- `GET /api/replay/status`
- `POST /api/replay/reset`
- `POST /api/replay/pause`
- `POST /api/replay/play`
- `POST /api/replay/speed` body `{ "speed": 1 }`
- `POST /api/replay/step`
- `POST /api/replay/run` body `{ "maxSteps": 10000 }`
- `GET /api/demo/snapshot`
- `GET /api/audit`

## Theo display

With explicit `THEO_MODE=REPLAY` or `THEO_MODE=RESEARCH` and replay loaded,
`/api/theo/:marketId` returns the StateSpace posterior plus uncertainty,
innovation, and standardized-innovation diagnostics.
`MARKET_BASELINE` reason codes include `BENCHMARK_ONLY` / `NOT_PROPRIETARY_ALPHA`.

When `THEO_MODE` is unset/unsupported or replay data is absent,
production-default NullTheoProvider returns:

```json
{
  "probabilities": null,
  "uncertainty": null,
  "status": "AWAITING_TXODDS_API",
  "reasonCodes": ["TXODDS_API_NOT_CONNECTED"]
}
```

UI must display `Awaiting TxODDS API` and must not show missing theo as `0%`, `50%`, or market mid as proprietary theo.

## Demo snapshot fields

`GET /api/demo/snapshot` includes market price, baseline, theo, uncertainty, bid/ask, width, leans, quote size/status, inventories, markout horizons, P&amp;L, kill-switch, innovation, suspension flag, and reason codes.
