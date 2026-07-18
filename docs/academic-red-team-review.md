# Academic & Quantitative-Methodology Red-Team Review

**Reviewer stance:** Independent academic / quant-methodology adversary. Assume nothing works until proven; the burden of proof is on the system, not the reviewer.
**Scope reviewed:** `docs/academic-quant-methodology.md`, `docs/model-validation-and-risk.md`, `research/experiment-roadmap.md`, `research/strategy-registry.yaml`, `docs/CURSOR-QUANT-HANDOFF.md`, cross-checked against implementation in `packages/theo/`, `packages/strategies/`, `packages/quoting/`, `packages/evaluation/`, `packages/agent/`.
**Status:** Review only. **No corrections implemented.** Await approval.

---

## How to read this document

Severity legend:

- **CRITICAL** — invalidates any inference of edge/alpha; must be resolved before *any* superiority language.
- **HIGH** — materially biases results or violates a stated academic principle; resolve before promotion past `RESEARCH_ONLY`.
- **MEDIUM** — real methodological defect, but partially mitigated by existing guards or non-goals.
- **LOW** — hygiene / documentation / latent risk that will bite later.

Each finding lists: Severity · Affected model/strategy · Why problematic · Academic principle · Required test · Required empirical evidence · Recommended correction.

---

## Summary table

| # | Finding | Severity | Primary target |
|---|---------|----------|----------------|
| R1 | Theo is a filtered transform of the market mid; "edge" is a self-referential smoothing residual | **CRITICAL** | `STATE_SPACE_THEO`, `INNOVATION_RESIDUAL`, directional Kelly |
| R2 | Zero-latency execution: signal, quote, and fill share one timestamp | **CRITICAL** | Agent loop, `FRACTIONAL_KELLY_DIRECTIONAL`, maker quotes |
| R3 | Unrealistic fill model (hash-gated maker fills; taker fills at mid) not adversely selected | **CRITICAL** | Maker/taker execution, `MAKER_MARKOUT_AS` |
| R4 | Observations treated as independent; proper scores averaged over autocorrelated updates | **HIGH** | Evaluation, all scoring |
| R5 | Fixture-level / outcome-level sample size ≈ 1 | **HIGH** | All models |
| R6 | Kelly independence violated; fee-blind, unit-mismatched sizing | **HIGH** | `FRACTIONAL_KELLY_DIRECTIONAL` |
| R7 | No calibration test; uncalibrated tail probabilities feed Kelly | **HIGH** | `STATE_SPACE_THEO`, sizing |
| R8 | Multiple-testing plan ignores within-strategy researcher degrees of freedom; RC/SPA invalid at N≈1 | **HIGH** | Registry, promotion gates |
| R9 | Missing portfolio-level risk controls (correlation, mutually-exclusive over-buy, drawdown, fees) | **HIGH** | `packages/risk`, agent loop |
| R10 | Kalman filter uses fixed, un-estimated Q/R and diagonal (independent) multinomial components | **MEDIUM** | `STATE_SPACE_THEO` |
| R11 | Avellaneda–Stoikov adapted to bounded settling contracts without terminal-payoff / horizon derivation | **MEDIUM** | Quoting, `MAKER_MARKOUT_AS` |
| R12 | Probability incoherence in quote centres (per-selection leans don't preserve simplex) | **MEDIUM** | Quoting |
| R13 | Double de-vig guard depends on manual labelling; `cleanDemarginedProbabilities` still renormalizes | **MEDIUM** | `MARKET_BASELINE`, `devig.ts` |
| R14 | Sharpe ratio / variance metrics inappropriate for binary settlement P&L | **MEDIUM** | Trading validation layer |
| R15 | Unfalsifiable / post-hoc hypotheses (innovation residual, "≤ baseline" acceptance) | **MEDIUM** | Registry hypotheses |
| R16 | Markout horizons are a single instantaneous proxy; adverse-selection evidence is fictional | **HIGH** | `MAKER_MARKOUT_AS`, suspension policy |
| R17 | Hasbrouck lead–lag / information-share adaptation to single-book prediction market | **LOW** | `LEAD_LAG_DISCOVERY` (REJECTED) |

---

## R1 — Self-referential theo: the "edge" is a smoothing residual, not information

- **Severity:** CRITICAL
- **Affected:** `STATE_SPACE_THEO`, `INNOVATION_RESIDUAL`, and every downstream directional decision.
- **Why problematic:** The state-space theo is a Kalman filter whose *only* observation input is the de-vigged market probability itself (`packages/theo/src/state-space.ts` ingests `observation.probabilities`; `pipeline.ts` feeds baseline and state-space from the same `NormalizedMarketObservation`). The directional signal in the agent is `theo.probabilities - baseline.probabilities` (`packages/agent/src/index.ts` line ~113), and the Kelly "edge" is `modelProbability - marketMid` (`fractionalKelly`, `packages/strategies/src/index.ts`). Because the theo is a low-pass filter of the market mid, the difference is *mechanically* the filter's lag/smoothing residual — a function of the same price series, not an independent forecast. Any apparent profit is a bet that transient market moves mean-revert to the filter, which is (a) untested, and (b) indistinguishable from fitting autocorrelated noise. This is the classic "predicting a variable from a smoothed copy of itself" trap.
- **Academic principle:** A forecast can only be evaluated as informative relative to the information set it does *not* already contain (Gneiting & Raftery 2007 — proper scoring must be against a genuine benchmark; efficient-markets/price-discovery framing, Hasbrouck 1995). The market baseline is explicitly labelled `BENCHMARK_ONLY / NOT_PROPRIETARY_ALPHA` in the registry — a filter of that baseline inherits the same status and cannot be "alpha".
- **Required test:** (1) Information-content test — does the state-space posterior beat the *contemporaneous* market baseline in OOS proper score on held-out fixtures, using outcomes as labels (not the market as label)? (2) Orthogonality test — regress realized outcomes on `theo − market`; a genuine edge requires the residual signal to have incremental predictive power beyond the market at the decision horizon. (3) Turnover/mean-reversion attribution — decompose directional P&L into "market later reverts to filter" vs "market later confirms move".
- **Required empirical evidence:** Paired proper scores (Brier + log loss) with block-bootstrap CIs on ≥ (order 10²–10³) settled *outcomes*, on `REPLAY`/`TXODDS` data, showing the state-space strictly beats the market baseline — not merely tracks it.
- **Recommended correction:** Reclassify the state-space theo as a *denoising/uncertainty* layer, not an alpha source, until an exogenous feature set (independent of the market mid) is added (e.g., Dixon–Coles prior from results history, lineup/xG features). Forbid directional sizing whose signal is purely `filter − market`. Make the registry hypothesis explicit: the state-space is a benchmark-tracking smoother unless proven otherwise.

---

## R2 — Zero-latency execution assumption

- **Severity:** CRITICAL
- **Affected:** Agent loop, maker quoting, `FRACTIONAL_KELLY_DIRECTIONAL`.
- **Why problematic:** In `packages/agent/src/index.ts`, `asOf = event.eventTime`; the theo, the quote, and both the maker fill and the taker order all use that same timestamp, and `dataAgeMs: 0` is passed to the quote engine. The directional taker order executes at `marketMid` of the *same tick* that produced the signal. This assumes decision, network, and matching latency are all zero and that you can trade on the very print that carried the information. Real systems act on prices at `t + δ`, after the market has already partly moved. Zero latency is the strongest possible optimistic bias for any reactive/mean-reversion signal.
- **Academic principle:** Realistic execution requires the information set at decision time to exclude the contemporaneous, not-yet-actionable print (microstructure realism; Glosten & Milgrom 1985 — informed order flow moves price before you fill).
- **Required test:** Latency-shift ablation — re-run the loop pricing/filling at `t + δ` for δ ∈ {250 ms, 1 s, 5 s, next-tick} and report P&L / markout decay vs δ. A signal that only survives at δ = 0 is not tradeable.
- **Required empirical evidence:** P&L and proper-score deltas as a function of δ, plus the measured update cadence of TxLINE to justify the chosen δ grid.
- **Recommended correction:** Introduce an explicit latency model: decisions at event time `t` may only execute against prices timestamped ≥ `t + δ`. Set `dataAgeMs` to the true age. Document δ as a first-class assumption in the methodology doc.

---

## R3 — Unrealistic fill modelling

- **Severity:** CRITICAL
- **Affected:** Maker and taker execution, `MAKER_MARKOUT_AS`, all P&L.
- **Why problematic:** Maker fills are gated by `(event.dedupeKey.charCodeAt(0) % 100)/100 < makerFillProbability` (`packages/agent/src/index.ts` ~line 131) — a deterministic hash of a string, with a *constant* fill probability, independent of whether price crossed the quote, queue position, or the direction of subsequent flow. Fill side is `charCodeAt(1) % 2`. Taker orders fill at `marketMid` (no spread paid, no slippage). Consequently fills are **not adversely selected**: in reality a resting maker quote is disproportionately filled precisely when it is stale/wrong (the informed trader picks you off), which is the entire premise of Glosten–Milgrom (1985) cited in the registry. A fill model uncorrelated with information systematically overstates maker P&L and understates adverse selection.
- **Academic principle:** Glosten & Milgrom (1985): quoted spreads exist to compensate for asymmetric-information order flow; fills must be correlated with mispricing. Taker cost realism: you cross the spread, you don't trade at mid.
- **Required test:** (1) Fill-conditioning test — verify P(fill) rises when the quote is on the wrong side of the next mid move; (2) taker slippage test — price takers at the far touch + modelled impact, not mid; (3) sensitivity of all P&L to fill probability and to spread paid.
- **Required empirical evidence:** From `REPLAY`/paper fills: markout conditioned on fill, showing negative maker markout on average (adverse selection present) rather than the current fiction.
- **Recommended correction:** Replace hash-gated fills with a model where maker fills occur only when the market trades through the quote price and fill likelihood/side correlate with subsequent price movement (adverse selection); price takers at the offered side plus an impact/fee term. Until then, label all P&L as non-evidentiary.

---

## R4 — Dependence between observations / proper scores averaged over autocorrelated updates

- **Severity:** HIGH
- **Affected:** `packages/evaluation/src/index.ts` (`summarizeProperScores`, `compareWithMarketBaseline`), all scoring claims.
- **Why problematic:** `summarizeProperScores` averages Brier/log loss over observations and reports `sampleSize = observations.length`. If observations are per-*update* within a fixture (48 updates on one match), they are the same latent outcome observed many times and are massively autocorrelated. Reporting `sampleSize = 48` implies 48 independent draws; the *effective* sample size is closer to the number of distinct settled outcomes (≈ 1). This understates variance and inflates confidence in any score difference by an order of magnitude or more.
- **Academic principle:** Independence/effective-sample-size for variance estimation; White (2000) and Hansen (2005) explicitly require block/stationary bootstrap because financial series are serially dependent.
- **Required test:** Compute proper scores at the *outcome* level (one score per settled market), or use block-bootstrap CIs with blocks = fixtures. Report effective sample size, not raw update count.
- **Required empirical evidence:** Autocorrelation of per-update scores within a fixture; comparison of naive vs block-bootstrap CI widths.
- **Recommended correction:** Change scoring to aggregate to one observation per settled outcome (or per fixture) before averaging; attach block-bootstrap CIs; surface `effectiveSampleSize` distinct from `sampleSize` in `ProperScoreSummary`.

---

## R5 — Insufficient fixture-level sample size

- **Severity:** HIGH (well acknowledged in docs, but restated for correctness)
- **Affected:** All models; acutely `DIXON_COLES_PRIOR`, `RESIDUAL_LOGISTIC`, `REGIME_HMM`.
- **Why problematic:** Available data is 1 fixture, 15 sanitized updates (synthetic shock), ~48 historical updates. The docs correctly refuse alpha claims and set `REJECTED` on data-hungry models. The subtle point: what matters is the count of *independent settled outcomes* and, for Dixon–Coles, matches per team. World Cup national-team schedules are inherently sparse (a team plays a handful of matches), so even a full tournament yields tiny per-parameter N and unstable `ρ`, attack/defence strengths. No calibration, bootstrap, regime detection, or lead–lag analysis is admissible at this N.
- **Academic principle:** Degrees-of-freedom / estimator consistency; Dixon & Coles (1997) rely on many league fixtures with slowly-varying strengths — a regime the World Cup violates.
- **Required test:** Pre-registration of minimum outcome-level N per model (open decision #4 in the handoff). Power analysis: what N is needed to detect a plausible Brier improvement with the observed score variance?
- **Required empirical evidence:** A documented count of settled outcomes and matches-per-team available before each model is un-`REJECTED`.
- **Recommended correction:** Keep the data-hungry models `REJECTED` (as they are). Add explicit numeric N-gates to `promotion_gates`. For Dixon–Coles, plan to borrow strength from pre-tournament league/international history rather than tournament-only data.

---

## R6 — Kelly misuse: independence violation, fee-blindness, unit mismatch

- **Severity:** HIGH
- **Affected:** `FRACTIONAL_KELLY_DIRECTIONAL` (`packages/strategies/src/index.ts`, applied per selection in `packages/agent/src/index.ts`).
- **Why problematic:** Three distinct problems:
  1. **Independence violated.** `fractionalKelly` is the single-bet binary formula `f* = (p − c)/(1 − c)` (correct in isolation), but the agent loop calls it *independently for every selection* of a mutually-exclusive 1X2 market and across correlated fixtures. Simultaneous bets on mutually-exclusive/correlated outcomes require the *multivariate* Kelly solution; independent sizing can even buy every outcome of a market (guaranteed loss after fees) or double-count correlated risk. Kelly (1956) assumes one bet resolved before the next / independent gambles.
  2. **Fee-blind, wrong price.** `edge = p − marketMid` uses the mid, not the executable ask, and ignores fees (`portfolio` tracks `feesPaid` but Kelly does not). Both inflate the edge and hence the stake.
  3. **Unit mismatch.** Kelly `f*` is a *fraction of bankroll to stake*; the code sets `size = bankroll · fraction` and then uses `size` as an order *quantity* at `price = marketMid` (notional = size·price). Fraction-of-bankroll and contract-quantity are different units; the hard caps (`maxPosition`, exposures) are then applied to this mixed quantity.
- **Academic principle:** Kelly (1956) log-optimal growth for independent bets; multivariate Kelly for simultaneous correlated positions; sizing must be on *net-of-cost* edge.
- **Required test:** (1) Guaranteed-loss test — assert the sum of stakes across mutually-exclusive selections cannot create a book you always lose on after fees; (2) unit test that stake is applied consistently (notional vs quantity); (3) fee-inclusive edge test.
- **Required empirical evidence:** Sensitivity of growth-rate / drawdown to the correlation assumption and to fee level; demonstration that per-selection independent sizing over-bets vs the joint solution.
- **Recommended correction:** Move to a joint (per-market, per-fixture) Kelly with an explicit covariance/mutual-exclusivity constraint; compute edge net of fees against the executable price; fix the stake-vs-quantity unit; keep the `{0, 0.10, 0.25}` fractional caps. Also add the ability to fade overpriced selections (currently `side` is always `BUY`).

---

## R7 — Uncalibrated tail probabilities feeding Kelly

- **Severity:** HIGH
- **Affected:** `STATE_SPACE_THEO` outputs → `FRACTIONAL_KELLY_DIRECTIONAL`.
- **Why problematic:** There is no calibration/reliability test anywhere in the pipeline. The theo uses `softmax` on additive log-odds with `logit` clipped to `1e-9` (`devig.ts`), i.e. |logit| up to ≈ 20.7, permitting probabilities arbitrarily close to 0/1. Kelly sizing is extremely sensitive to `p` in the tails (`f* = (p−c)/(1−c)`); a mis-estimated near-certain probability produces very large stakes — exactly the blow-up mode the risk doc warns about. Softmax outputs are *coherent* (sum to 1) but coherence ≠ calibration.
- **Academic principle:** Proper scoring decomposes into calibration + refinement (Gneiting & Raftery 2007; Brier 1950); Kelly sensitivity to probability error (risk doc's own note).
- **Required test:** Reliability diagrams / calibration curves and calibration-in-the-large on held-out outcomes; a tail stress test injecting probability error and observing Kelly stake and drawdown.
- **Required empirical evidence:** Calibration statistics (e.g. ECE, reliability slope) on `REPLAY`/`TXODDS` outcomes before any sizing is enabled.
- **Recommended correction:** Add a calibration layer (isotonic/Platt) and a calibration gate to promotion; clip probabilities used for *sizing* to a conservative band (e.g. [0.02, 0.98]) and/or shrink toward the market; forbid Kelly on selections whose calibration is unverified.

---

## R8 — Multiple-testing plan ignores within-strategy researcher degrees of freedom

- **Severity:** HIGH
- **Affected:** `promotion_gates` (registry), White (2000) / Hansen (2005) plan.
- **Why problematic:** The registry commendably gates superiority claims behind Reality Check / SPA. But (a) RC/SPA are **not started**, and (b) they are planned over the *set of strategies* (~8), while the real data-snooping surface is the *hyperparameter space within* each strategy: `processVariance`, `observationVariance`, `initialVariance`, `staleAfterMs`, `staleObservationVarianceMultiplier`, `informationShockProcessVariance`, `maximumUncertainty`, `innovationSuspendThreshold`, `kellyFraction`, quote-config coefficients. Tuning these on the same 15/48 updates and then reporting the best is uncorrected multiple testing. Additionally, RC/SPA bootstrap null distributions are meaningless at N ≈ 1 outcome.
- **Academic principle:** White (2000) Reality Check and Hansen (2005) SPA correct for the *full* universe of specifications searched, not a hand-picked subset.
- **Required test:** Enumerate and log every specification/hyperparameter grid evaluated; apply RC/SPA (block bootstrap) over that full universe once outcome-level N is adequate.
- **Required empirical evidence:** A specification-count ledger; RC/SPA p-values with block bootstrap on non-synthetic data with sufficient outcomes.
- **Recommended correction:** Pre-register hyperparameters (fix Q/R by estimation, not search — see R10), log the specification universe, and defer RC/SPA until N supports a valid bootstrap. Keep `forbid_synthetic_alpha_claims: true`. Add "hyperparameter search counts as multiple testing" to the failure-modes list.

---

## R9 — Missing portfolio-level risk controls

- **Severity:** HIGH
- **Affected:** `packages/risk` limits, agent loop.
- **Why problematic:** Existing controls (max position / exposure / worst-case loss, kill switch, quote suspension, null-theo → no trade) are per-position/per-market and genuinely good. Gaps: (1) **Correlation** — World Cup outcomes are strongly correlated (group standings, "team X wins group" vs "team X wins match"); there is no cross-fixture correlation or scenario-based worst-case limit. (2) **Mutually-exclusive over-buy** — nothing prevents simultaneously buying multiple 1X2 selections into a guaranteed-loss book (see R6). (3) **Fees** — edge and limits ignore transaction costs. (4) **Drawdown / daily loss** — worst-case-loss is a static bound, not a realized-drawdown or daily-loss stop. (5) **Adverse-selection suspension** is triggered by `standardizedInnovationMagnitude`, but that magnitude is not truly standardized (R10) and the markout it should be validated against is fictional (R16).
- **Academic principle:** Portfolio risk is driven by covariance, not marginal position size; guaranteed-loss arbitrage constraints on complete outcome sets.
- **Required test:** Scenario/joint-outcome worst-case across correlated fixtures; a book-consistency check across mutually-exclusive selections; drawdown-stop unit test.
- **Required empirical evidence:** Distribution of realized drawdown and joint-scenario losses under replay.
- **Recommended correction:** Add correlation/scenario-based portfolio limits, a complete-book guaranteed-loss guard, fee-aware exposure, and a realized-drawdown/daily-loss kill trigger. These belong in `packages/risk` (agents may not mutate — good).

---

## R10 — Kalman filter: fixed un-estimated Q/R and diagonal multinomial

- **Severity:** MEDIUM
- **Affected:** `STATE_SPACE_THEO`, `INNOVATION_RESIDUAL` (`packages/theo/src/state-space.ts`).
- **Why problematic:** `processVariance` (0.002), `observationVariance` (0.03), `initialVariance` (0.03), and shock variance (0.05) are hard-coded defaults, not estimated from data (no MLE/EM). Misspecified Q/R make the "standardized innovation" (`innovation / sqrt(P + R)`) *not* actually standardized, so the `innovationSuspendThreshold` and shock logic are calibrated against an arbitrary scale. Separately, the filter treats the K−1 additive-log-ratio components with a **diagonal** covariance (`variance` is a per-component array; gains computed componentwise). Multinomial/ALR components are inherently correlated; a diagonal filter misrepresents the joint uncertainty and makes the averaged `standardizedInnovationMagnitude` (mean of |z| across components) statistically ill-defined.
- **Academic principle:** Kalman (1960) optimality holds only for correctly specified Q/R and the full covariance `P`; innovation whiteness/standardization is the standard filter-consistency diagnostic.
- **Required test:** Innovation whiteness and normalized-innovation-squared (NIS) consistency tests; likelihood-based estimation of Q/R (EM); compare diagonal vs full-covariance ALR filter.
- **Required empirical evidence:** NIS within χ² bounds; estimated (not assumed) Q/R with CIs on real data.
- **Recommended correction:** Estimate Q/R by maximum likelihood/EM on real update series; either carry the full ALR covariance or justify the diagonal approximation with a whiteness test; re-derive the shock threshold from properly standardized innovations.

---

## R11 — Avellaneda–Stoikov adapted to bounded settling contracts without re-derivation

- **Severity:** MEDIUM
- **Affected:** Quoting (`packages/quoting/src/index.ts`), `MAKER_MARKOUT_AS`.
- **Why problematic:** Avellaneda & Stoikov (2008) assume a mid price following arithmetic Brownian motion on an unbounded scale with a terminal horizon `T` and inventory penalty `q·γ·σ²·(T−t)`. A prediction-market contract is bounded in [0,1] and *settles to 0 or 1 at match end* — the terminal payoff is a Bernoulli, not Gaussian, and inventory risk is bounded and highly asymmetric near 0/1. The implementation does not use the A–S reservation-price/optimal-spread closed form at all; `calculateHalfWidth` is a linear combination of ad-hoc coefficients (uncertainty, volatility, movement, staleness, concentration, inventory) with `recentVolatility = min(0.2, innovation·0.05)` as a proxy for σ. Citing A–S for this is an over-claim.
- **Academic principle:** A–S optimality is a solved HJB under specific dynamics; transplanting it requires re-deriving under bounded/settling dynamics or dropping the citation.
- **Required test:** Derive (or simulate) optimal maker spreads under bounded-contract dynamics and compare to the linear width heuristic; verify width behaves sensibly as `p → 0/1` (inventory near a boundary is far riskier).
- **Required empirical evidence:** Simulation showing the width policy controls inventory variance and adverse markout under realistic (R3) fills.
- **Recommended correction:** Either re-derive an A–S-style reservation price for bounded settling contracts (finite horizon = match end; boundary-aware inventory penalty) or downgrade the citation to "inspired by / heuristic" in the methodology doc, keeping the traceability table honest.

---

## R12 — Probability incoherence in quote centres

- **Severity:** MEDIUM
- **Affected:** Quoting (`packages/quoting/src/index.ts`).
- **Why problematic:** Quote centres are computed per selection: `center = clip(probability + inventoryLean + directionalLean, 0.01, 0.99)`, with `directionalLean = (theo − baseline)·confidence` and independent clipping. Across the selections of a market these adjusted centres need not sum to 1 (they can imply an overround/underround or an incoherent implied book), and `confidence = max(0, 1 − uncertainty)` mixes an ALR-space standard deviation (R10) with a [0,1] weight — dimensionally inconsistent. The theo itself is coherent (softmax), but the *quoting layer* can break coherence.
- **Academic principle:** Mutually-exclusive-exhaustive outcome prices must form a coherent (arbitrage-consistent) book.
- **Required test:** Assert Σ(centre) and the implied book across selections stays within a documented tolerance; check no cross-selection arbitrage is quoted.
- **Required empirical evidence:** Distribution of Σ(centre) across markets under replay.
- **Recommended correction:** Apply leans in log-odds/ALR space and renormalize across selections before setting centres; define `confidence` on a proper scale (e.g. map ALR-variance to a probability-space quantity).

---

## R13 — Double de-vig guard relies on manual labelling; clean path still renormalizes

- **Severity:** MEDIUM
- **Affected:** `MARKET_BASELINE`, `packages/theo/src/devig.ts`.
- **Why problematic:** The guard (`proportionalDevig` throws on `"ALREADY_DEMARGINED"`) is good but depends on the *caller* correctly tagging semantics; there is no automatic StablePrice detection, and open decision #1 (which TxLINE field is the market probability) is still unresolved. Meanwhile the sanitized fixture still de-vigs decimal `Prices`, and `cleanDemarginedProbabilities` divides by the mass (`p / mass`) with a 2% tolerance — i.e. it *does* perform a small renormalization even on the "already de-margined" path, which is a partial second de-vig / distortion if the vector is genuinely consensus output. The methodology's own rule says "numerical clip only" for de-margined inputs.
- **Academic principle:** Do not remove overround twice; StablePrice per TxLINE docs is already de-margined.
- **Required test:** The planned regression test (fail if a near-sum-1 vector is passed to `proportionalDevig`) — plus a test that `cleanDemarginedProbabilities` does not materially move an already-normalized vector (only clips), and a field-provenance audit test.
- **Required empirical evidence:** Authenticated-sample audit documenting which field (`Prices` / `Pct` / StablePrice) is the market probability and its sum-to-one behaviour.
- **Recommended correction:** Resolve the canonical-field decision from authenticated samples; add automatic detection (sum ≈ 1 ⇒ treat as de-margined) as defence-in-depth; make the clean path clip rather than renormalize when the input is already de-margined; ship the regression test (currently "Required next").

---

## R14 — Sharpe ratio / variance metrics inappropriate for binary settlement P&L

- **Severity:** MEDIUM
- **Affected:** Trading validation layer (`model-validation-and-risk.md` §Validation layers item 3: "drawdown, inventory variance").
- **Why problematic:** Sharpe is not yet computed (good), but the validation layer leans on variance-type trading metrics, and there is a standing temptation to report a Sharpe ratio. Sharpe assumes approximately i.i.d., roughly Gaussian returns and a meaningful annualization. Prediction-market settlement P&L is (i) binary/highly non-Gaussian per position, (ii) serially dependent and event-clustered (R4), (iii) small-N with no natural periodic frequency to annualize. A Sharpe on such series is uninterpretable and easily gamed.
- **Academic principle:** Sharpe-ratio validity requires stationarity/near-normality and independence; deflated Sharpe (Bailey & López de Prado) exists precisely because naive Sharpe is inflated under multiple testing and non-normality.
- **Required test:** If any risk-adjusted metric is used, use proper scores + realized drawdown + block-bootstrap CIs; if Sharpe is reported at all, report a deflated/adjusted variant with the number of trials.
- **Required empirical evidence:** Return-distribution diagnostics (skew/kurtosis, autocorrelation) demonstrating whether any variance-ratio metric is even meaningful.
- **Recommended correction:** Explicitly state in the validation doc that Sharpe is **not** a promotion metric for settlement P&L; rely on proper scoring, calibration, drawdown, and adverse markout with bootstrap CIs.

---

## R15 — Unfalsifiable / post-hoc hypotheses

- **Severity:** MEDIUM
- **Affected:** Registry hypotheses, esp. `INNOVATION_RESIDUAL`, `STATE_SPACE_THEO` acceptance.
- **Why problematic:** `INNOVATION_RESIDUAL`'s hypothesis — "standardized innovations carry short-lived residual edge after shocks" — has no pre-registered horizon, effect size, or threshold, so it can be tuned post-hoc (`λ`, `innovationSuspendThreshold`) to fit whatever the data shows; it is currently unfalsifiable. `STATE_SPACE_THEO`'s acceptance criterion "OOS log loss **≤** market baseline" allows a tie, and since the theo is a smoother of the market (R1) it can *track* but is structurally unlikely to *beat* — so "≤" is nearly always satisfied trivially and does not constitute an edge test.
- **Academic principle:** Falsifiability / pre-registration; a hypothesis must forbid some observable outcome. Proper-score comparisons need a strict-improvement bar with CIs.
- **Required test:** Pre-register each hypothesis with: signal definition, horizon, direction, minimum effect size, and a stopping rule; require *strict* improvement (`<`) beyond a CI, not `≤`.
- **Required empirical evidence:** Out-of-sample confirmation of the pre-registered prediction with block-bootstrap CIs on adequate N.
- **Recommended correction:** Rewrite registry hypotheses as falsifiable statements with quantitative acceptance thresholds; change "≤ baseline" to "strictly beats baseline by ≥ Δ with 95% block-bootstrap CI excluding 0".

---

## R16 — Markout horizons are a single instantaneous proxy

- **Severity:** HIGH
- **Affected:** `MAKER_MARKOUT_AS`, adverse-selection suspension policy.
- **Why problematic:** `computeMarkouts` (`packages/evaluation/src/markout.ts`) returns the *same* instantaneous value for all four horizons: `{ m10: instant, m30: instant, m60: instant, m300: instant }`, using the current mid as a proxy for future mids. The whole point of the 10/30/60/300 s markout ladder (roadmap Milestone 4) is to measure how fills decay *over time* — the current implementation cannot detect adverse selection at all, and any suspension policy "validated" against it is validated against a constant. Combined with R3 (fills not adversely selected), the adverse-selection evidence chain is presently fictional.
- **Academic principle:** Markout / adverse-selection measurement requires forward price paths at each horizon (Glosten & Milgrom 1985).
- **Required test:** Compute markout against actual future mids at each horizon from the event stream; verify the four horizons differ and that maker markout is negative on average under realistic fills.
- **Required empirical evidence:** Horizon-resolved markout curves from `REPLAY`/paper data.
- **Recommended correction:** Buffer the forward price path and compute true 10/30/60/300 s markouts; only then use them to inform width/suspension. Until then, mark the markout outputs as placeholders and do not cite adverse-selection results.

---

## R17 — Hasbrouck lead–lag / information share on a single-book prediction market

- **Severity:** LOW (strategy is correctly `REJECTED`)
- **Affected:** `LEAD_LAG_DISCOVERY`, `REGIME_HMM` (both `REJECTED`, Milestone 5).
- **Why problematic:** Hasbrouck (1995) information shares / VECM require *multiple cointegrated venues* trading the same security with continuous prices. TxLINE StablePrice is already a *consensus aggregation* across books — so provider-level lead–lag may be unobservable by construction (the disaggregated feeds are not exposed), and applying VECM to a single consensus series is ill-posed. The registry already blocks this ("Multi-provider observability not yet confirmed"), which is correct.
- **Academic principle:** Price-discovery decomposition requires observable multi-venue microstructure and cointegration.
- **Required test:** Confirm multi-provider raw feeds exist and are cointegrated before any information-share estimation; Granger/VECM diagnostics.
- **Required empirical evidence:** Documented availability of ≥2 independent provider price series over a meaningful horizon.
- **Recommended correction:** Keep `REJECTED` until multi-provider raw data is confirmed; note that consensus StablePrice cannot be decomposed into provider information shares.

---

## What the system already does well (for balance)

These are genuine strengths and should be preserved:

- **Look-ahead defences in the filter:** `LOOKAHEAD_OBSERVATION_REJECTED` and `OUT_OF_ORDER_OBSERVATION_REJECTED` guards, `asOf` gating (`state-space.ts`). This directly addresses classic look-ahead bias at the observation layer (the residual look-ahead risk is in *execution*, R2).
- **Explicit benchmark honesty:** MarketBaseline is tagged `BENCHMARK_ONLY / NOT_PROPRIETARY_ALPHA`; the registry forbids `APPROVED_FOR_LIVE_FUNDS`.
- **Double-de-vig awareness:** the hazard is documented and a guard exists (R13 refines it).
- **Proper scoring infrastructure** and paired comparison with length checks (`compareWithMarketBaseline`).
- **Refusal of alpha claims** on synthetic / ~48-update integration data across all five documents.
- **Hard-limit ownership** in `packages/risk` that research agents may not mutate.
- **Fixed academic milestone order** and data-policy discipline (audit before training).

The disciplined *documentation* is ahead of the *implementation*; most CRITICAL/HIGH findings are places where the code does not yet honour the doc's own stated principles.

---

## Recommended gating additions (for discussion, not yet implemented)

1. No directional sizing while the only signal is `filter − market` (R1).
2. Latency-shifted execution mandatory before any P&L is reported (R2).
3. Adverse-selection-consistent fill model + true horizon markouts before Milestone 4 acceptance (R3, R16).
4. Outcome-level (not update-level) scoring with block-bootstrap CIs; report effective N (R4).
5. Numeric outcome-level N-gates per model; keep data-hungry models `REJECTED` (R5).
6. Joint, fee-aware, unit-correct Kelly with a guaranteed-loss guard (R6, R9).
7. Calibration gate (reliability + ECE) before sizing; conservative tail clipping (R7).
8. Specification-universe ledger; RC/SPA only when N supports a valid bootstrap (R8).
9. Estimate Q/R (EM/MLE); innovation whiteness/NIS test (R10).
10. Falsifiable, pre-registered hypotheses with strict-improvement bars (R15).

---

## Reviewer's bottom line

The **methodology and governance are strong and unusually honest**; the **implementation currently violates several of its own principles** in ways that would make any measured "edge" an artifact rather than alpha. The three CRITICAL findings (self-referential theo R1, zero-latency execution R2, unrealistic fills R3) each independently invalidate profitability inference; together they mean **no P&L or edge number from the current pipeline should be reported as evidence**, consistent with the docs' own stance. The proper next steps are the corrections above — but per instruction, **none have been implemented; awaiting approval.**
