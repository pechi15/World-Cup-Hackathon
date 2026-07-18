"""Independent critic implementation with all mandatory governance checks."""

from __future__ import annotations

import hashlib
from collections.abc import Sequence

from .contracts import (
    BacktestReport,
    ArtifactManifest,
    CheckStatus,
    CriticFinding,
    CriticReview,
    DataMode,
    ExperimentSpec,
    PredictionObservation,
    StressResult,
    ValidationReport,
    utc_now,
)
from .evidence import binding_for, feature_manifest_hash, verify_binding
from .registry import canonical_json


def _metric(report: BacktestReport, name: str) -> float | None:
    item = next((metric for metric in report.metrics if metric.name == name), None)
    return item.value if item else None


def _metric_sample_size(report: BacktestReport, name: str) -> int | None:
    item = next((metric for metric in report.metrics if metric.name == name), None)
    return item.sample_size if item else None


def critic_evidence_hash(
    spec: ExperimentSpec,
    artifact: ArtifactManifest,
    validation: ValidationReport,
    backtest: BacktestReport,
    stress_results: Sequence[StressResult],
) -> str:
    evidence = {
        "spec": spec.model_dump(mode="json"),
        "artifact": artifact.model_dump(mode="json"),
        "validation": validation.model_dump(mode="json"),
        "backtest": backtest.model_dump(mode="json"),
        "stress_results": [
            result.model_dump(mode="json")
            for result in sorted(stress_results, key=lambda item: item.scenario)
        ],
    }
    return hashlib.sha256(canonical_json(evidence).encode()).hexdigest()


class IndependentCriticAgent:
    """Critic whose checks are deterministic; an LLM may only improve prose."""

    def __init__(
        self,
        reviewer_id: str = "independent-critic-v1",
        *,
        maximum_ece: float = 0.08,
        maximum_fixture_concentration: float = 0.35,
        minimum_tail_observations: int = 30,
        minimum_fixture_count: int = 30,
    ) -> None:
        self.reviewer_id = reviewer_id
        self.maximum_ece = maximum_ece
        self.maximum_fixture_concentration = maximum_fixture_concentration
        self.minimum_tail_observations = minimum_tail_observations
        self.minimum_fixture_count = minimum_fixture_count

    def review(
        self,
        *,
        spec: ExperimentSpec,
        artifact: ArtifactManifest,
        validation: ValidationReport,
        backtest: BacktestReport,
        stress_results: Sequence[StressResult],
        observations: Sequence[PredictionObservation],
        review_round: int,
    ) -> CriticReview:
        calibration = validation.calibration
        binding_failures = [
            *verify_binding(validation.binding, spec=spec, artifact=artifact, validation_fold="ALL_DEVELOPMENT_FOLDS"),
            *verify_binding(backtest.binding, spec=spec, artifact=artifact, validation_fold="BACKTEST"),
        ]
        if feature_manifest_hash(spec.features) != spec.feature_manifest_hash:
            binding_failures.append("DECLARED_FEATURE_MANIFEST_HASH_MISMATCH")
        for result in stress_results:
            binding_failures.extend(
                verify_binding(
                    result.binding,
                    spec=spec,
                    artifact=artifact,
                    validation_fold=f"STRESS:{result.scenario}",
                )
            )
        fold_ids = {fold.fold_id for fold in validation.folds}
        folds_by_id = {fold.fold_id: fold for fold in validation.folds}
        fold_result_ids = {fold.fold_id for fold in validation.fold_results}
        fold_evidence_complete = (
            fold_ids == fold_result_ids
            and len(validation.fold_results) == len(validation.folds)
            and all(
                not verify_binding(
                    result.binding,
                    spec=spec,
                    artifact=artifact,
                    validation_fold=f"fold-{result.fold_id}",
                    training_cutoff=folds_by_id[result.fold_id].training_cutoff,
                )
                and not verify_binding(
                    folds_by_id[result.fold_id].binding,
                    spec=spec,
                    artifact=artifact,
                    validation_fold=f"fold-{result.fold_id}",
                    training_cutoff=folds_by_id[result.fold_id].training_cutoff,
                )
                and result.binding == folds_by_id[result.fold_id].binding
                and result.metrics
                and result.test_fixture_count > 0
                for result in validation.fold_results
            )
        )
        oos_fixtures = {
            fixture_id
            for fold in validation.folds
            for fixture_id in fold.test_fixture_ids
        }
        lower_tail = [row for row in observations if row.probability <= 0.1]
        upper_tail = [row for row in observations if row.probability >= 0.9]
        tail_count = len(lower_tail) + len(upper_tail)
        tail_errors = [
            abs(
                sum(row.probability for row in tail) / len(tail)
                - sum(row.outcome for row in tail) / len(tail)
            )
            for tail in (lower_tail, upper_tail)
            if tail
        ]
        maximum_tail_error = max(tail_errors, default=1.0)
        raw_kelly = spec.parameter("kelly_fraction", 0.0)
        try:
            kelly_fraction = float(raw_kelly)  # type: ignore[arg-type]
            kelly_valid = 0.0 <= kelly_fraction <= 0.25
        except (TypeError, ValueError):
            kelly_fraction = None
            kelly_valid = False
        concentration = _metric(backtest, "strategy_fixture_concentration")
        order_count = _metric_sample_size(backtest, "fill_rate")
        claim_text = f"{spec.hypothesis.statement} {spec.implementation_claim}".lower()
        prohibited_claim = any(
            phrase in claim_text
            for phrase in ("guaranteed profit", "proven alpha", "risk-free", "live-funds approved")
        )
        findings = (
            self._finding(
                "evidence_binding",
                not binding_failures,
                "binding_failures=" + ",".join(binding_failures),
            ),
            self._finding(
                "leakage",
                not validation.leakage_detected,
                f"leakage_detected={validation.leakage_detected}",
            ),
            self._finding(
                "fixture_dependence",
                not validation.fixture_overlap_detected
                and all(not (set(f.train_fixture_ids) & set(f.test_fixture_ids)) for f in validation.folds),
                f"fixture_overlap_detected={validation.fixture_overlap_detected}",
            ),
            self._finding(
                "fold_evidence",
                fold_evidence_complete,
                f"folds={sorted(fold_ids)}; fold_results={sorted(fold_result_ids)}",
            ),
            self._finding(
                "fixture_count",
                len(oos_fixtures) >= self.minimum_fixture_count,
                f"oos_fixtures={len(oos_fixtures)}; minimum={self.minimum_fixture_count}",
            ),
            self._finding(
                "holdout_contamination",
                bool(validation.holdout_seal)
                and "HOLDOUT_SEALED" in validation.reason_codes
                and "HOLDOUT_CONTAMINATION" not in validation.reason_codes,
                f"holdout_seal_present={bool(validation.holdout_seal)}",
            ),
            self._finding(
                "calibration",
                calibration.expected_calibration_error is not None
                and calibration.expected_calibration_error <= self.maximum_ece,
                f"ece={calibration.expected_calibration_error}; threshold={self.maximum_ece}",
            ),
            self._finding(
                "multiple_testing",
                validation.multiple_testing.passed,
                (
                    f"method={validation.multiple_testing.method}; "
                    f"adjusted_p={validation.multiple_testing.adjusted_p_value}; "
                    f"trials={validation.multiple_testing.trials}"
                ),
            ),
            self._finding(
                "latency_assumptions",
                spec.latency.entry_latency_ms > 0
                and bool(backtest.assumptions_hash)
                and bool(backtest.fills)
                and all(
                    fill.latency_ms >= spec.latency.entry_latency_ms
                    and fill.fill_time > fill.decision_time
                    for fill in backtest.fills
                ),
                f"entry_latency_ms={spec.latency.entry_latency_ms}; fills={len(backtest.fills)}",
            ),
            self._finding(
                "fill_assumptions",
                spec.fills.mode in ("TOUCH", "CROSS", "QUEUE_AWARE")
                and spec.fills.slippage_bps >= 0
                and order_count is not None
                and len(backtest.fills) + len(backtest.rejected_order_ids) == order_count
                and all(
                    abs(
                        fill.fee
                        - fill.price * fill.quantity * spec.fills.fee_bps / 10_000.0
                    )
                    <= 1e-12
                    and fill.quoted_bid <= fill.quoted_ask
                    and fill.spread_cost >= 0
                    and fill.slippage_cost >= 0
                    for fill in backtest.fills
                ),
                (
                    f"mode={spec.fills.mode}; queue_fraction={spec.fills.queue_fraction}; "
                    f"fills={len(backtest.fills)}; rejections={len(backtest.rejected_order_ids)}; "
                    f"orders={order_count}"
                ),
            ),
            self._finding(
                "tail_probability_reliability",
                tail_count >= self.minimum_tail_observations
                and bool(lower_tail)
                and bool(upper_tail)
                and maximum_tail_error <= self.maximum_ece,
                (
                    f"tail_observations={tail_count}; minimum={self.minimum_tail_observations}; "
                    f"maximum_tail_calibration_error={maximum_tail_error}"
                ),
            ),
            self._finding(
                "kelly_misuse",
                kelly_valid
                and (
                    kelly_fraction == 0.0
                    or (
                        calibration.sample_size >= self.minimum_fixture_count
                        and calibration.expected_calibration_error is not None
                        and calibration.expected_calibration_error <= self.maximum_ece
                        and calibration.calibration_intercept is not None
                        and calibration.calibration_slope is not None
                    )
                ),
                (
                    f"kelly_fraction={kelly_fraction}; allowed=[0,0.25]; "
                    f"calibration_n={calibration.sample_size}; ece={calibration.expected_calibration_error}"
                ),
            ),
            self._finding(
                "strategy_concentration",
                concentration is not None and concentration <= self.maximum_fixture_concentration,
                f"fixture_concentration={concentration}; threshold={self.maximum_fixture_concentration}",
            ),
            self._finding(
                "academic_claim_vs_implementation",
                bool(spec.hypothesis.academic_references)
                and not prohibited_claim
                and "synthetic" in spec.implementation_claim.lower()
                if spec.data_mode == DataMode.SYNTHETIC_TEST
                else bool(spec.hypothesis.academic_references) and not prohibited_claim,
                (
                    f"references={len(spec.hypothesis.academic_references)}; "
                    f"prohibited_claim={prohibited_claim}; data_mode={spec.data_mode.value}"
                ),
            ),
        )
        blockers = [finding for finding in findings if finding.status == CheckStatus.FAIL]
        return CriticReview(
            experiment_id=spec.experiment_id,
            binding=binding_for(
                spec,
                artifact_checksum=artifact.content_hash,
                validation_fold=f"CRITIC_REVIEW_{review_round}",
            ),
            evidence_hash=critic_evidence_hash(spec, artifact, validation, backtest, stress_results),
            review_round=review_round,
            reviewer_id=self.reviewer_id,
            reviewed_at=utc_now(),
            findings=findings,
            approved=not blockers,
            summary=(
                "All mandatory checks passed."
                if not blockers
                else "Blocked by: " + ", ".join(finding.check for finding in blockers)
            ),
        )

    @staticmethod
    def _finding(check: str, passed: bool, evidence: str) -> CriticFinding:
        return CriticFinding(
            check=check,
            status=CheckStatus.PASS if passed else CheckStatus.FAIL,
            severity="INFO" if passed else "BLOCKER",
            evidence=(evidence,),
            required_action=None if passed else f"Resolve {check} before promotion.",
        )
