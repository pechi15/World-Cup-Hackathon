"""Strict, serializable contracts shared by researcher, critic, and governance code."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Annotated

from pydantic import BaseModel, ConfigDict, Field, model_validator


Probability = Annotated[float, Field(ge=0.0, le=1.0)]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)


class DataMode(StrEnum):
    SYNTHETIC = "SYNTHETIC"
    REPLAY = "REPLAY"
    TXODDS = "TXODDS"


class ResearchState(StrEnum):
    PROPOSED = "PROPOSED"
    SPEC_VALIDATED = "SPEC_VALIDATED"
    TRAINED = "TRAINED"
    WALK_FORWARD_EVALUATED = "WALK_FORWARD_EVALUATED"
    CRITIC_REVIEWED = "CRITIC_REVIEWED"
    REVISED_ONCE = "REVISED_ONCE"
    FINAL_REVIEW = "FINAL_REVIEW"
    REJECTED = "REJECTED"
    RESEARCH_ONLY = "RESEARCH_ONLY"
    PROMOTE_TO_REPLAY = "PROMOTE_TO_REPLAY"
    PROMOTE_TO_PAPER = "PROMOTE_TO_PAPER"


class PromotionTarget(StrEnum):
    REJECTED = "REJECTED"
    RESEARCH_ONLY = "RESEARCH_ONLY"
    PROMOTE_TO_REPLAY = "PROMOTE_TO_REPLAY"
    PROMOTE_TO_PAPER = "PROMOTE_TO_PAPER"


class CheckStatus(StrEnum):
    PASS = "PASS"
    FAIL = "FAIL"
    NOT_APPLICABLE = "NOT_APPLICABLE"


class FeatureAvailability(StrEnum):
    EVENT_TIME = "EVENT_TIME"
    RECEIVE_TIME = "RECEIVE_TIME"
    STATIC_PRE_FIXTURE = "STATIC_PRE_FIXTURE"


class ArtifactRole(StrEnum):
    CHAMPION = "CHAMPION"
    CHALLENGER = "CHALLENGER"
    ARCHIVED = "ARCHIVED"


class EvidenceBinding(Contract):
    experiment_id: str = Field(min_length=1)
    dataset_hash: str = Field(pattern="^[0-9a-f]{64}$")
    git_commit: str = Field(pattern="^[0-9a-f]{7,64}$")
    feature_manifest_hash: str = Field(pattern="^[0-9a-f]{64}$")
    training_cutoff: datetime
    validation_fold: str = Field(min_length=1)
    artifact_checksum: str = Field(pattern="^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def timezone_aware(self) -> EvidenceBinding:
        if self.training_cutoff.tzinfo is None:
            raise ValueError("training_cutoff must be timezone-aware")
        return self


class CalibrationMetadata(Contract):
    method: str = Field(min_length=1)
    fitted_at: datetime
    sample_size: int = Field(ge=1)
    expected_calibration_error: float = Field(ge=0.0, le=1.0)
    schema_version: str = Field(min_length=1)

    @model_validator(mode="after")
    def timezone_aware(self) -> CalibrationMetadata:
        if self.fitted_at.tzinfo is None:
            raise ValueError("calibration fitted_at must be timezone-aware")
        return self


class Hypothesis(Contract):
    hypothesis_id: str = Field(min_length=1)
    statement: str = Field(min_length=10)
    mechanism: str = Field(min_length=10)
    falsification_criteria: tuple[str, ...] = Field(min_length=1)
    academic_references: tuple[str, ...] = ()
    primary_metric: str
    benchmark_id: str


class FeatureDefinition(Contract):
    name: str
    dtype: str
    description: str
    source: str
    availability: FeatureAvailability
    lookback_seconds: int = Field(ge=0)
    known_at_field: str
    nullable: bool = False


class MetricResult(Contract):
    name: str
    value: float | None
    sample_size: int = Field(ge=0)
    higher_is_better: bool
    confidence_low: float | None = None
    confidence_high: float | None = None
    reason_codes: tuple[str, ...] = ()
    underlying_observation_ids: tuple[str, ...] = ()

    @model_validator(mode="after")
    def valid_interval(self) -> MetricResult:
        if (self.confidence_low is None) != (self.confidence_high is None):
            raise ValueError("both confidence bounds must be supplied together")
        if (
            self.confidence_low is not None
            and self.confidence_high is not None
            and self.confidence_low > self.confidence_high
        ):
            raise ValueError("confidence_low must not exceed confidence_high")
        metric_name = self.name.lower()
        if (
            self.value is not None
            and any(token in metric_name for token in ("pnl", "return", "sharpe"))
            and not self.underlying_observation_ids
        ):
            raise ValueError("return/PnL/Sharpe metrics require underlying returns")
        return self


class PurgedSplitSpec(Contract):
    folds: int = Field(ge=2, le=20)
    min_train_fixtures: int = Field(ge=1)
    min_test_fixtures: int = Field(ge=1)
    purge_seconds: int = Field(ge=0)
    embargo_seconds: int = Field(ge=0)
    fixture_grouped: bool = True
    chronological: bool = True


class HoldoutSpec(Contract):
    fraction: float = Field(gt=0.0, lt=0.5)
    salt_id: str = Field(min_length=1)
    minimum_fixtures: int = Field(ge=1)
    one_time_evaluation: bool = True


class LatencyAssumptions(Contract):
    decision_ms: int = Field(ge=0)
    network_ms: int = Field(ge=0)
    exchange_ms: int = Field(ge=0)
    cancel_ms: int = Field(ge=0)
    max_staleness_ms: int = Field(ge=0)

    @property
    def entry_latency_ms(self) -> int:
        return self.decision_ms + self.network_ms + self.exchange_ms


class FillAssumptions(Contract):
    mode: str = Field(pattern="^(TOUCH|CROSS|QUEUE_AWARE)$")
    queue_fraction: float = Field(ge=0.0, le=1.0)
    slippage_bps: float = Field(ge=0.0)
    fee_bps: float = Field(ge=0.0)
    partial_fills: bool


class ModelParameter(Contract):
    name: str = Field(min_length=1)
    value: int | float | str | bool


class ExperimentSpec(Contract):
    experiment_id: str = Field(min_length=1)
    created_at: datetime
    data_mode: DataMode
    hypothesis: Hypothesis
    features: tuple[FeatureDefinition, ...]
    split: PurgedSplitSpec
    holdout: HoldoutSpec
    latency: LatencyAssumptions
    fills: FillAssumptions
    model_family: str
    model_parameters: tuple[ModelParameter, ...]
    random_seed: int = Field(ge=0)
    primary_metrics: tuple[str, ...] = Field(min_length=1)
    stress_scenarios: tuple[str, ...] = Field(min_length=1)
    max_trials: int = Field(ge=1, le=100)
    implementation_claim: str
    data_snapshot_hash: str = Field(pattern="^[0-9a-f]{64}$")
    git_commit: str = Field(pattern="^[0-9a-f]{7,64}$")
    feature_manifest_hash: str = Field(pattern="^[0-9a-f]{64}$")
    training_cutoff: datetime

    @model_validator(mode="after")
    def timezone_and_features(self) -> ExperimentSpec:
        if self.created_at.tzinfo is None:
            raise ValueError("created_at must be timezone-aware")
        if self.training_cutoff.tzinfo is None:
            raise ValueError("training_cutoff must be timezone-aware")
        names = [feature.name for feature in self.features]
        if len(names) != len(set(names)):
            raise ValueError("feature names must be unique")
        parameter_names = [parameter.name for parameter in self.model_parameters]
        if len(parameter_names) != len(set(parameter_names)):
            raise ValueError("model parameter names must be unique")
        return self

    def parameter(self, name: str, default: int | float | str | bool | None = None) -> int | float | str | bool | None:
        match = next((parameter.value for parameter in self.model_parameters if parameter.name == name), None)
        return default if match is None else match


class PredictionObservation(Contract):
    observation_id: str
    fixture_id: str
    event_time: datetime
    available_at: datetime
    decision_time: datetime
    target_available_at: datetime
    probability: Probability
    baseline_probability: Probability
    outcome: int = Field(ge=0, le=1)
    strategy_return: float | None = None

    @model_validator(mode="after")
    def no_time_travel(self) -> PredictionObservation:
        times = (self.event_time, self.available_at, self.decision_time, self.target_available_at)
        if any(value.tzinfo is None for value in times):
            raise ValueError("all observation timestamps must be timezone-aware")
        if not self.event_time <= self.available_at <= self.decision_time < self.target_available_at:
            raise ValueError(
                "chronology requires event_time <= available_at <= decision_time < target_available_at"
            )
        return self


class FoldAssignment(Contract):
    fold_id: int = Field(ge=0)
    train_ids: tuple[str, ...]
    test_ids: tuple[str, ...]
    purged_ids: tuple[str, ...]
    train_fixture_ids: tuple[str, ...]
    test_fixture_ids: tuple[str, ...]
    training_cutoff: datetime
    test_start: datetime
    purge_boundary: datetime
    embargo_boundary: datetime
    binding: EvidenceBinding


class CalibrationReport(Contract):
    sample_size: int = Field(ge=0)
    brier_score: float | None
    log_loss: float | None
    expected_calibration_error: float | None
    maximum_calibration_error: float | None
    calibration_intercept: float | None
    calibration_slope: float | None
    bins_populated: int = Field(ge=0)


class MultipleTestingReport(Contract):
    trials: int = Field(ge=1)
    adjusted_p_value: float = Field(ge=0.0, le=1.0)
    method: str
    passed: bool
    reason_codes: tuple[str, ...] = ()


class HoldoutEvaluation(Contract):
    binding: EvidenceBinding
    holdout_seal: str = Field(min_length=16)
    fixture_count: int = Field(ge=1)
    calibration: CalibrationReport


class FoldEvidence(Contract):
    fold_id: int = Field(ge=0)
    binding: EvidenceBinding
    test_fixture_count: int = Field(ge=1)
    test_observation_count: int = Field(ge=1)
    metrics: tuple[MetricResult, ...] = Field(min_length=1)


class ValidationReport(Contract):
    experiment_id: str
    binding: EvidenceBinding
    folds: tuple[FoldAssignment, ...]
    fold_results: tuple[FoldEvidence, ...]
    metrics: tuple[MetricResult, ...]
    calibration: CalibrationReport
    fixture_overlap_detected: bool
    leakage_detected: bool
    holdout_seal: str
    multiple_testing: MultipleTestingReport
    reason_codes: tuple[str, ...]


class MarketTick(Contract):
    fixture_id: str
    selection_id: str
    event_time: datetime
    available_at: datetime
    bid: Probability
    ask: Probability
    available_size: float = Field(ge=0.0)

    @model_validator(mode="after")
    def valid_book(self) -> MarketTick:
        if self.event_time.tzinfo is None or self.available_at.tzinfo is None:
            raise ValueError("tick timestamps must be timezone-aware")
        if self.available_at < self.event_time:
            raise ValueError("tick cannot be available before event_time")
        if self.bid > self.ask:
            raise ValueError("bid must not exceed ask")
        return self


class OrderIntent(Contract):
    order_id: str
    fixture_id: str
    selection_id: str
    decision_time: datetime
    side: str = Field(pattern="^(BUY|SELL)$")
    limit_price: Probability
    quantity: float = Field(gt=0.0)

    @model_validator(mode="after")
    def timezone_aware(self) -> OrderIntent:
        if self.decision_time.tzinfo is None:
            raise ValueError("decision_time must be timezone-aware")
        return self


class SimulatedFill(Contract):
    order_id: str
    fixture_id: str
    selection_id: str
    side: str
    decision_time: datetime
    arrival_time: datetime
    fill_time: datetime
    price: Probability
    quantity: float = Field(gt=0.0)
    fee: float = Field(ge=0.0)
    quoted_bid: Probability
    quoted_ask: Probability
    slippage_cost: float = Field(ge=0.0)
    spread_cost: float = Field(ge=0.0)
    latency_ms: int = Field(ge=0)

    @model_validator(mode="after")
    def valid_execution_chronology(self) -> SimulatedFill:
        if any(
            value.tzinfo is None
            for value in (self.decision_time, self.arrival_time, self.fill_time)
        ):
            raise ValueError("fill timestamps must be timezone-aware")
        if not self.decision_time <= self.arrival_time <= self.fill_time:
            raise ValueError("fill chronology is invalid")
        if self.fill_time <= self.decision_time:
            raise ValueError("same-tick execution is prohibited")
        if self.quoted_bid > self.quoted_ask:
            raise ValueError("fill quote is crossed")
        return self


class MarkoutResult(Contract):
    horizon_seconds: int = Field(gt=0)
    mean_markout: float | None
    median_markout: float | None
    sample_size: int = Field(ge=0)

    @model_validator(mode="after")
    def null_when_unobserved(self) -> MarkoutResult:
        if self.sample_size == 0 and (
            self.mean_markout is not None or self.median_markout is not None
        ):
            raise ValueError("missing markout horizons must remain null")
        if self.sample_size > 0 and (
            self.mean_markout is None or self.median_markout is None
        ):
            raise ValueError("observed markouts require summary values")
        return self


class BacktestReport(Contract):
    experiment_id: str
    data_snapshot_hash: str = Field(min_length=16)
    binding: EvidenceBinding
    fills: tuple[SimulatedFill, ...]
    metrics: tuple[MetricResult, ...]
    markouts: tuple[MarkoutResult, ...]
    rejected_order_ids: tuple[str, ...]
    assumptions_hash: str


class StressScenario(Contract):
    name: str
    latency_multiplier: float = Field(ge=1.0)
    slippage_multiplier: float = Field(ge=1.0)
    fill_probability_multiplier: float = Field(ge=0.0, le=1.0)
    probability_shock: float = Field(ge=0.0, le=0.5)


class StressResult(Contract):
    experiment_id: str
    data_snapshot_hash: str = Field(min_length=16)
    binding: EvidenceBinding
    scenario: str
    pnl: float | None
    max_drawdown: float | None = Field(ge=0.0)
    fill_count: int = Field(ge=0)
    passed: bool
    underlying_return_ids: tuple[str, ...] = ()
    reason_codes: tuple[str, ...] = ()

    @model_validator(mode="after")
    def no_fabricated_performance(self) -> StressResult:
        if (self.pnl is not None or self.max_drawdown is not None) and not self.underlying_return_ids:
            raise ValueError("stress PnL/drawdown require underlying returns")
        return self


CRITIC_CHECKS = (
    "evidence_binding",
    "leakage",
    "fixture_dependence",
    "fold_evidence",
    "fixture_count",
    "holdout_contamination",
    "calibration",
    "multiple_testing",
    "latency_assumptions",
    "fill_assumptions",
    "tail_probability_reliability",
    "kelly_misuse",
    "strategy_concentration",
    "academic_claim_vs_implementation",
)


class CriticFinding(Contract):
    check: str
    status: CheckStatus
    severity: str = Field(pattern="^(INFO|WARNING|BLOCKER)$")
    evidence: tuple[str, ...] = Field(min_length=1)
    required_action: str | None = None


class CriticReview(Contract):
    experiment_id: str
    binding: EvidenceBinding
    evidence_hash: str = Field(min_length=16)
    review_round: int = Field(ge=1, le=2)
    reviewer_id: str
    reviewed_at: datetime
    findings: tuple[CriticFinding, ...]
    approved: bool
    summary: str

    @model_validator(mode="after")
    def complete_and_consistent(self) -> CriticReview:
        checks = [finding.check for finding in self.findings]
        if set(checks) != set(CRITIC_CHECKS) or len(checks) != len(CRITIC_CHECKS):
            raise ValueError("critic review must contain each mandatory check exactly once")
        blockers = any(f.status == CheckStatus.FAIL or f.severity == "BLOCKER" for f in self.findings)
        if self.approved and blockers:
            raise ValueError("review with failed/blocking findings cannot be approved")
        return self


class PromotionDecision(Contract):
    experiment_id: str
    binding: EvidenceBinding
    target: PromotionTarget
    decided_at: datetime
    gate_version: str
    passed_rules: tuple[str, ...]
    failed_rules: tuple[str, ...]
    reason_codes: tuple[str, ...]
    decision_hash: str


class ArtifactManifest(Contract):
    artifact_id: str
    experiment_id: str
    content_hash: str = Field(pattern="^[0-9a-f]{64}$")
    uri: str
    media_type: str
    created_at: datetime
    model_family: str
    data_snapshot_hash: str = Field(pattern="^[0-9a-f]{64}$")
    code_revision: str = Field(pattern="^[0-9a-f]{7,64}$")
    feature_manifest_hash: str = Field(pattern="^[0-9a-f]{64}$")
    training_cutoff: datetime
    schema_version: str = Field(min_length=1)
    calibration: CalibrationMetadata
    data_mode: DataMode
    binding: EvidenceBinding
    metrics: tuple[MetricResult, ...] = ()

    @model_validator(mode="after")
    def internally_bound(self) -> ArtifactManifest:
        if self.training_cutoff.tzinfo is None:
            raise ValueError("artifact training_cutoff must be timezone-aware")
        if self.binding.experiment_id != self.experiment_id:
            raise ValueError("artifact binding experiment mismatch")
        if self.binding.dataset_hash != self.data_snapshot_hash:
            raise ValueError("artifact binding dataset mismatch")
        if self.binding.git_commit != self.code_revision:
            raise ValueError("artifact binding Git commit mismatch")
        if self.binding.feature_manifest_hash != self.feature_manifest_hash:
            raise ValueError("artifact binding feature manifest mismatch")
        if self.binding.training_cutoff != self.training_cutoff:
            raise ValueError("artifact binding training cutoff mismatch")
        if self.binding.artifact_checksum != self.content_hash:
            raise ValueError("artifact binding checksum mismatch")
        return self


class ArtifactRegistration(Contract):
    registration_id: str
    artifact: ArtifactManifest
    role: ArtifactRole
    registered_at: datetime
    replaced_artifact_id: str | None = None
    promotion_decision_hash: str | None = None
    checksum_verified: bool
    schema_verified: bool
    calibration_verified: bool
    previous_hash: str
    registration_hash: str


class RegistryEvent(Contract):
    sequence: int = Field(ge=1)
    experiment_id: str
    event_type: str
    state: ResearchState
    occurred_at: datetime
    actor: str
    binding: EvidenceBinding
    payload: dict[str, Any]
    previous_hash: str
    event_hash: str


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
