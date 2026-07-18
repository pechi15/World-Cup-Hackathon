# Architecture

This backend is a paper-only World Cup prediction-market trading core. It starts without live TxODDS credentials and avoids fake production theory prices.

## Boundaries

- Market data: fixtures, markets, prices, ticks, timestamps, and sequence IDs. Sources: `TEST_FIXTURE`, `SYNTHETIC`, `REPLAY` (sanitized TxLINE-shaped), future `TXODDS`.
- Theo: production-default `NullTheoProvider`; explicit replay/research
  `PipelineTheoProvider` (normalized observation → unchanged MarketBaseline →
  StateSpace additive-log-odds posterior). Innovations are diagnostics only.
- Market making: existing width/lean/height; quotes LIVE only when theo `AVAILABLE`.
- Directional: fractional Kelly in autonomous loop; null theo → no action.
- Portfolio / risk / execution / evaluation: paper fills, scenario risk, audit + markout interfaces.
- Replay: `ReplayClock` + `AutonomousTradingLoop` + `/api/replay/*` + `/api/demo/snapshot`.

## Selected Structure

```text
apps/api
packages/contracts
packages/market-model
packages/market-data   # mapper, EventStore, ReplayTxoddsAdapter
packages/theo          # baseline, state-space, pipeline
packages/replay
packages/agent
packages/quoting
packages/strategies
packages/portfolio
packages/risk
packages/execution
packages/evaluation
docs
data/samples/txodds/sanitized
scripts
```
