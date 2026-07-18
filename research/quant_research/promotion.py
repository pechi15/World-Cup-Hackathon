"""Versioned deterministic promotion gate; no model call is permitted here."""

from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Final

from pydantic import BaseModel

from .contracts import (
    ArtifactManifest,
    BacktestReport,
    CriticReview,
    DataMode,
    ExperimentSpec,
    HoldoutEvaluation,
    PromotionDecision,
    PromotionTarget,
    StressResult,
    ValidationReport,
)
from .critic import critic_evidence_hash
from .evidence import binding_for, feature_manifest_hash, verify_binding
from .registry import canonical_json


@dataclass(frozen=True, slots=True)
class PromotionGateConfig:
    version: str = "PROMOTION_GATE/1.0.0"
    minimum_oos_observations: int = 100
    maximum_ece: float = 0.08
    maximum_fixture_concentration: float = 0.35
    require_multiple_testing_pass: bool = True
    require_positive_brier_improvement: bool = True
    require_all_stress_pass: bool = True
    minimum_holdout_observations_for_paper: int = 100


DEFAULT_PROMOTION_GATE: Final[PromotionGateConfig] = PromotionGateConfig()


def _metric(report: ValidationReport | BacktestReport, name: str) -> float | None:
    result = next((item for item in report.metrics if item.name == name), None)
    return result.value if result else None


_TEMPORAL_KEYS = frozenset({"created_at", "reviewed_at", "decided_at", "generated_at", "registered_at"})


def _stable_evidence(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return _stable_evidence(value.model_dump(mode="json"))
    if isinstance(value, dict):
        return {
            key: _stable_evidence(item)
            for key, item in sorted(value.items())
            if key not in _TEMPORAL_KEYS
        }
    if isinstance(value, (list, tuple)):
        return [_stable_evidence(item) for item in value]
    return value


class DeterministicPromotionGate:
    def __init__(self, config: PromotionGateConfig = DEFAULT_PROMOTION_GATE) -> None:
        self._config = config

    @property
    def version(self) -> str:
        return self._config.version

    def decide(
        self,
        *,
        spec: ExperimentSpec,
        artifact: ArtifactManifest,
        validation: ValidationReport,
        final_review: CriticReview,
        backtest: BacktestReport,
        stress_results: tuple[StressResult, ...],
        holdout_evaluation: HoldoutEvaluation | None,
        decided_at: datetime | None = None,
    ) -> PromotionDecision:
        if final_review.review_round != 2:
            raise ValueError("promotion requires the round-two final critic review")
        if any(
            experiment_id != spec.experiment_id
            for experiment_id in (
                artifact.experiment_id,
                validation.experiment_id,
                final_review.experiment_id,
                backtest.experiment_id,
                *(result.experiment_id for result in stress_results),
            )
        ):
            raise ValueError("promotion evidence belongs to a different experiment")
        if any(
            snapshot_hash != spec.data_snapshot_hash
            for snapshot_hash in (
                artifact.data_snapshot_hash,
                backtest.data_snapshot_hash,
                *(result.data_snapshot_hash for result in stress_results),
            )
        ):
            raise ValueError("promotion evidence belongs to a different data snapshot")
        if final_review.evidence_hash != critic_evidence_hash(
            spec,
            artifact,
            validation,
            backtest,
            stress_results,
        ):
            raise ValueError("final critic review is not bound to the supplied evidence")
        binding_failures = [
            *verify_binding(artifact.binding, spec=spec, artifact=artifact, validation_fold="TRAINING"),
            *verify_binding(
                validation.binding,
                spec=spec,
                artifact=artifact,
                validation_fold="ALL_DEVELOPMENT_FOLDS",
            ),
            *verify_binding(backtest.binding, spec=spec, artifact=artifact, validation_fold="BACKTEST"),
            *verify_binding(
                final_review.binding,
                spec=spec,
                artifact=artifact,
                validation_fold="CRITIC_REVIEW_2",
            ),
        ]
        for result in stress_results:
            binding_failures.extend(
                verify_binding(
                    result.binding,
                    spec=spec,
                    artifact=artifact,
                    validation_fold=f"STRESS:{result.scenario}",
                )
            )
        if holdout_evaluation is not None:
            binding_failures.extend(
                verify_binding(
                    holdout_evaluation.binding,
                    spec=spec,
                    artifact=artifact,
                    validation_fold="SEALED_HOLDOUT",
                )
            )

        rules: dict[str, bool] = {
            "ALL_EVIDENCE_BOUND": not binding_failures,
            "FEATURE_MANIFEST_VERIFIED": feature_manifest_hash(spec.features)
            == spec.feature_manifest_hash,
            "NON_SYNTHETIC_EVIDENCE": spec.data_mode != DataMode.SYNTHETIC,
            "FINAL_CRITIC_APPROVED": final_review.approved,
            "NO_LEAKAGE": not validation.leakage_detected,
            "NO_FIXTURE_OVERLAP": not validation.fixture_overlap_detected,
            "FOLD_LEVEL_EVIDENCE": (
                len(validation.fold_results) == len(validation.folds)
                and {item.fold_id for item in validation.fold_results}
                == {item.fold_id for item in validation.folds}
                and all(
                    not verify_binding(
                        fold.binding,
                        spec=spec,
                        artifact=artifact,
                        validation_fold=f"fold-{fold.fold_id}",
                        training_cutoff=fold.training_cutoff,
                    )
                    for fold in validation.folds
                )
            ),
            "CHRONOLOGY_AND_EMBARGO": all(
                fold.embargo_boundary <= fold.purge_boundary < fold.test_start
                and fold.training_cutoff == fold.embargo_boundary
                for fold in validation.folds
            ),
            "MINIMUM_OOS_SAMPLE": validation.calibration.sample_size
            >= self._config.minimum_oos_observations,
            "CALIBRATION_ECE": validation.calibration.expected_calibration_error is not None
            and validation.calibration.expected_calibration_error <= self._config.maximum_ece,
            "POSITIVE_BRIER_IMPROVEMENT": (_metric(validation, "brier_improvement") or 0.0) > 0.0,
            "MULTIPLE_TESTING": validation.multiple_testing.passed,
            "STRESS_TESTS": bool(stress_results) and all(item.passed for item in stress_results),
            "STRATEGY_CONCENTRATION": (
                _metric(backtest, "strategy_fixture_concentration") is not None
                and (_metric(backtest, "strategy_fixture_concentration") or 0.0)
                <= self._config.maximum_fixture_concentration
            ),
            "LATENCY_AND_FILL_EVIDENCE": (
                bool(backtest.assumptions_hash)
                and bool(backtest.markouts)
                and all(fill.fill_time > fill.decision_time for fill in backtest.fills)
                and all(
                    (item.sample_size > 0 and item.mean_markout is not None and item.median_markout is not None)
                    or (item.sample_size == 0 and item.mean_markout is None and item.median_markout is None)
                    for item in backtest.markouts
                )
            ),
            "ARTIFACT_CALIBRATED": artifact.calibration.sample_size > 0,
            "ARTIFACT_SCHEMA_COMPATIBLE": bool(artifact.schema_version),
        }
        if not self._config.require_positive_brier_improvement:
            rules["POSITIVE_BRIER_IMPROVEMENT"] = True
        if not self._config.require_multiple_testing_pass:
            rules["MULTIPLE_TESTING"] = True
        if not self._config.require_all_stress_pass:
            rules["STRESS_TESTS"] = True

        passed = tuple(sorted(name for name, ok in rules.items() if ok))
        failed = tuple(sorted(name for name, ok in rules.items() if not ok))
        if failed:
            target = PromotionTarget.REJECTED
        elif (
            spec.data_mode == DataMode.TXODDS
            and artifact.data_mode != DataMode.SYNTHETIC
            and holdout_evaluation is not None
            and holdout_evaluation.calibration.sample_size
            >= self._config.minimum_holdout_observations_for_paper
            and holdout_evaluation.calibration.expected_calibration_error is not None
            and holdout_evaluation.calibration.expected_calibration_error <= self._config.maximum_ece
        ):
            target = PromotionTarget.PROMOTE_TO_PAPER
        else:
            target = PromotionTarget.PROMOTE_TO_REPLAY

        reason_codes = tuple(
            [f"PASS:{name}" for name in passed]
            + [f"FAIL:{name}" for name in failed]
            + (["SYNTHETIC_PIPELINE_VALIDATION_ONLY", "NO_ALPHA_CLAIM"] if spec.data_mode == DataMode.SYNTHETIC else [])
        )
        decision_body = _stable_evidence({
            "experiment_id": spec.experiment_id,
            "target": target.value,
            "gate_version": self._config.version,
            "gate_config": asdict(self._config),
            "passed_rules": passed,
            "failed_rules": failed,
            "spec": spec,
            "artifact": artifact,
            "validation": validation,
            "final_review": final_review,
            "backtest": backtest,
            "stress_results": sorted(stress_results, key=lambda result: result.scenario),
            "holdout_evaluation": holdout_evaluation,
        })
        decision_hash = hashlib.sha256(canonical_json(decision_body).encode()).hexdigest()
        return PromotionDecision(
            experiment_id=spec.experiment_id,
            binding=binding_for(
                spec,
                artifact_checksum=artifact.content_hash,
                validation_fold="PROMOTION_DECISION",
            ),
            target=target,
            decided_at=decided_at or datetime.now(timezone.utc),
            gate_version=self._config.version,
            passed_rules=passed,
            failed_rules=failed,
            reason_codes=reason_codes,
            decision_hash=decision_hash,
        )

    def verify(
        self,
        decision: PromotionDecision,
        *,
        spec: ExperimentSpec,
        artifact: ArtifactManifest,
        validation: ValidationReport,
        final_review: CriticReview,
        backtest: BacktestReport,
        stress_results: tuple[StressResult, ...],
        holdout_evaluation: HoldoutEvaluation | None,
    ) -> bool:
        expected = self.decide(
            spec=spec,
            artifact=artifact,
            validation=validation,
            final_review=final_review,
            backtest=backtest,
            stress_results=stress_results,
            holdout_evaluation=holdout_evaluation,
            decided_at=decision.decided_at,
        )
        return expected == decision
