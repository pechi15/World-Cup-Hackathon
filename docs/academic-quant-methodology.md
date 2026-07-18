# Academic Quant Methodology — Paper ↔ Code Traceability

**Scope:** Bounded sports outcome contracts (probability prices in \([0,1]\)), TxLINE consensus odds, paper trading only.  
**Rule:** Synthetic / sanitized / 48-update integration samples are **not** evidence of alpha.

## TxLINE baseline warning

TxLINE **StablePrice** documentation indicates consensus aggregation, de-margining, stale-line filtering, and outlier filtering are already applied. Implementation must:

1. Preserve raw TxLINE fields.
2. Document which field is used as market probability (`Prices`, `Pct`, StablePrice, etc.).
3. Avoid a second proportional de-vig on already de-margined consensus.
4. Carry a regression test against accidental double de-vigging.

Sanitized replay currently de-vigs decimal book `Prices` (appropriate only if those prices are raw book odds, not StablePrice).

---

## Academic implementation priority (fixed order)

| Order | Milestone | Status at checkpoint |
|------:|-----------|----------------------|
| 1 | State-space benchmark theo and uncertainty | **Partial** (Kalman-style filter + innovation residual in TS) |
| 2 | Dixon–Coles historical prior and coherent score distribution | **Implemented in research code; real-data gate remains closed** |
| 3 | Regularized market-residual logistic model | Interface only / residual via innovation |
| 4 | Maker markout and adverse-selection model | Interface + instantaneous proxy |
| 5 | Regime and lead–lag research (only if data supports) | Not started |

---

## Paper-to-code traceability table

| Component | Economic/statistical hypothesis | Primary academic source | Equation (sketch) | Assumptions | Adaptation to bounded sports outcome contracts | Planned implementation file | Unit tests | Empirical acceptance criteria | Known failure modes | Current implementation status |
|-----------|----------------------------------|-------------------------|-------------------|-------------|------------------------------------------------|-----------------------------|------------|-------------------------------|---------------------|-------------------------------|
| Market consensus probability | Posted odds embed a consensus probability plus overround / microstructure | TxLINE product semantics (StablePrice); classical betting overround | If raw decimal odds \(o_i\): \(q_i=1/o_i\), \(p_i=q_i/\sum q_j\). If StablePrice already de-margined: use as \(p_i\) without renormalizing beyond numerical cleanup | Odds positive; mutually exclusive exhaustive outcomes | Map SuperOddsType markets to selection IDs; store raw + chosen \(p\) | `packages/market-data/src/mapper.ts`, `packages/theo/src/devig.ts` | De-vig sum≈1; **forbid double de-vig of StablePrice** | Documented field choice; audit of raw vs used \(p\) | Double de-vig flattens edges; wrong field choice | **Partial** — de-vig for raw decimals; StablePrice guard **TODO** |
| State-space fair value | Latent fair additive log-odds follow a random walk; market is a noisy observation | Kalman (1960), DOI 10.1115/1.3662552 | \(x^-_t=x_{t-1}\), \(P^-_t=P_{t-1}+Q_t\); \(K_t=P^-_t/(P^-_t+R_t)\); \(x_t=x^-_t+K_t(y_t-x^-_t)\); \(P_t=(1-K_t)P^-_t\) | Diagonal linear-Gaussian filter in additive-log-ratio coordinates | Reference-outcome ALR maps bounded outcomes to \(\mathbb R^{K-1}\); softmax maps the posterior back; stale arrival inflates \(R_t\); elapsed time and configured shocks increase \(Q_t\) | `packages/theo/src/state-space.ts` | `tests/state-space-theo.test.ts`: filtering, uncertainty, shock, stale/missing, bounds, reproducibility, no-lookahead | OOS log loss and Brier ≤ unchanged market baseline on replay/TxODDS with outcomes | Non-Gaussian jumps; diagonal covariance; misspecified \(Q,R\); no outcome-bearing replay yet | **Implemented for Milestone 1 research/replay; not proven alpha** |
| Innovation diagnostics | Standardized filter innovations may identify observations that are surprising under the configured model | Kalman (1960) | \(e_t=y_t-x^-_t\); \(z_t=e_t/\sqrt{P^-_t+R_t}\) | A large standardized residual is diagnostically meaningful if \(Q,R\) are calibrated | Emit raw and standardized innovations; do **not** add them back to posterior logits or label them alpha | `packages/theo/src/state-space.ts`, `packages/agent/src/index.ts` | Diagnostics finite; shock path raises process uncertainty; replay suspension remains tested | Calibration and markout evidence on substantial non-synthetic history | Miscalibrated \(Q,R\); multiple comparisons; tiny replay | **Diagnostic only; residual trading correction removed from Milestone 1 posterior** |
| Dixon–Coles score model | Match scores follow team-strength Poisson rates with low-score dependence \(\rho\) | Dixon & Coles (1997), DOI 10.1111/1467-9876.00065 | \(\log\lambda=c+a_h-d_a+\gamma I_{\mathrm{nonneutral}}\), \(\log\mu=c+a_a-d_h\); \(p(x,y)=\tau_{\lambda,\mu}(x,y;\rho)\operatorname{Pois}(x;\lambda)\operatorname{Pois}(y;\mu)\); exponentially weighted penalized log likelihood | Team strengths approximately stable over configured half-life; connected schedule; settled outcomes available before cutoff | Independent historical prior produces one coherent terminal score matrix, then 1X2/totals/BTTS/team totals/half-goal handicaps | `packages/theo/src/dixon-coles.ts`, `historical-data.ts`, `score-markets.ts`, `historical-score-prior.ts` | `tests/dixon-coles.test.ts`: normalization, constraints, home advantage, decay, \(\tau\), tails, markets, cutoff, sufficiency, determinism | Chronological expanding-window improvement over unconditional score-frequency and independent-Poisson baselines; compare unchanged market baseline only when compatible historical prices exist | Sparse national-team schedules; changing squads/coaches; disconnected graph; truncation; local optimum; unstable \(\rho\) | **Milestone 2 implemented as `RESEARCH_ONLY`; current real-data status `INSUFFICIENT_REAL_DATA`** |
| Market-residual logistic | \(P^\* = \mathrm{softmax}(\mathrm{logit}(P^{\mathrm{mkt}})+X\beta)\) | Classical logistic / scoring literature; residual framing | Multiclass log-likelihood with \(L_2\) on \(\beta\) | No lookahead; features available at \(t\) | Chronological + fixture-grouped CV | `packages/theo/src/residual-logistic.ts` (planned) | Leakage tests; coef stability | Beats baseline OOS log loss & Brier on TxODDS/replay | Leakage; tiny N | **Not started** (innovation residual stands in) |
| Proper scoring | Better probabilistic forecasts have lower expected score | Brier (1950); Gneiting & Raftery (2007), DOI 10.1198/016214506000001437 | Brier \(\sum(p_k-\mathbf{1}_k)^2\); log loss \(-\log p_{y}\) | Outcomes observed; probabilities calibrated | Use for theo selection, not P&L alone | `packages/evaluation/` + future research | Unit scores on known distributions | Report CI; require improvement beyond baseline | Optimizing P&L without proper scores | **Partial** (infra); not full suite |
| Inventory-aware MM | Optimal quotes trade off inventory risk vs adverse selection | Avellaneda & Stoikov (2008), DOI 10.1080/14697680701381228 | Reservation price / width from inventory and volatility (adapted) | Diffusive mid; risk aversion | Map mid→probability price; use uncertainty & innovation as vol proxies | `packages/quoting/src/index.ts` (config; do not silent-rewrite) | Width increases in uncertainty/inventory | Replay: controlled inventory; shock widen | Ignoring informed flow | **Partial** — production width/lean exist; AS-inspired coeffs |
| Adverse selection | Informed traders hit stale quotes | Glosten & Milgrom (1985), DOI 10.1016/0304-405X(85)90044-3 | Bid–ask spreads compensate for informed flow | Asymmetric info | Markout after fills; suspend on innovation | `packages/evaluation/src/markout.ts`, agent suspension | Markout horizons 10/30/60/300s | Adverse markout ↓ after suspension policy | No fills → empty markout | **Partial** — interface + proxy |
| Fractional Kelly | Size \(\propto\) edge / odds under log-utility; fraction for error | Kelly (1956), DOI 10.1002/j.1538-7305.1956.tb03809.x | Binary: \(f^\*=(p-c)/(1-c)\) then \(\kappa f^\*\) | Known \(p\); independent bets | Hard caps; \(\kappa\in\{0,0.1,0.25\}\); never full Kelly default | `packages/strategies/src/index.ts` | Invalid \(p\) → no size | Cap binds; null theo → no trade | Misestimated \(p\) → blowups | **Partial** — fractional Kelly in loop |
| Reality check / SPA | Data-snooping inflates apparent best rule | White (2000) DOI 10.1111/1468-0262.00152; Hansen (2005) DOI 10.1198/073500105000000063 | Bootstrap null of no superior predictive ability | Stationarity / block dependence | Apply before any “alpha” claim on many strategies | `research/` planned scripts | Registry requires SPA/RC before promote | p-values with block bootstrap | Claiming alpha from 48 ticks | **Not started** |
| Regime switching | Market dynamics switch latent regimes | Hamilton (1989), DOI 10.2307/1912559 | HMM / MSAR latent state | Enough time series | Quiet vs shock vs stale regimes for residual weights | `packages/theo/src/regime.ts` (planned) | Regime labels stable | Only if data volume supports | Overfit regimes on tiny sample | **Not started** (Milestone 5) |
| Price discovery / lead–lag | One venue’s innovations lead another | Hasbrouck (1995), DOI 10.1111/j.1540-6261.1995.tb04054.x | Information share / VECM of cointegrated prices | Multiple providers observable | Provider disagreement features | Research only if multi-book visible | Granger / lead-lag tests | Requires multi-provider history | Single book → N/A | **Not started** (Milestone 5) |

---

## Citation discipline

Prefer the DOI sources listed above (see `research/references.bib`). Avoid blogs/tutorials as primary citations in methodology claims.

---

## Milestone 1 paper-to-code traceability

### Source paper

R. E. Kalman, “A New Approach to Linear Filtering and Prediction Problems,”
*Journal of Basic Engineering* 82(1), 35–45 (1960), DOI
[`10.1115/1.3662552`](https://doi.org/10.1115/1.3662552);
BibTeX key `kalman1960filtering`.

### Equations used

For outcome \(K\) as reference, normalized market probabilities are transformed
to additive log-odds:

\[
y_{i,t}=\log\frac{p_{i,t}}{p_{K,t}},\qquad i=1,\ldots,K-1.
\]

The implementation uses a random-walk transition and direct noisy observation:

\[
x_t=x_{t-1}+w_t,\quad w_t\sim N(0,Q_t),\qquad
y_t=x_t+v_t,\quad v_t\sim N(0,R_t).
\]

The scalar Kalman equations are applied independently to each ALR coordinate:

\[
P^-_t=P_{t-1}+Q_t,\quad
K_t=\frac{P^-_t}{P^-_t+R_t},\quad
x_t=x^-_t+K_t(y_t-x^-_t),\quad
P_t=(1-K_t)P^-_t.
\]

Posterior outcome probabilities are
\(\operatorname{softmax}(x_{1,t},\ldots,x_{K-1,t},0)\). Innovations are
\(e_t=y_t-x^-_t\), with standardized innovations
\(z_t=e_t/\sqrt{P^-_t+R_t}\).

### Assumptions changed

- Kalman’s general matrix model is restricted to a random walk with identity
  transition and observation matrices.
- Covariance is diagonal; cross-outcome covariance is not estimated.
- Bounded mutually-exclusive probabilities are represented in ALR coordinates,
  then mapped back through softmax.
- \(Q_t\) scales with elapsed replay time and receives a one-shot configured
  increment after an information-shock signal.
- A newly received stale observation uses inflated \(R_t\); prediction without
  a new observation increases uncertainty and eventually returns `STALE`.
- Replay delivery is ordered by receive time, while the state transition retains
  event time; both timestamps must be no later than the forecast `asOf`.
- TxLINE field semantics are resolved before filtering: raw decimal `Prices`
  are de-vigged once, documented `StablePrice` is not de-vigged, and `Pct` is
  preserved but not selected while its semantics remain unverified.

### Why the adaptation is valid

ALR is a one-to-one map between the interior of the probability simplex and
\(\mathbb R^{K-1}\), where a linear Gaussian approximation can be applied.
Softmax therefore guarantees bounded posterior probabilities summing to one.
The random walk is a benchmark assumption for a time-varying latent consensus,
not a structural claim about football outcomes. Explicit \(Q_t\), \(R_t\),
staleness, and shock controls make the approximation testable and configurable.

### Verification tests

`tests/state-space-theo.test.ts` verifies normalized-observation ingestion, raw
field preservation, StablePrice double-de-vig prevention, posterior filtering,
innovation outputs, uncertainty growth, configured shocks, stale and missing
observations, probability bounds, deterministic replay, no-lookahead rejection,
research-only mode selection, and paired Brier/log-loss evaluation.
`tests/replay-theo-loop.test.ts` retains the end-to-end replay integration test.

### Empirical evidence still missing

- No settled outcomes exist in the 15-update sanitized replay, so its Brier and
  log-loss comparison is not estimable.
- \(Q\), \(R\), stale multiplier, and shock variance are not calibrated on a
  substantial chronological TxODDS sample.
- No fixture-grouped out-of-sample calibration, confidence intervals, or
  comparison robust to repeated observations from the same fixture exists.
- No evidence supports profitability, proprietary edge, or live-funds use.

---

## Milestone 2 paper-to-code traceability

### Source and equations

Primary source: Dixon and Coles (1997), “Modelling Association Football Scores
and Inefficiencies in the Football Betting Market,” DOI
[`10.1111/1467-9876.00065`](https://doi.org/10.1111/1467-9876.00065), BibTeX
key `dixon1997football`.

For home team \(i\) and away team \(j\), the implementation uses the
log-parameterized rates

\[
\log\lambda_{ij}=c+a_i-d_j+\gamma I_{\text{non-neutral}},\qquad
\log\mu_{ij}=c+a_j-d_i.
\]

The independent-Poisson mass is corrected only for low scores:

\[
p(x,y)=\tau_{\lambda,\mu}(x,y;\rho)
\operatorname{Pois}(x;\lambda)\operatorname{Pois}(y;\mu),
\]

\[
\tau(x,y)=
\begin{cases}
1-\lambda\mu\rho & (x,y)=(0,0),\\
1+\lambda\rho & (x,y)=(0,1),\\
1+\mu\rho & (x,y)=(1,0),\\
1-\rho & (x,y)=(1,1),\\
1 & \text{otherwise}.
\end{cases}
\]

Fixture \(m\), aged in days relative to the immutable training cutoff, receives

\[
w_m=\exp\left[-\log(2)\frac{\mathrm{age}_m}{\mathrm{halfLifeDays}}\right].
\]

The optimized objective is the negative summed weighted log likelihood plus a
configurable symmetric \(L_2\) penalty on all decoded attack/defence effects,
the intercept, and home advantage. The implementation requires every
low-score \(\tau\) term to remain positive.

### Identifiability and optimization

- Exact constraints \(\sum_i a_i=0\) and \(\sum_i d_i=0\) are imposed by
  optimizing \(N-1\) attack and \(N-1\) defence coordinates and deriving the
  final coordinates.
- The historical fixture graph must be connected. Raw and time-weighted
  fixture support must exceed configurable total, per-team, and
  per-parameter minima.
- \(\rho=\rho_{\max}\tanh(r)\) is bounded by configurable
  \(\rho_{\max}\); invalid low-score masses are rejected.
- Optimization is deterministic finite-difference Adam with a fixed
  initialization and explicit convergence gradient. Maximum-iteration or
  numerical failure is not served as a fitted model.
- Reported parameter uncertainty is a
  `DIAGONAL_PENALIZED_HESSIAN_APPROXIMATION`. It is an explicitly limited local
  curvature approximation, not a full covariance matrix or confidence
  interval.

### Score truncation and coherent markets

The raw matrix covers \(0,\ldots,G_{\max}\) goals for each team. Retained mass
and omitted tail probability are reported separately. The retained matrix is
renormalized once to produce a nonnegative \(\pi\) summing to one for coherent
market derivation. Scoreline validation uses unconditional cell mass and a
common overflow bucket rather than the conditional market matrix.

The same \(\pi\) derives home/draw/away, configurable totals, both teams to
score, home/away team totals, and unambiguous half-goal binary handicaps.
Quarter-goal and integer-push contracts are not silently approximated.

### Historical data and validation assumptions

`SettledHistoricalFixtureSchema` requires settled scores, kickoff and
availability timestamps, neutral-venue status, provenance
`HISTORICAL_DIXON_COLES`, and data-quality metadata. Duplicate fixture IDs,
canonical duplicate events, unavailable observations, and fixtures after the
training cutoff are rejected.

Validation is chronological and fixture-grouped, with expanding windows and no
random shuffling. Primary metrics are 1X2 log loss, Brier score, ranked
probability score, calibration bins, scoreline log loss, and convergence
diagnostics. Baselines are unconditional score frequency and simple
independent Poisson. The unchanged market baseline can only be compared when
compatible timestamped historical prices and settled outcomes exist.

### Adaptation to international football and limitations

The model treats national teams as stable team identifiers over the configured
half-life. This is weaker than the club-league setting in Dixon–Coles:
international schedules are sparse and uneven; competitions differ in
strength; neutral venues are common; squads, coaches, player availability, and
tactical regimes change between windows. Current code does not model squad
composition, opponent confederation, competition strength, travel, or
qualification selection effects. A full World Cup tournament alone is not
enough to identify a reliable model without broader pre-tournament history.

### Integration boundary

`HistoricalScorePriorProvider` is an independent `RESEARCH`/`REPLAY` prior and
does not replace `NullTheoProvider`. It emits
`historicalProvenance=HISTORICAL_DIXON_COLES` and
`researchStatus=RESEARCH_ONLY`.

A future Milestone 3 may estimate a pre-registered residual combination:

\[
\text{posterior logits}
=\text{market/filter logits}+\text{historical-prior residual}.
\]

That blend is not implemented here. The state-space component remains a market
filter. Directional edge must not be calculated by comparing that
market-derived filter directly with the same contemporaneous market.

### Evidence still required

- A sufficiently large, connected, settled international fixture history with
  availability timestamps and team-level effective support.
- Expanding-window out-of-sample scores and calibration with fixture-level
  uncertainty or block-bootstrap intervals.
- Half-life, regularization, truncation, and \(\rho\) sensitivity registered as
  model specifications rather than selected post hoc.
- Compatible timestamped historical market prices for a paired market-baseline
  comparison.
- Evidence across squad/coach changes and multiple competitions. Test-only
  fixtures establish code behavior, not predictive quality.
