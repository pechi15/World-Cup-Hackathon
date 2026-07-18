# Model Validation and Risk

## Purpose

Define how research models may be scored, gated, and **not** promoted to live funds. Paper / replay only.

## TxLINE / StablePrice rule

Official TxLINE documentation: **StablePrice** already includes consensus aggregation, de-margining, stale-line filtering, and outlier filtering.

**Controls:**

| Control | Requirement |
|---------|-------------|
| Raw preservation | Store original `Prices`, `Pct`, and any StablePrice fields unchanged |
| Field selection | Document which field is `market_probability` in audit metadata |
| No double de-vig | If input is identified as StablePrice / already de-margined, skip proportional de-vig (numerical clip only) |
| Regression test | Fail CI if StablePrice-like vector (sums ≈ 1 within tolerance) is passed through `proportionalDevig` again |
| Alpha hygiene | TxLINE consensus ≠ proprietary theo |

## Validation layers

1. **Contract / schema** — Zod / TypeScript contracts; null theo never displayed as mid.
2. **Statistical** — log loss, Brier, calibration (Gneiting & Raftery 2007; Brier 1950).
3. **Trading** — markout, drawdown, inventory variance (research metrics).
4. **Multiple testing** — White (2000) Reality Check / Hansen (2005) SPA before any superiority claim.
5. **Operational** — kill switch, quote suspension, freshness, innovation thresholds.

## Empirical gates (no live funds)

Promotion statuses stop at paper/integration rehearsal:

`REJECTED` → `RESEARCH_ONLY` → `PROMOTE_TO_REPLAY` → `PROMOTE_TO_PAPER` → `APPROVED_FOR_INTEGRATION`

**Never** invent `APPROVED_FOR_LIVE_FUNDS`.

Minimum evidence for `PROMOTE_TO_REPLAY`:

- Chronological (and fixture-grouped where applicable) OOS
- Proper scores vs **MarketBaseline**
- Documented sample size; **refuse** if N is integration-scale (~48 updates)
- Leakage tests green
- StablePrice / de-vig policy documented

## Risk limits (hard — agents may not edit)

Owned by production risk package (`packages/risk`). Research agents must not mutate:

- max position / exposure / worst-case loss
- kill switch semantics
- wallet permissions
- train/test split definitions
- promotion gate code

## Kelly and model risk

Kelly (1956) sizing is extremely sensitive to probability error. Default research fractions: `0`, `0.10`, `0.25`. Hard portfolio caps always bind. Null theo → no trade.

## Failure modes to monitor

- Double de-vig of StablePrice
- Lookahead features
- Overfit on sanitized 15-tick or 48-tick samples
- Treating MarketBaseline as proprietary alpha
- P&L-only optimization without proper scores
- Data snooping across many strategies without RC/SPA

## Current checkpoint status

| Item | Status |
|------|--------|
| Replay theo + LIVE quotes | Working on sanitized data |
| State-space Milestone 1 | Implemented for `REPLAY` / `RESEARCH`; empirical calibration pending |
| Double-de-vig test | Implemented for StablePrice-like already de-margined input |
| Proper-score comparison | Implemented; current sanitized replay has no outcomes (`N=0`) |
| Dixon–Coles / logistic residual | Not started |
| SPA / Reality Check | Not started |
| Live TxLINE harvest | Scripts only |
