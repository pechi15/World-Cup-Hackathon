# Final offline research framework status

## Authoritative state

- Branch: `cursor/quant-agents`
- Verified source revision: `6f9c529448b992cf5ac775e953f6cd329d056bcb`
- Final milestone commit: the commit containing this report; its hash is reported
  after commit because a Git commit cannot contain its own hash.
- Scope: offline two-agent research governance, State-Space market filtering,
  and Dixon–Coles historical-score research only.
- Production integration: none. `NullTheoProvider` remains the production
  default, and no wallet, execution, quoting, portfolio, or risk interface was
  changed by the governance milestone.

The framework is implementation-complete for this milestone. Evidence is
immutably bound to experiment ID, dataset SHA-256, Git commit, feature-manifest
SHA-256, training cutoff, validation fold, and artifact checksum. Researcher
and Critic roles cannot issue terminal decisions or evaluate the sealed
holdout. Only deterministic governance can emit one of:
`REJECTED`, `RESEARCH_ONLY`, `PROMOTE_TO_REPLAY`, or `PROMOTE_TO_PAPER`.
There is no real-money promotion state.

## Governance controls

- Chronology uses `event_time`, `available_at`, `decision_time`, and
  `target_available_at`.
- Walk-forward folds are chronological and fixture-grouped. Training targets
  must be available before explicit purge and embargo boundaries.
- The holdout is the latest strictly chronological fixture partition. Its rows
  remain in a governance-owned store; Researcher and Critic evaluation calls
  fail, and governance can evaluate it once.
- Experiment and artifact registries are append-only hash chains. Duplicate
  experiment IDs/events and duplicate artifact-role registrations fail.
- Challenger registration verifies artifact bytes, checksum, schema version,
  calibration metadata, and immutable evidence identity.
- Champion registration requires the identical verified challenger and
  re-verifies the complete decision with the default deterministic gate.
- The Critic independently checks evidence identity, fold completeness,
  fixture counts and overlap, leakage, holdout contamination, calibration,
  multiple testing, execution realism, tails, calibrated Kelly inputs,
  concentration, and academic claims.
- Backtests reject same-tick fills, use future availability and latency, deplete
  shared liquidity, and account for fees, spread, and slippage. Markouts use
  actual future observations; missing horizons remain null and negative
  markouts remain negative.
- Settlement P&L, drawdown, return, and Sharpe values are never synthesized.
  Metrics with those names require underlying return IDs. Stress reports leave
  P&L and drawdown null when settlement returns are absent.

## Files created

Research framework:

- `research/pyproject.toml`
- `research/uv.lock`
- `research/README.md`
- `research/quant_research/__init__.py`
- `research/quant_research/agents.py`
- `research/quant_research/backtest.py`
- `research/quant_research/colab.py`
- `research/quant_research/contracts.py`
- `research/quant_research/critic.py`
- `research/quant_research/evidence.py`
- `research/quant_research/interfaces.py`
- `research/quant_research/promotion.py`
- `research/quant_research/providers.py`
- `research/quant_research/registry.py`
- `research/quant_research/synthetic.py`
- `research/quant_research/validation.py`
- `research/quant_research/worker.py`
- `research/quant_research/workflow.py`
- `research/tests/test_framework.py`

Historical-score research:

- `data/samples/historical/test-only/dixon-coles-fixtures.json`
- `packages/evaluation/src/dixon-coles-validation.ts`
- `packages/theo/src/dixon-coles.ts`
- `packages/theo/src/historical-data.ts`
- `packages/theo/src/historical-score-prior.ts`
- `packages/theo/src/score-markets.ts`
- `tests/dixon-coles.test.ts`

Governance documentation:

- `docs/quant-research-governance.md`
- `docs/FINAL-RESEARCH-FRAMEWORK-STATUS.md`

## Verification

Final checks on 18 July 2026:

- `uv run pytest`: **21 passed**
- `uv run ruff check .`: **all checks passed**
- `uv run mypy research/quant_research`: **15 source files, no issues**
- `npm.cmd run typecheck`: **passed**
- `npm.cmd test`: **5 test files, 64 tests passed**
- Synthetic end-to-end lifecycle: **completed successfully**

The Python checks used the installed `uv.exe` by absolute path because its
scripts directory was not on `PATH`; the invoked `uv run` subcommands were
otherwise unchanged.

## Exact synthetic lifecycle outcome

- Experiment: `SYNTHETIC-GOVERNANCE-E2E-001`
- Critic approved: `false`
- Deterministic decision/final state: `REJECTED`
- Decision hash:
  `a05e9203ab8aaebca2390e24c8d23051afcf8ea8622aa2be1e983740a4688d7a`
- Holdout seal:
  `ed4b7a65433b8be61e37de26bd9ffd6006656e24a9fdeeb0094ceeb944a8e042`
- Holdout evaluated: `false`
- Registry events: `8`
- Production `TheoProvider` modified: `false`
- Passed gate rules: evidence binding, artifact calibration/schema,
  calibration ECE, chronology/embargo, feature-manifest verification,
  fold-level evidence, latency/fills, OOS sample, fixture separation,
  no leakage, Brier improvement, concentration, and stress accounting.
- Failed gate rules: `FINAL_CRITIC_APPROVED`, `MULTIPLE_TESTING`, and
  `NON_SYNTHETIC_EVIDENCE`.
- Required reason codes were present:
  `SYNTHETIC_PIPELINE_VALIDATION_ONLY` and `NO_ALPHA_CLAIM`.

The Critic rejected the synthetic study because no settlement returns were
invented for multiple-testing evidence. Independently, the deterministic gate
rejected synthetic provenance, so it could not reach paper promotion.

## Remaining limitations

1. No real settled, point-in-time dataset has passed the framework's data,
   calibration, execution, and sealed-holdout gates.
2. The local holdout store enforces role and one-time evaluation in process.
   Shared research requires a separately permissioned service implementing the
   same contract; a hash seal alone is not an infrastructure ACL.
3. There is no validated settlement-return stream. Consequently, the framework
   reports no realized P&L, drawdown, or Sharpe.
4. Dixon–Coles prediction quality is not established by deterministic test
   fixtures. International-team regime changes, squads, competition effects,
   and parameter uncertainty still require real-data evaluation.
5. State-Space output remains a market filter, not independent directional
   alpha, and cannot be evaluated against the same input market as if it were
   an independent edge.
6. Artifact storage is local JSONL plus caller-supplied bytes. Durable remote
   object locking, signing, retention, and multi-process transactional locking
   remain deployment work.
7. `PROMOTE_TO_PAPER` still requires non-synthetic TxODDS evidence and a
   governance-opened sealed holdout. Neither condition currently exists.

## Exact production integration blockers

- no qualifying real-data artifact;
- no one-time real holdout result;
- no verified point-in-time settlement-return and execution dataset;
- no production artifact store, signature policy, or remote holdout service;
- no approved contract for combining historical priors with market filters;
- no replay champion approved for installation;
- no authorization to replace `NullTheoProvider`;
- no autonomous live-funds state by design.

## External adapters

- Perplexity: a strict, disabled-by-default provider adapter exists, but no
  configuration or live provider call was verified in this milestone. It is
  adapter-only, not part of validation, promotion, or production.
- Colab: only a reproducible job-spec/worker adapter exists. It was type-checked
  and unit-tested but is not a submitted, executed, or validated training
  runner.
