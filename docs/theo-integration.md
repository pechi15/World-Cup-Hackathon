# Theo Integration

## Runtime modes

1. **NullTheoProvider** (production default; unset or unsupported `THEO_MODE`):
   `AWAITING_TXODDS_API`, null probabilities.
2. **PipelineTheoProvider** (explicit `THEO_MODE=REPLAY` or
   `THEO_MODE=RESEARCH` with replay loaded): normalized market observation →
   unchanged MarketBaseline → StateSpace latent additive-log-odds posterior.

Frontend must never display market mid as proprietary theo. Baseline reason codes include `BENCHMARK_ONLY`.
State-space outputs are labeled `RESEARCH_ONLY` and `NOT_PROVEN_ALPHA`.
Innovations are diagnostics; Milestone 1 does not add an innovation residual to
posterior logits.

## Provider Interfaces

- `TheoProvider`
- `NullTheoProvider`
- `MarketBaselineTheoProvider`
- `StateSpaceTheoProvider`
- `PipelineTheoProvider`
- `TxoddsTheoProvider` (stub for live)
- `HistoricalTheoProvider` (stub)
- `LearnedResidualTheoProvider` (stub / future logistic-GBM)
- `EnsembleTheoProvider` (stub)

## Replay demo

See `docs/demo-script.md`. Autonomous loop: `packages/agent` + `/api/replay/*` + `/api/demo/snapshot`.
