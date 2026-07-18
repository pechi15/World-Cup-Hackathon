# Experiment Roadmap

## Non-goals (until MVP demo is boringly reliable)

- Perplexity / web-search as a primary dependency
- Colab GPU training as a primary dependency
- Multi-agent orchestration frameworks
- Live-funds trading
- Alpha claims from synthetic or ~48-update integration samples

## Data policy

1. Harvest / record TxLINE into append-only raw store.
2. Run data audit (counts, SuperOddsType, `Prices` vs `Pct`, StablePrice semantics).
3. **Only then** train residual models.
4. TxLINE StablePrice is market consensus (already de-margined) — not proprietary alpha; no double de-vig.

## Milestone order (mandatory)

### Milestone 1 — State-space benchmark theo and uncertainty

- Harden `packages/theo/src/state-space.ts`
- Document market probability field from authenticated samples
- Preserve raw values
- Add double-de-vig prevention test
- Acceptance: replay demo still green; uncertainty responds to stale/shock

Implementation status (2026-07-18): code and deterministic tests are complete
for normalized replay ingestion, explicit `Prices`/StablePrice semantics,
latent additive-log-odds filtering, uncertainty, shocks, stale/missing data,
and no-lookahead controls. Empirical acceptance remains open: the sanitized
replay has no outcomes, authenticated `Pct` samples remain semantically
unverified, and command-runner verification must be green before promotion.

### Milestone 2 — Dixon–Coles historical prior

- Score matrix → coherent 1X2 / totals / handicap
- Requires historical match results at usable N
- Acceptance: proper scores vs baseline on held-out fixtures (not sanitized-only)

Implementation status (2026-07-18): research code, deterministic optimizer,
historical fixture schema/audit, connected-schedule and time-weighted
sufficiency gates, coherent score-derived markets, research-only provider, and
chronological expanding-window evaluation infrastructure are implemented.
`data/samples/historical/test-only/` is test-only and is not empirical evidence.
The repository currently has no sufficient settled historical dataset, so
`DIXON_COLES_PRIOR` remains `REJECTED` / `INSUFFICIENT_REAL_DATA`.

### Milestone 3 — Regularized market-residual logistic

- `softmax(market_logits + Xβ)`
- Chronological + fixture-grouped validation; leakage tests
- Acceptance: OOS log loss / Brier improvement vs MarketBaseline on TxODDS/replay

### Milestone 4 — Maker markout and adverse-selection model

- Horizons 10s / 30s / 60s / 300s
- Inform width / suspension policy research
- Acceptance: policy reduces adverse markout without collapsing fill rate unrealistically

### Milestone 5 — Regime and lead–lag (conditional)

- Only if multi-provider / long history supports Hamilton / Hasbrouck-style analysis
- Otherwise keep REJECTED in `strategy-registry.yaml`

## Near-term experiments (registry IDs)

| Experiment | Milestone | Data needed |
|------------|-----------|-------------|
| SS_UNCERTAINTY_CAL | 1 | Sanitized + larger replay |
| STABLEPRICE_FIELD_AUDIT | 1 | Authenticated TxLINE samples |
| DC_WC_PRIOR | 2 | Match results history |
| RESLOG_1X2 | 3 | Dense odds path + outcomes |
| MARKOUT_AS_V1 | 4 | Fills under replay/live paper |
| REGIME_HMM_V0 | 5 | Long multi-state series |

## Reporting rule

Every report must state data_mode (`SYNTHETIC` | `REPLAY` | `TXODDS`) and refuse profitability language unless gates + SPA/RC are satisfied on non-synthetic data.
