# Quantitative research and model governance

This directory is an offline Python package for two role-separated agents:

1. `QuantResearchAgent` proposes and evaluates challenger models.
2. `IndependentCriticAgent` independently checks every mandatory model-risk concern.

The TypeScript trading loop remains deterministic. Nothing in this package is
imported by `packages/agent` or `packages/theo`, and challenger artifacts have no
write path to the production `TheoProvider`.

## Safety boundary

The researcher can propose, validate a spec, train, run walk-forward evaluation,
make one revision, generate a Colab job spec, and write an isolated challenger.
It cannot modify:

- the sealed final holdout;
- risk limits or promotion-gate code;
- wallet permissions;
- production deployment;
- the production `TheoProvider`.

The critic has read-only experiment/diagnostic tools plus an append-only review
writer. It checks leakage, fixture dependence, calibration, multiple testing,
latency, fills, tail reliability, Kelly use, concentration, and academic
claim/implementation consistency. A critic approval is evidence, not a
promotion decision.

Only `DeterministicPromotionGate` can emit a terminal decision. Synthetic
evidence is always rejected, regardless of metric quality.

## Bounded workflow

```text
PROPOSED
  -> SPEC_VALIDATED
  -> TRAINED
  -> WALK_FORWARD_EVALUATED
  -> CRITIC_REVIEWED
  -> REVISED_ONCE
  -> FINAL_REVIEW
  -> REJECTED | RESEARCH_ONLY | PROMOTE_TO_REPLAY | PROMOTE_TO_PAPER
```

There is no transition back to training, no second revision, and no live-funds
state. Role checks are enforced on every transition.

## Validation and execution evidence

- Every report, fold, review, registry event, artifact, and decision is bound to
  experiment, dataset, Git commit, feature manifest, training cutoff,
  validation fold, and artifact checksum.
- Chronological expanding walk-forward folds are grouped by fixture and train
  only on targets available before explicit purge and embargo boundaries.
- The final chronological holdout is hash-sealed and can be scored once only by
  a governance-owned store. Researcher tools receive an immutable development
  view and the seal, never the store or holdout rows.
- Calibration reports Brier score, log loss, ECE, maximum calibration error,
  calibration intercept, and slope.
- Multiple testing uses a declared trial count and a conservative Bonferroni
  adjustment. A production study may replace the statistical implementation
  with a registered White Reality Check or Hansen SPA tool without weakening
  the contract.
- Backtests reject same-tick execution, move each order to its latency-adjusted
  arrival time, apply explicit fill, queue, shared-liquidity, size, spread,
  slippage, and fee assumptions, and
  calculate staleness-bounded future 10/30/60/300-second markouts.
- Stress scenarios multiply latency/slippage, reduce queue fills, and widen the
  book. Missing settlement returns produce null P&L/drawdown and no Sharpe;
  markout proxies are never relabelled as realized P&L.

## Registries

`ExperimentRegistry` is an append-only, hash-chained JSONL ledger with immutable
experiment IDs and duplicate-event rejection. Store the
full spec, artifact manifest, validation/backtest/stress reports, both critic
reviews, bounded revision, and promotion decision as lifecycle events.

`ArtifactRegistry` is also hash-chained and verifies artifact bytes, schema
version, and calibration metadata. Training can only register a
`CHALLENGER`. A `CHAMPION` registration requires the identical registered
challenger plus a decision that re-verifies against the default deterministic
gate and all bound evidence. Registry promotion does not install the artifact
into production.

## Provider and Colab adapters

Agent text generation uses the provider-neutral `StructuredModelProvider`
protocol. `PerplexityAgentProvider` calls `POST /v1/agent` with a strict
Pydantic-derived JSON schema. It is disabled unless `PERPLEXITY_API_KEY` is
present:

```powershell
$env:PERPLEXITY_API_KEY = "..."
$env:PERPLEXITY_MODEL = "openai/gpt-5.6-sol" # optional
```

The key is read at runtime and must never be placed in a job spec or registry.
No provider is called by validation, backtesting, critic checks, promotion, or
the live controller.

`generate_colab_job_spec` produces a reproducible, secret-free spec whose output
must end in `/challengers`. It does not submit a job or deploy an artifact.

## Install and verify

```powershell
Set-Location E:\Hackathons\World-Cup-quant\research
py -m pip install -e ".[dev]"
py -m pytest
py -m ruff check quant_research tests
py -m mypy quant_research
```

Run the single synthetic lifecycle example from this directory:

```powershell
py -m quant_research.synthetic
```

It writes a complete ledger, challenger registration, and summary under
`examples/output/synthetic-e2e`. The expected result is `REJECTED` with
`SYNTHETIC_PIPELINE_VALIDATION_ONLY`; the holdout remains sealed and the
production `TheoProvider` remains untouched.
