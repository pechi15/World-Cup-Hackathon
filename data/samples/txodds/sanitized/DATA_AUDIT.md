# Sanitized replay data audit (offline demo)

**Label:** `REPLAY` / `SANITIZED_REPLAY_NOT_LIVE_TXODDS`  
**File:** `data/samples/txodds/sanitized/replay-fixture.json`

| Metric | Value |
|--------|--------|
| Fixtures | 1 (`18257865`) |
| Markets | 1 (`MATCH_RESULT_1X2`) |
| Updates | 15 |
| Earliest→latest | 15s spacing (deterministic) |
| Duplicate rate | 0 in file (store tested separately) |
| Providers observable | Single sanitized book (`SanitizedBook`) |
| SuperOddsType | `MATCH_RESULT_1X2` |
| Shock | Message index 8 (home shortens 1.80→1.40) |
| Selected probability field | `Prices` as raw decimal book odds |
| De-margining | Decimal implied probabilities are proportionally de-vigged exactly once |
| `Pct` | Preserved raw (`"0"` in all rows); not selected because semantics are unverified |
| StablePrice | Not present in this sanitized fixture |
| Settled outcomes | None; Brier score and log loss are not estimable (`N=0`) |

**Usable for:** MarketBaseline, StateSpace, innovation residual, quote loop demo.  
**Not usable for:** serious residual GBM training or live profitability claims.

Live TxLINE first-hour probe previously saw ~48 updates — harvest more before training.
