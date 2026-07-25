# Demo Architecture

The demo uses replay mode by default.

```text
Replay events
-> Backend normalization
-> BenchmarkStateSpaceTheoProvider
-> Quote calculation
-> Risk checks
-> Paper execution
-> Portfolio and P&L
-> Audit trail
-> React dashboard
```

Benchmark theo is labeled `BENCHMARK_THEO` and is available only when `DEMO_MODE=true` and `DATA_MODE=replay` or `synthetic`.

In `DATA_MODE=txline`, TxODDS data remains market observation only; proprietary theo remains unavailable until an approved research model is integrated.
