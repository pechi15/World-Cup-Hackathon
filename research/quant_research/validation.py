"""Fixture-safe walk-forward validation, purging, sealing, and calibration."""

from __future__ import annotations

import hashlib
import json
import math
import threading
from collections import defaultdict
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import timedelta

from .contracts import (
    CalibrationReport,
    DataMode,
    ExperimentSpec,
    FoldAssignment,
    FoldEvidence,
    HoldoutEvaluation,
    MetricResult,
    MultipleTestingReport,
    PredictionObservation,
    ValidationReport,
)
from .evidence import binding_for
from .workflow import ActorRole, CapabilityViolation


def _mean(values: Sequence[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _logit(probability: float, epsilon: float = 1e-8) -> float:
    bounded = min(1.0 - epsilon, max(epsilon, probability))
    return math.log(bounded / (1.0 - bounded))


def _sigmoid(value: float) -> float:
    if value >= 0:
        return 1.0 / (1.0 + math.exp(-value))
    exp_value = math.exp(value)
    return exp_value / (1.0 + exp_value)


def evaluate_calibration(
    observations: Sequence[PredictionObservation],
    *,
    bins: int = 10,
) -> CalibrationReport:
    if bins < 2:
        raise ValueError("at least two calibration bins are required")
    if not observations:
        return CalibrationReport(
            sample_size=0,
            brier_score=None,
            log_loss=None,
            expected_calibration_error=None,
            maximum_calibration_error=None,
            calibration_intercept=None,
            calibration_slope=None,
            bins_populated=0,
        )

    brier = _mean([(row.probability - row.outcome) ** 2 for row in observations])
    log_loss = _mean(
        [
            -(row.outcome * math.log(max(row.probability, 1e-15)))
            - (1 - row.outcome) * math.log(max(1.0 - row.probability, 1e-15))
            for row in observations
        ]
    )

    buckets: dict[int, list[PredictionObservation]] = defaultdict(list)
    for row in observations:
        index = min(bins - 1, int(row.probability * bins))
        buckets[index].append(row)
    errors = [
        (len(rows), abs(sum(row.probability for row in rows) / len(rows) - sum(row.outcome for row in rows) / len(rows)))
        for rows in buckets.values()
    ]
    ece = sum(count * error for count, error in errors) / len(observations)
    mce = max(error for _, error in errors)
    intercept, slope = _calibration_regression(observations)
    return CalibrationReport(
        sample_size=len(observations),
        brier_score=brier,
        log_loss=log_loss,
        expected_calibration_error=ece,
        maximum_calibration_error=mce,
        calibration_intercept=intercept,
        calibration_slope=slope,
        bins_populated=len(buckets),
    )


def _calibration_regression(
    observations: Sequence[PredictionObservation],
) -> tuple[float | None, float | None]:
    if len({row.outcome for row in observations}) < 2:
        return None, None
    x_values = [_logit(row.probability) for row in observations]
    y_values = [row.outcome for row in observations]
    intercept, slope = 0.0, 1.0
    for _ in range(40):
        probabilities = [_sigmoid(intercept + slope * x) for x in x_values]
        weights = [max(1e-8, p * (1.0 - p)) for p in probabilities]
        g0 = sum(y - p for y, p in zip(y_values, probabilities, strict=True))
        g1 = sum((y - p) * x for y, p, x in zip(y_values, probabilities, x_values, strict=True))
        h00 = sum(weights)
        h01 = sum(w * x for w, x in zip(weights, x_values, strict=True))
        h11 = sum(w * x * x for w, x in zip(weights, x_values, strict=True))
        determinant = h00 * h11 - h01 * h01
        if determinant <= 1e-12:
            return None, None
        delta_intercept = (h11 * g0 - h01 * g1) / determinant
        delta_slope = (-h01 * g0 + h00 * g1) / determinant
        intercept += delta_intercept
        slope += delta_slope
        if max(abs(delta_intercept), abs(delta_slope)) < 1e-8:
            break
    return intercept, slope


def fixture_grouped_purged_walk_forward(
    observations: Sequence[PredictionObservation],
    experiment: ExperimentSpec,
    artifact_checksum: str,
) -> tuple[FoldAssignment, ...]:
    spec = experiment.split
    if not spec.fixture_grouped or not spec.chronological:
        raise ValueError("governed validation requires fixture-grouped chronological splits")

    grouped: dict[str, list[PredictionObservation]] = defaultdict(list)
    for row in observations:
        grouped[row.fixture_id].append(row)
    ordered_groups = sorted(
        grouped.items(),
        key=lambda item: (
            min(row.decision_time for row in item[1]),
            max(row.target_available_at for row in item[1]),
            item[0],
        ),
    )
    cursor = spec.min_train_fixtures
    minimum_remaining_tests = spec.folds * spec.min_test_fixtures
    while cursor <= len(ordered_groups) - minimum_remaining_tests:
        candidate_test_start = min(
            row.decision_time for row in ordered_groups[cursor][1]
        )
        candidate_cutoff = candidate_test_start - timedelta(
            seconds=spec.purge_seconds + spec.embargo_seconds
        )
        eligible_count = sum(
            max(row.target_available_at for row in rows) < candidate_cutoff
            for _, rows in ordered_groups[:cursor]
        )
        if eligible_count >= spec.min_train_fixtures:
            break
        cursor += 1
    available_test_groups = len(ordered_groups) - cursor
    if available_test_groups < spec.folds * spec.min_test_fixtures:
        raise ValueError("insufficient fixtures for requested walk-forward folds")

    base_test_size, remainder = divmod(available_test_groups, spec.folds)
    folds: list[FoldAssignment] = []
    for fold_id in range(spec.folds):
        test_size = base_test_size + (1 if fold_id < remainder else 0)
        test_groups = ordered_groups[cursor : cursor + test_size]
        raw_train_groups = ordered_groups[:cursor]
        test_start = min(row.decision_time for _, rows in test_groups for row in rows)
        purge_boundary = test_start - timedelta(seconds=spec.purge_seconds)
        embargo_boundary = purge_boundary - timedelta(seconds=spec.embargo_seconds)
        eligible_train_groups = [
            (fixture_id, rows)
            for fixture_id, rows in raw_train_groups
            if max(row.target_available_at for row in rows) < embargo_boundary
        ]
        train_rows = [row for _, rows in eligible_train_groups for row in rows]
        retained_train_fixtures = {row.fixture_id for row in train_rows}
        if len(retained_train_fixtures) < spec.min_train_fixtures:
            raise ValueError("purge leaves fewer than min_train_fixtures")
        raw_train_rows = [row for _, rows in raw_train_groups for row in rows]
        purged_ids = tuple(
            row.observation_id for row in raw_train_rows if row.observation_id not in {r.observation_id for r in train_rows}
        )
        test_rows = [row for _, rows in test_groups for row in rows]
        train_fixture_ids = tuple(sorted(retained_train_fixtures))
        test_fixture_ids = tuple(sorted(fixture_id for fixture_id, _ in test_groups))
        if set(train_fixture_ids) & set(test_fixture_ids):
            raise AssertionError("fixture grouping invariant violated")
        folds.append(
            FoldAssignment(
                fold_id=fold_id,
                train_ids=tuple(row.observation_id for row in train_rows),
                test_ids=tuple(row.observation_id for row in test_rows),
                purged_ids=purged_ids,
                train_fixture_ids=train_fixture_ids,
                test_fixture_ids=test_fixture_ids,
                training_cutoff=embargo_boundary,
                test_start=test_start,
                purge_boundary=purge_boundary,
                embargo_boundary=embargo_boundary,
                binding=binding_for(
                    experiment,
                    artifact_checksum=artifact_checksum,
                    validation_fold=f"fold-{fold_id}",
                    training_cutoff=embargo_boundary,
                ),
            )
        )
        cursor += test_size
    return tuple(folds)


def multiple_testing_report(
    observations: Sequence[PredictionObservation],
    trials: int,
    *,
    alpha: float = 0.05,
) -> MultipleTestingReport:
    returns = [row.strategy_return for row in observations if row.strategy_return is not None]
    if len(returns) != len(observations):
        return MultipleTestingReport(
            trials=trials,
            adjusted_p_value=1.0,
            method="NOT_EVALUATED_WITHOUT_UNDERLYING_RETURNS",
            passed=False,
            reason_codes=("MISSING_UNDERLYING_RETURNS",),
        )
    if len(returns) < 2:
        raw_p = 1.0
    else:
        mean = sum(returns) / len(returns)
        variance = sum((value - mean) ** 2 for value in returns) / (len(returns) - 1)
        standard_error = math.sqrt(variance / len(returns))
        z_score = mean / standard_error if standard_error > 0 else 0.0
        raw_p = 0.5 * math.erfc(z_score / math.sqrt(2.0))
    adjusted = min(1.0, raw_p * trials)
    return MultipleTestingReport(
        trials=trials,
        adjusted_p_value=adjusted,
        method="ONE_SIDED_NORMAL_BONFERRONI",
        passed=adjusted < alpha,
        reason_codes=(),
    )


def walk_forward_validation(
    spec: ExperimentSpec,
    development_observations: Sequence[PredictionObservation],
    holdout_seal: str,
    artifact_checksum: str,
) -> ValidationReport:
    observation_ids = [row.observation_id for row in development_observations]
    if len(observation_ids) != len(set(observation_ids)):
        raise ValueError("duplicate observation IDs are not permitted")
    folds = fixture_grouped_purged_walk_forward(development_observations, spec, artifact_checksum)
    by_id = {row.observation_id: row for row in development_observations}
    out_of_sample = [by_id[row_id] for fold in folds for row_id in fold.test_ids]
    calibration = evaluate_calibration(out_of_sample)
    baseline_brier = _mean([(row.baseline_probability - row.outcome) ** 2 for row in out_of_sample])
    leakage = any(
        row.available_at > row.decision_time
        or row.event_time > row.decision_time
        or row.target_available_at <= row.decision_time
        for row in out_of_sample
    )
    fixture_overlap = any(set(fold.train_fixture_ids) & set(fold.test_fixture_ids) for fold in folds)
    multiple_testing = multiple_testing_report(out_of_sample, spec.max_trials)
    metrics = (
        MetricResult(
            name="brier_score",
            value=calibration.brier_score,
            sample_size=len(out_of_sample),
            higher_is_better=False,
        ),
        MetricResult(
            name="baseline_brier_score",
            value=baseline_brier,
            sample_size=len(out_of_sample),
            higher_is_better=False,
        ),
        MetricResult(
            name="brier_improvement",
            value=None if calibration.brier_score is None or baseline_brier is None else baseline_brier - calibration.brier_score,
            sample_size=len(out_of_sample),
            higher_is_better=True,
        ),
    )
    fold_results = tuple(
        FoldEvidence(
            fold_id=fold.fold_id,
            binding=fold.binding,
            test_fixture_count=len(fold.test_fixture_ids),
            test_observation_count=len(fold.test_ids),
            metrics=(
                MetricResult(
                    name="fold_brier_score",
                    value=evaluate_calibration([by_id[row_id] for row_id in fold.test_ids]).brier_score,
                    sample_size=len(fold.test_ids),
                    higher_is_better=False,
                ),
            ),
        )
        for fold in folds
    )
    reasons = ["FIXTURE_GROUPED", "CHRONOLOGICAL", "PURGED", "HOLDOUT_SEALED"]
    if spec.data_mode == DataMode.SYNTHETIC_TEST:
        reasons.extend(("SYNTHETIC_PIPELINE_ONLY", "NO_ALPHA_CLAIM"))
    if leakage:
        reasons.append("LEAKAGE_DETECTED")
    if fixture_overlap:
        reasons.append("FIXTURE_OVERLAP_DETECTED")
    return ValidationReport(
        experiment_id=spec.experiment_id,
        binding=binding_for(
            spec,
            artifact_checksum=artifact_checksum,
            validation_fold="ALL_DEVELOPMENT_FOLDS",
        ),
        folds=folds,
        fold_results=fold_results,
        metrics=metrics,
        calibration=calibration,
        fixture_overlap_detected=fixture_overlap,
        leakage_detected=leakage,
        holdout_seal=holdout_seal,
        multiple_testing=multiple_testing,
        reason_codes=tuple(reasons),
    )


@dataclass(frozen=True, slots=True)
class SealedHoldoutView:
    seal: str
    development: tuple[PredictionObservation, ...]


class GovernanceHoldoutStore:
    """Private holdout rows owned by governance; agents receive only the view."""

    def __init__(
        self,
        holdout: tuple[PredictionObservation, ...],
        *,
        seal: str,
        experiment: ExperimentSpec,
        artifact_checksum: str,
    ) -> None:
        self.__holdout = holdout
        self.__seal = seal
        self.__experiment = experiment
        self.__artifact_checksum = artifact_checksum
        self.__evaluated = False
        self.__lock = threading.Lock()

    def evaluate_once(
        self,
        actor: ActorRole,
        evaluator: Callable[[Sequence[PredictionObservation]], CalibrationReport] = evaluate_calibration,
    ) -> HoldoutEvaluation:
        if actor != ActorRole.GOVERNANCE:
            raise CapabilityViolation("only deterministic governance may evaluate the sealed holdout")
        with self.__lock:
            if self.__evaluated:
                raise RuntimeError("sealed holdout has already been evaluated")
            self.__evaluated = True
            rows = self.__holdout
        return HoldoutEvaluation(
            binding=binding_for(
                self.__experiment,
                artifact_checksum=self.__artifact_checksum,
                validation_fold="SEALED_HOLDOUT",
            ),
            holdout_seal=self.__seal,
            fixture_count=len({row.fixture_id for row in rows}),
            calibration=evaluator(rows),
        )


def seal_chronological_holdout(
    observations: Sequence[PredictionObservation],
    experiment: ExperimentSpec,
    artifact_checksum: str,
) -> tuple[SealedHoldoutView, GovernanceHoldoutStore]:
    spec = experiment.holdout
    fixtures: dict[str, list[PredictionObservation]] = defaultdict(list)
    for row in observations:
        fixtures[row.fixture_id].append(row)
    ordered = sorted(
        fixtures.items(),
        key=lambda item: (
            min(row.decision_time for row in item[1]),
            max(row.target_available_at for row in item[1]),
            item[0],
        ),
    )
    holdout_count = max(spec.minimum_fixtures, math.ceil(len(ordered) * spec.fraction))
    if holdout_count >= len(ordered):
        raise ValueError("holdout consumes all available fixtures")
    split_index = len(ordered) - holdout_count
    while split_index > 0:
        development_groups = ordered[:split_index]
        holdout_groups = ordered[split_index:]
        latest_development = max(
            row.target_available_at for _, rows in development_groups for row in rows
        )
        earliest_holdout = min(row.decision_time for _, rows in holdout_groups for row in rows)
        if latest_development < earliest_holdout:
            break
        split_index -= 1
    if split_index <= 0:
        raise ValueError("overlapping fixture timelines prevent a chronological holdout")
    development_groups = ordered[:split_index]
    holdout_groups = ordered[split_index:]
    development = tuple(row for _, rows in development_groups for row in rows)
    holdout = tuple(row for _, rows in holdout_groups for row in rows)
    canonical = json.dumps(
        [
            {
                "id": row.observation_id,
                "fixture": row.fixture_id,
                "event_time": row.event_time.isoformat(),
                "available_at": row.available_at.isoformat(),
                "decision_time": row.decision_time.isoformat(),
                "target_available_at": row.target_available_at.isoformat(),
                "probability": row.probability,
                "outcome": row.outcome,
            }
            for row in holdout
        ],
        sort_keys=True,
        separators=(",", ":"),
    )
    seal = hashlib.sha256(f"{spec.salt_id}:{canonical}".encode()).hexdigest()
    return (
        SealedHoldoutView(seal=seal, development=development),
        GovernanceHoldoutStore(
            holdout,
            seal=seal,
            experiment=experiment,
            artifact_checksum=artifact_checksum,
        ),
    )
