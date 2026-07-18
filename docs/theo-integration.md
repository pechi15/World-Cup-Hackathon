# Theo Integration

There is no approved theo model and no active TxODDS connection yet.

Runtime behavior:

```json
{
  "probabilities": null,
  "uncertainty": null,
  "status": "AWAITING_TXODDS_API",
  "modelVersion": null,
  "source": null,
  "reasonCodes": ["TXODDS_API_NOT_CONNECTED"]
}
```

The frontend should display:

```text
Awaiting TxODDS API
```

It must not display `0%`, `50%`, or a market midpoint as proprietary theo.

## Provider Interfaces

- `TheoProvider`
- `TxoddsTheoProvider`
- `HistoricalTheoProvider`
- `LearnedResidualTheoProvider`
- `EnsembleTheoProvider`
- `NullTheoProvider`

Future TxODDS-backed research will plug into `TheoProvider.getTheo(input)` and return probabilities, uncertainty, model version, provenance, and reason codes.
