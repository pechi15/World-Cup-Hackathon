# Two-agent quantitative research governance

## Scope

The framework in `research/quant_research` governs offline model research. It
does not replace or extend the live controller in `packages/agent`, and it does
not register candidates with `packages/theo`.

The separation is deliberate:

```text
offline data -> Quant Research Agent -> isolated challenger
                     |
                     v
              validation evidence
                     |
                     v
             Independent Critic
                     |
                     v
       deterministic promotion gate -> artifact registry

live market data -> deterministic TypeScript controller -> existing TheoProvider
```

An artifact-registry champion means “best governed offline/replay artifact for
this model family.” It does not mean “installed in production.”

## Contract inventory

`contracts.py` defines strict, frozen Pydantic models for hypotheses, features,
experiment and split specifications, metrics, calibration, observations, folds,
latency/fill assumptions, backtests, markouts, stresses, critic findings/reviews,
promotion decisions, registry events, and artifact manifests/registrations.
Unknown fields fail validation.

Every evidence object carries one immutable `EvidenceBinding`: experiment ID,
dataset SHA-256, Git commit, feature-manifest SHA-256, training cutoff,
validation-fold ID, and artifact checksum. Artifact manifests additionally
require a compatible schema version and calibration metadata. Promotion
decisions carry a deterministic hash over all evidence-driving fields.

## Agent responsibilities

### Quant Research Agent

Allowed:

- draft a typed falsifiable hypothesis through any structured model provider;
- validate a spec against a read-only dataset snapshot;
- invoke configured training, walk-forward, and backtest tools;
- generate a secret-free Colab job spec;
- write an isolated challenger;
- respond once to the first critic review.

Denied:

- final-holdout access or mutation;
- risk and promotion-policy mutation;
- wallet access;
- production deployment;
- production `TheoProvider` mutation.

### Independent Critic Agent

The critic receives read-only evidence and emits exactly one finding for each
mandatory check:

1. evidence identity;
2. leakage;
3. fixture dependence;
4. complete fold-level evidence;
5. minimum fixture count;
6. holdout contamination;
7. calibration;
8. multiple testing;
9. latency assumptions;
10. fill assumptions;
11. tail-probability reliability;
12. calibrated Kelly inputs;
13. strategy concentration;
14. academic claim versus implementation.

Missing, duplicated, or inconsistent findings fail Pydantic validation. The
current critic computes findings deterministically; a provider may assist with
explanatory prose but cannot change check outcomes.

## Holdout protocol

`seal_chronological_holdout` removes the latest fixture groups before any
walk-forward work and creates a SHA-256 commitment over their IDs, timestamps,
probabilities, outcomes, and a configured salt ID. It returns a researcher-safe
development view separately from the governance-owned private store. Only the
deterministic governance role can invoke the store; Researcher and Critic calls
fail. The store uses an atomic one-time aggregate evaluation; a second attempt fails. Any
fixture spanning the candidate boundary causes the boundary to move earlier or
the partition to be rejected.

Replay promotion can be assessed without opening the holdout. Paper promotion
requires non-synthetic TxODDS evidence and a sufficiently large, calibrated
one-time holdout result.

The seal is an audit control, not a substitute for access-controlled storage.
For a shared environment, keep the private rows in a separate service and
implement the same evaluator protocol remotely.

## Promotion policy

`PromotionGateConfig` is immutable and versioned. The default gate requires:

- non-synthetic data;
- approved round-two critic review;
- no leakage or train/test fixture overlap;
- complete, fixture-grouped chronological folds with explicit purge and embargo
  boundaries and target-availability cutoffs;
- minimum out-of-sample size;
- bounded ECE and positive Brier improvement over the declared benchmark;
- multiple-testing evidence;
- passing stress scenarios;
- bounded fixture concentration;
- future-event latency/fill evidence, explicit fees/spread/slippage, and
  observation-backed markouts whose unavailable horizons remain null;
- verified artifact checksum, schema, calibration metadata, and evidence
  bindings.

The critic review, backtest, stress results, artifact, experiment, and data
snapshot are identity-bound. Decision hashes cover all non-temporal evidence.
Champion registration recomputes the default gate decision and requires a
matching previously registered challenger. Both registries are hash-chained.

Terminal states are limited to `REJECTED`, `RESEARCH_ONLY`,
`PROMOTE_TO_REPLAY`, and `PROMOTE_TO_PAPER`. Any failed rule yields `REJECTED`. Passing replay evidence yields
`PROMOTE_TO_REPLAY`. `PROMOTE_TO_PAPER` additionally requires TxODDS data and a
passing sealed holdout. There is no live-funds decision.

## Synthetic acceptance experiment

`quant_research.synthetic` executes all eight lifecycle transitions and writes
all evidence. Its synthetic forecasts are intentionally well calibrated so the
framework—not model quality—is being tested. The deterministic gate still
rejects it solely because synthetic results cannot establish alpha or
deployment readiness.

This is the only example experiment included in this milestone.
