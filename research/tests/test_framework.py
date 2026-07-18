from __future__ import annotations

import json
import hashlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from pydantic import BaseModel, ValidationError

from quant_research.backtest import evaluate_markouts, latency_aware_backtest, run_stress_suite
from quant_research.colab import generate_colab_job_spec
from quant_research.contracts import (
    CRITIC_CHECKS,
    ArtifactManifest,
    CalibrationMetadata,
    CalibrationReport,
    CheckStatus,
    CriticFinding,
    CriticReview,
    DataMode,
    EvidenceBinding,
    ExperimentSpec,
    FillAssumptions,
    LatencyAssumptions,
    MarketTick,
    MetricResult,
    ModelParameter,
    OrderIntent,
    PromotionDecision,
    PromotionTarget,
    PredictionObservation,
    PurgedSplitSpec,
    ResearchState,
    StressScenario,
    StressResult,
    ValidationReport,
    BacktestReport,
)
from quant_research.critic import IndependentCriticAgent
from quant_research.evidence import binding_for
from quant_research.promotion import DeterministicPromotionGate
from quant_research.providers import PerplexityAgentProvider, ProviderDisabled, _agent_api_schema
from quant_research.registry import ArtifactRegistry, ExperimentRegistry
from quant_research.synthetic import (
    EXPERIMENT_ID,
    _execution_inputs,
    _spec,
    _synthetic_observations,
    run_synthetic_experiment,
)
from quant_research.validation import (
    evaluate_calibration,
    fixture_grouped_purged_walk_forward,
    seal_chronological_holdout,
    walk_forward_validation,
)
from quant_research.workflow import (
    ActorRole,
    CapabilityViolation,
    InvalidTransition,
    ResearchStateMachine,
)


def _artifact_for(spec: ExperimentSpec) -> ArtifactManifest:
    content_hash = _checksum()
    return ArtifactManifest(
        artifact_id=f"artifact-{spec.experiment_id}",
        experiment_id=spec.experiment_id,
        content_hash=content_hash,
        uri=f"isolated://challengers/{spec.experiment_id}",
        media_type="application/octet-stream",
        created_at=spec.training_cutoff,
        model_family="test",
        data_snapshot_hash=spec.data_snapshot_hash,
        code_revision=spec.git_commit,
        feature_manifest_hash=spec.feature_manifest_hash,
        training_cutoff=spec.training_cutoff,
        schema_version="RESEARCH_ARTIFACT/1",
        calibration=CalibrationMetadata(
            method="TEST_CALIBRATION",
            fitted_at=spec.training_cutoff,
            sample_size=100,
            expected_calibration_error=0.05,
            schema_version="CALIBRATION/1",
        ),
        data_mode=spec.data_mode,
        binding=binding_for(spec, artifact_checksum=content_hash, validation_fold="TRAINING"),
    )


def _checksum() -> str:
    return hashlib.sha256(_artifact_content()).hexdigest()


def _artifact_content() -> bytes:
    return b"deterministic test artifact"


def _binding(
    spec: ExperimentSpec,
    fold: str,
    *,
    experiment_id: str | None = None,
) -> EvidenceBinding:
    effective = spec.model_copy(update={"experiment_id": experiment_id}) if experiment_id else spec
    return binding_for(effective, artifact_checksum=_checksum(), validation_fold=fold)


def _evidence_bundle(
    spec: ExperimentSpec,
    *,
    with_returns: bool = False,
) -> tuple[
    ArtifactManifest,
    tuple[PredictionObservation, ...],
    ValidationReport,
    BacktestReport,
    tuple[StressResult, ...],
]:
    artifact = _artifact_for(spec)
    observations = _synthetic_observations()
    if with_returns:
        observations = tuple(
            row.model_copy(update={"strategy_return": 0.009 + (index % 3) * 0.001})
            for index, row in enumerate(observations)
        )
    sealed, _governance = seal_chronological_holdout(observations, spec, artifact.content_hash)
    validation = walk_forward_validation(
        spec,
        sealed.development,
        sealed.seal,
        artifact.content_hash,
    )
    orders, ticks = _execution_inputs(sealed.development)
    backtest = latency_aware_backtest(
        orders,
        ticks,
        spec.latency,
        spec.fills,
        experiment_id=spec.experiment_id,
        data_snapshot_hash=spec.data_snapshot_hash,
        binding=_binding(spec, "BACKTEST"),
    )
    stress = run_stress_suite(
        orders,
        ticks,
        spec.latency,
        spec.fills,
        (
            StressScenario(
                name="base",
                latency_multiplier=1,
                slippage_multiplier=1,
                fill_probability_multiplier=1,
                probability_shock=0,
            ),
        ),
        experiment_id=spec.experiment_id,
        data_snapshot_hash=spec.data_snapshot_hash,
        binding=_binding(spec, "STRESS_SUITE"),
    )
    return artifact, sealed.development, validation, backtest, stress


def test_contracts_forbid_unknown_fields_and_incomplete_critic_review() -> None:
    with pytest.raises(ValidationError):
        LatencyAssumptions(
            decision_ms=1,
            network_ms=1,
            exchange_ms=1,
            cancel_ms=1,
            max_staleness_ms=1,
            hidden_override=True,
        )
    finding = CriticFinding(
        check="leakage",
        status=CheckStatus.PASS,
        severity="INFO",
        evidence=("no overlap",),
    )
    with pytest.raises(ValidationError, match="mandatory check"):
        CriticReview(
            experiment_id="x",
            binding=_binding(
                _spec("a" * 64).model_copy(update={"experiment_id": "x"}),
                "CRITIC_REVIEW_1",
            ),
            evidence_hash="a" * 64,
            review_round=1,
            reviewer_id="critic",
            reviewed_at=datetime.now(UTC),
            findings=(finding,),
            approved=True,
            summary="incomplete",
        )


def test_state_machine_is_bounded_and_role_separated() -> None:
    machine = ResearchStateMachine("exp")
    with pytest.raises(InvalidTransition):
        machine.transition(ResearchState.TRAINED, ActorRole.RESEARCHER)
    for target, actor in (
        (ResearchState.SPEC_VALIDATED, ActorRole.RESEARCHER),
        (ResearchState.TRAINED, ActorRole.RESEARCHER),
        (ResearchState.WALK_FORWARD_EVALUATED, ActorRole.RESEARCHER),
        (ResearchState.CRITIC_REVIEWED, ActorRole.CRITIC),
        (ResearchState.REVISED_ONCE, ActorRole.RESEARCHER),
        (ResearchState.FINAL_REVIEW, ActorRole.CRITIC),
        (ResearchState.REJECTED, ActorRole.GOVERNANCE),
    ):
        machine = machine.transition(target, actor)
    assert machine.revisions == 1
    with pytest.raises(InvalidTransition):
        machine.transition(ResearchState.PROMOTE_TO_REPLAY, ActorRole.GOVERNANCE)
    with pytest.raises(CapabilityViolation):
        ResearchStateMachine("exp").require_resource_access(ActorRole.RESEARCHER, "final_holdout")
    with pytest.raises(CapabilityViolation):
        ResearchStateMachine("exp").require_resource_access(ActorRole.CRITIC, "wallet_permissions")
    with pytest.raises(TypeError):
        ResearchStateMachine("exp", state=ResearchState.FINAL_REVIEW)  # type: ignore[call-arg]
    final_review_machine = ResearchStateMachine("critic-cannot-promote")
    for target, actor in (
        (ResearchState.SPEC_VALIDATED, ActorRole.RESEARCHER),
        (ResearchState.TRAINED, ActorRole.RESEARCHER),
        (ResearchState.WALK_FORWARD_EVALUATED, ActorRole.RESEARCHER),
        (ResearchState.CRITIC_REVIEWED, ActorRole.CRITIC),
        (ResearchState.REVISED_ONCE, ActorRole.RESEARCHER),
        (ResearchState.FINAL_REVIEW, ActorRole.CRITIC),
    ):
        final_review_machine = final_review_machine.transition(target, actor)
    with pytest.raises(InvalidTransition, match="only deterministic governance"):
        final_review_machine.transition(ResearchState.PROMOTE_TO_REPLAY, ActorRole.CRITIC)


def test_walk_forward_is_fixture_grouped_purged_and_holdout_is_one_time() -> None:
    observations = _synthetic_observations()
    spec = _spec("a" * 64)
    sealed, governance_holdout = seal_chronological_holdout(observations, spec, _checksum())
    report = walk_forward_validation(spec, sealed.development, sealed.seal, _checksum())
    assert report.fixture_overlap_detected is False
    assert report.leakage_detected is False
    assert len(report.folds) == 3
    for fold in report.folds:
        assert not (set(fold.train_fixture_ids) & set(fold.test_fixture_ids))
    with pytest.raises(PermissionError, match="governance"):
        governance_holdout.evaluate_once(ActorRole.RESEARCHER)
    with pytest.raises(PermissionError, match="governance"):
        governance_holdout.evaluate_once(ActorRole.CRITIC)
    holdout_report = governance_holdout.evaluate_once(ActorRole.GOVERNANCE)
    assert holdout_report.calibration.sample_size == 40
    with pytest.raises(RuntimeError, match="already"):
        governance_holdout.evaluate_once(ActorRole.GOVERNANCE)


def test_holdout_rejects_cross_boundary_fixtures_and_validation_rejects_duplicate_ids() -> None:
    observations = list(_synthetic_observations(200))
    spec = _spec("a" * 64)
    crossing = observations[0].model_copy(
        update={
            "observation_id": "crossing",
            "event_time": observations[-1].event_time + timedelta(hours=1),
            "available_at": observations[-1].available_at + timedelta(hours=1),
            "decision_time": observations[-1].decision_time + timedelta(hours=1),
            "target_available_at": observations[-1].target_available_at + timedelta(hours=1),
        }
    )
    with pytest.raises(ValueError, match="overlapping fixture timelines"):
        seal_chronological_holdout((*observations, crossing), spec, _checksum())

    sealed, _governance = seal_chronological_holdout(observations, spec, _checksum())
    duplicate = sealed.development[0].model_copy()
    with pytest.raises(ValueError, match="duplicate observation IDs"):
        walk_forward_validation(spec, (*sealed.development, duplicate), sealed.seal, _checksum())


def test_purged_split_removes_overlapping_train_observations_without_splitting_fixtures() -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    rows = []
    minutes = (0, 1, 2, 10, 11, 12)
    for fixture_index, minute in enumerate(minutes):
        base = _synthetic_observations(6)[fixture_index].model_copy(
            update={
                "observation_id": f"base-{fixture_index}",
                "fixture_id": f"fixture-{fixture_index}",
                "event_time": start + timedelta(minutes=minute),
                "available_at": start + timedelta(minutes=minute),
                "decision_time": start + timedelta(minutes=minute, milliseconds=1),
                "target_available_at": start + timedelta(minutes=minute, seconds=30),
            }
        )
        rows.append(base)
        if fixture_index == 1:
            rows.append(
                base.model_copy(
                    update={
                        "observation_id": f"late-{fixture_index}",
                        "event_time": start + timedelta(minutes=20),
                        "available_at": start + timedelta(minutes=20),
                        "decision_time": start + timedelta(minutes=20, milliseconds=1),
                        "target_available_at": start + timedelta(minutes=20, seconds=30),
                    }
                )
            )
    split_experiment = _spec("a" * 64).model_copy(
        update={
            "split": PurgedSplitSpec(
            folds=2,
            min_train_fixtures=2,
            min_test_fixtures=1,
            purge_seconds=60,
            embargo_seconds=0,
            )
        }
    )
    folds = fixture_grouped_purged_walk_forward(rows, split_experiment, _checksum())
    assert set(folds[0].purged_ids) == {"base-1", "late-1"}
    assert set(folds[0].train_fixture_ids) == {"fixture-0", "fixture-2"}

    non_chronological = split_experiment.model_copy(
        update={"split": split_experiment.split.model_copy(update={"chronological": False})}
    )
    with pytest.raises(ValueError, match="fixture-grouped chronological"):
        fixture_grouped_purged_walk_forward(rows, non_chronological, _checksum())


def test_calibration_reports_proper_scores_bins_and_slope() -> None:
    report = evaluate_calibration(_synthetic_observations())
    assert report.sample_size == 200
    assert report.brier_score is not None and report.brier_score < 0.2
    assert report.expected_calibration_error is not None
    assert report.expected_calibration_error < 0.03
    assert report.bins_populated == 5
    assert report.calibration_slope is not None


def test_latency_backtest_uses_arrival_book_rejections_and_future_markouts() -> None:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    orders = (
        OrderIntent(
            order_id="filled",
            fixture_id="f1",
            selection_id="YES",
            decision_time=now,
            side="BUY",
            limit_price=0.56,
            quantity=2,
        ),
        OrderIntent(
            order_id="rejected",
            fixture_id="f2",
            selection_id="YES",
            decision_time=now,
            side="BUY",
            limit_price=0.50,
            quantity=1,
        ),
    )
    ticks = (
        MarketTick(
            fixture_id="f1",
            selection_id="YES",
            event_time=now + timedelta(milliseconds=150),
            available_at=now + timedelta(milliseconds=200),
            bid=0.54,
            ask=0.55,
            available_size=1,
        ),
        MarketTick(
            fixture_id="f1",
            selection_id="YES",
            event_time=now + timedelta(seconds=60),
            available_at=now + timedelta(seconds=61),
            bid=0.57,
            ask=0.59,
            available_size=2,
        ),
        MarketTick(
            fixture_id="f2",
            selection_id="YES",
            event_time=now + timedelta(milliseconds=150),
            available_at=now + timedelta(milliseconds=200),
            bid=0.51,
            ask=0.52,
            available_size=1,
        ),
    )
    latency = LatencyAssumptions(
        decision_ms=50,
        network_ms=50,
        exchange_ms=50,
        cancel_ms=100,
        max_staleness_ms=100,
    )
    fills = FillAssumptions(
        mode="CROSS",
        queue_fraction=1,
        slippage_bps=0,
        fee_bps=1,
        partial_fills=True,
    )
    result = latency_aware_backtest(
        orders,
        ticks,
        latency,
        fills,
        experiment_id="execution-test",
        data_snapshot_hash="a" * 64,
        binding=_binding(_spec("a" * 64), "BACKTEST", experiment_id="execution-test"),
    )
    assert len(result.fills) == 1
    assert result.fills[0].quantity == 1
    assert result.fills[0].latency_ms == 200
    assert result.rejected_order_ids == ("rejected",)
    markout_60 = next(item for item in result.markouts if item.horizon_seconds == 60)
    assert markout_60.mean_markout == pytest.approx(0.03)

    stressed = run_stress_suite(
        orders,
        ticks,
        latency,
        fills,
        (
            StressScenario(
                name="latency",
                latency_multiplier=3,
                slippage_multiplier=2,
                fill_probability_multiplier=1,
                probability_shock=0,
            ),
        ),
        experiment_id="execution-test",
        data_snapshot_hash="a" * 64,
        binding=_binding(_spec("a" * 64), "STRESS_SUITE", experiment_id="execution-test"),
    )
    assert stressed[0].scenario == "latency"


def test_backtest_depletes_shared_liquidity_and_rejects_stale_markouts() -> None:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    with pytest.raises(ValidationError, match="timezone-aware"):
        OrderIntent(
            order_id="naive",
            fixture_id="f",
            selection_id="YES",
            decision_time=datetime(2026, 1, 1),
            side="BUY",
            limit_price=0.6,
            quantity=1,
        )
    orders = tuple(
        OrderIntent(
            order_id=f"order-{index}",
            fixture_id="f",
            selection_id="YES",
            decision_time=now,
            side="BUY",
            limit_price=0.6,
            quantity=1,
        )
        for index in range(2)
    )
    ticks = (
        MarketTick(
            fixture_id="f",
            selection_id="YES",
            event_time=now + timedelta(milliseconds=150),
            available_at=now + timedelta(milliseconds=200),
            bid=0.49,
            ask=0.5,
            available_size=1,
        ),
        MarketTick(
            fixture_id="f",
            selection_id="YES",
            event_time=now + timedelta(seconds=99),
            available_at=now + timedelta(seconds=100),
            bid=0.55,
            ask=0.56,
            available_size=1,
        ),
    )
    report = latency_aware_backtest(
        orders,
        ticks,
        LatencyAssumptions(
            decision_ms=50,
            network_ms=50,
            exchange_ms=50,
            cancel_ms=100,
            max_staleness_ms=100,
        ),
        FillAssumptions(
            mode="CROSS",
            queue_fraction=1,
            slippage_bps=0,
            fee_bps=0,
            partial_fills=True,
        ),
        experiment_id="liquidity",
        data_snapshot_hash="a" * 64,
        binding=_binding(_spec("a" * 64), "BACKTEST", experiment_id="liquidity"),
    )
    assert len(report.fills) == 1
    assert report.rejected_order_ids == ("order-1",)
    markout = evaluate_markouts(report.fills, ticks, horizons=(60,), maximum_lag_seconds=5)[0]
    assert markout.sample_size == 0


def test_same_tick_fills_are_rejected_and_negative_markouts_are_preserved() -> None:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    spec = _spec("a" * 64).model_copy(update={"experiment_id": "same-tick"})
    order = OrderIntent(
        order_id="order",
        fixture_id="fixture",
        selection_id="YES",
        decision_time=now,
        side="BUY",
        limit_price=0.6,
        quantity=1,
    )
    same_tick = MarketTick(
        fixture_id="fixture",
        selection_id="YES",
        event_time=now,
        available_at=now,
        bid=0.49,
        ask=0.5,
        available_size=1,
    )
    latency = LatencyAssumptions(
        decision_ms=0,
        network_ms=0,
        exchange_ms=0,
        cancel_ms=0,
        max_staleness_ms=500,
    )
    fills = FillAssumptions(
        mode="CROSS",
        queue_fraction=1,
        slippage_bps=10,
        fee_bps=2,
        partial_fills=True,
    )
    rejected = latency_aware_backtest(
        (order,),
        (same_tick,),
        latency,
        fills,
        experiment_id=spec.experiment_id,
        data_snapshot_hash=spec.data_snapshot_hash,
        binding=_binding(spec, "BACKTEST"),
    )
    assert rejected.fills == ()
    assert rejected.rejected_order_ids == ("order",)

    future_ticks = (
        same_tick.model_copy(
            update={
                "event_time": now + timedelta(milliseconds=100),
                "available_at": now + timedelta(milliseconds=200),
            }
        ),
        same_tick.model_copy(
            update={
                "event_time": now + timedelta(seconds=60),
                "available_at": now + timedelta(seconds=60, milliseconds=200),
                "bid": 0.39,
                "ask": 0.41,
            }
        ),
    )
    report = latency_aware_backtest(
        (order,),
        future_ticks,
        latency.model_copy(update={"network_ms": 100}),
        fills,
        experiment_id=spec.experiment_id,
        data_snapshot_hash=spec.data_snapshot_hash,
        binding=_binding(spec, "BACKTEST"),
    )
    markouts = evaluate_markouts(report.fills, future_ticks, horizons=(60, 300))
    assert markouts[0].sample_size == 1
    assert markouts[0].mean_markout is not None and markouts[0].mean_markout < 0
    assert markouts[1].sample_size == 0
    assert markouts[1].mean_markout is None
    assert report.fills[0].fee > 0
    assert report.fills[0].spread_cost > 0
    assert report.fills[0].slippage_cost > 0


def test_fabricated_performance_metrics_without_returns_are_rejected() -> None:
    with pytest.raises(ValidationError, match="underlying returns"):
        MetricResult(
            name="sharpe_ratio",
            value=2.0,
            sample_size=100,
            higher_is_better=True,
        )


def test_registry_detects_tampering_and_artifacts_require_promotion(tmp_path: Path) -> None:
    spec = _spec("c" * 64).model_copy(update={"experiment_id": "exp"})
    ledger_path = tmp_path / "events.jsonl"
    registry = ExperimentRegistry(ledger_path)
    registry.append(
        experiment_id="exp",
        event_type="EXPERIMENT_PROPOSED",
        state=ResearchState.PROPOSED,
        actor=ActorRole.RESEARCHER.value,
        binding=_binding(spec, "EXPERIMENT_PROPOSED"),
        payload=spec,
    )
    assert len(registry.events()) == 1
    with pytest.raises(ValueError, match="incomplete"):
        registry.assert_complete("exp")
    ledger_path.write_text(
        ledger_path.read_text().replace('"model_family":"SYNTHETIC', '"model_family":"TAMPERED'),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="modified"):
        registry.events()

    artifacts = ArtifactRegistry(tmp_path / "artifacts.jsonl")
    manifest = _artifact_for(spec)
    artifacts.register_challenger(manifest, _artifact_content())
    rejected = PromotionDecision(
        experiment_id="exp",
        binding=_binding(spec, "PROMOTION_DECISION"),
        target=PromotionTarget.REJECTED,
        decided_at=datetime.now(UTC),
        gate_version="v1",
        passed_rules=(),
        failed_rules=("x",),
        reason_codes=("FAIL:x",),
        decision_hash="d" * 64,
    )
    with pytest.raises(ValueError, match="rejected"):
        artifacts.promote_champion(manifest, rejected)
    artifact_path = tmp_path / "artifacts.jsonl"
    artifact_path.write_text(
        artifact_path.read_text().replace('"role":"CHALLENGER"', '"role":"CHAMPION"'),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="modified"):
        artifacts.registrations()


def test_complete_registry_rejects_wrong_actor_or_order(tmp_path: Path) -> None:
    registry = ExperimentRegistry(tmp_path / "wrong-lifecycle.jsonl")
    spec = _spec("a" * 64).model_copy(update={"experiment_id": "wrong"})
    registry.append(
        experiment_id="wrong",
        event_type="EXPERIMENT_PROPOSED",
        state=ResearchState.PROPOSED,
        actor=ActorRole.RESEARCHER.value,
        binding=_binding(spec, "EXPERIMENT_PROPOSED"),
        payload=spec,
    )
    with pytest.raises(ValueError, match="order, state, or actor"):
        registry.append(
            experiment_id="wrong",
            event_type="SPEC_VALIDATED",
            state=ResearchState.SPEC_VALIDATED,
            actor=ActorRole.CRITIC.value,
            binding=_binding(spec, "SPEC_VALIDATED"),
            payload={},
        )


def test_registries_reject_duplicates_checksum_schema_and_missing_calibration(
    tmp_path: Path,
) -> None:
    spec = _spec("a" * 64).model_copy(update={"experiment_id": "immutable"})
    experiments = ExperimentRegistry(tmp_path / "immutable-events.jsonl")
    experiments.append(
        experiment_id=spec.experiment_id,
        event_type="EXPERIMENT_PROPOSED",
        state=ResearchState.PROPOSED,
        actor=ActorRole.RESEARCHER.value,
        binding=_binding(spec, "EXPERIMENT_PROPOSED"),
        payload=spec,
    )
    with pytest.raises(ValueError, match="immutable and already registered"):
        experiments.append(
            experiment_id=spec.experiment_id,
            event_type="EXPERIMENT_PROPOSED",
            state=ResearchState.PROPOSED,
            actor=ActorRole.RESEARCHER.value,
            binding=_binding(spec, "EXPERIMENT_PROPOSED"),
            payload=spec,
        )

    artifacts = ArtifactRegistry(tmp_path / "verified-artifacts.jsonl")
    artifact = _artifact_for(spec)
    with pytest.raises(ValueError, match="checksum mismatch"):
        artifacts.register_challenger(artifact, b"tampered")
    incompatible = artifact.model_copy(update={"schema_version": "OTHER/9"})
    with pytest.raises(ValueError, match="schema is incompatible"):
        artifacts.register_challenger(incompatible, _artifact_content())
    missing_calibration = artifact.model_dump(mode="python")
    del missing_calibration["calibration"]
    with pytest.raises(ValidationError):
        ArtifactManifest.model_validate(missing_calibration)
    artifacts.register_challenger(artifact, _artifact_content())
    with pytest.raises(ValueError, match="already registered"):
        artifacts.register_challenger(artifact, _artifact_content())


def test_perplexity_adapter_is_disabled_without_key_and_schema_is_strict(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PERPLEXITY_API_KEY", raising=False)
    provider = PerplexityAgentProvider()
    assert provider.enabled is False
    with pytest.raises(ProviderDisabled):
        provider.generate(
            system_prompt="system",
            user_prompt="user",
            response_model=CalibrationReport,
            schema_name="CalibrationReport",
        )
    schema = _agent_api_schema(CalibrationReport)
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(schema["properties"])

    class MappingResponse(BaseModel):
        values: dict[str, int]

    mapping_schema = _agent_api_schema(MappingResponse)
    value_schema = mapping_schema["properties"]["values"]
    assert value_schema["additionalProperties"] == {"type": "integer"}


def test_colab_spec_is_reproducible_and_isolated() -> None:
    spec = _spec("a" * 64)
    timestamp = datetime(2026, 1, 1, tzinfo=UTC)
    first = generate_colab_job_spec(
        spec,
        notebook_uri="gs://research/notebooks/train.ipynb",
        source_revision="abc123",
        dataset_uri="gs://research/data/snapshot",
        output_uri="gs://research/artifacts/challengers",
        created_at=timestamp,
    )
    second = generate_colab_job_spec(
        spec,
        notebook_uri="gs://research/notebooks/train.ipynb",
        source_revision="abc123",
        dataset_uri="gs://research/data/snapshot",
        output_uri="gs://research/artifacts/challengers",
        created_at=timestamp,
    )
    assert first.spec_hash == second.spec_hash
    assert dict(first.environment)["DISABLE_PRODUCTION_DEPLOYMENT"] == "1"
    with pytest.raises(ValueError, match="challengers"):
        generate_colab_job_spec(
            spec,
            notebook_uri="x",
            source_revision="abc",
            dataset_uri="data",
            output_uri="gs://production/models",
        )


def test_critic_emits_every_mandatory_check() -> None:
    spec = _spec("a" * 64)
    artifact, development, validation, backtest, stress = _evidence_bundle(spec)
    review = IndependentCriticAgent().review(
        spec=spec,
        artifact=artifact,
        validation=validation,
        backtest=backtest,
        stress_results=stress,
        observations=development,
        review_round=1,
    )
    assert {finding.check for finding in review.findings} == set(CRITIC_CHECKS)
    invalid_kelly_spec = spec.model_copy(
        update={"model_parameters": (ModelParameter(name="kelly_fraction", value="half"),)}
    )
    invalid_review = IndependentCriticAgent().review(
        spec=invalid_kelly_spec,
        artifact=artifact,
        validation=validation,
        backtest=backtest,
        stress_results=stress,
        observations=development,
        review_round=1,
    )
    kelly_finding = next(finding for finding in invalid_review.findings if finding.check == "kelly_misuse")
    assert kelly_finding.status == CheckStatus.FAIL


def test_critic_rejects_identity_mismatches_missing_folds_and_holdout_contamination() -> None:
    spec = _spec("a" * 64)
    artifact, development, validation, backtest, stress = _evidence_bundle(spec)
    critic = IndependentCriticAgent()

    missing_fold_validation = validation.model_copy(
        update={"fold_results": validation.fold_results[:-1]}
    )
    missing_fold = critic.review(
        spec=spec,
        artifact=artifact,
        validation=missing_fold_validation,
        backtest=backtest,
        stress_results=stress,
        observations=development,
        review_round=1,
    )
    assert next(
        finding for finding in missing_fold.findings if finding.check == "fold_evidence"
    ).status == CheckStatus.FAIL

    contaminated_validation = validation.model_copy(
        update={"reason_codes": (*validation.reason_codes, "HOLDOUT_CONTAMINATION")}
    )
    contaminated = critic.review(
        spec=spec,
        artifact=artifact,
        validation=contaminated_validation,
        backtest=backtest,
        stress_results=stress,
        observations=development,
        review_round=1,
    )
    assert next(
        finding for finding in contaminated.findings if finding.check == "holdout_contamination"
    ).status == CheckStatus.FAIL

    first_fold = validation.folds[0]
    overlap_fold = first_fold.model_copy(
        update={
            "test_fixture_ids": (
                *first_fold.test_fixture_ids,
                first_fold.train_fixture_ids[0],
            )
        }
    )
    overlap_validation = validation.model_copy(
        update={"folds": (overlap_fold, *validation.folds[1:])}
    )
    overlap_review = critic.review(
        spec=spec,
        artifact=artifact,
        validation=overlap_validation,
        backtest=backtest,
        stress_results=stress,
        observations=development,
        review_round=1,
    )
    assert next(
        finding for finding in overlap_review.findings if finding.check == "fixture_dependence"
    ).status == CheckStatus.FAIL

    for changed_spec in (
        spec.model_copy(update={"data_snapshot_hash": "d" * 64}),
        spec.model_copy(update={"feature_manifest_hash": "f" * 64}),
    ):
        mismatched = critic.review(
            spec=changed_spec,
            artifact=artifact,
            validation=validation,
            backtest=backtest,
            stress_results=stress,
            observations=development,
            review_round=1,
        )
        assert next(
            finding for finding in mismatched.findings if finding.check == "evidence_binding"
        ).status == CheckStatus.FAIL


def test_synthetic_end_to_end_is_rejected_and_never_promoted(tmp_path: Path) -> None:
    summary = run_synthetic_experiment(tmp_path)
    assert summary["experiment_id"] == EXPERIMENT_ID
    assert summary["final_state"] == ResearchState.REJECTED.value
    assert summary["decision"] == PromotionTarget.REJECTED.value
    assert summary["holdout_evaluated"] is False
    assert summary["production_theo_provider_modified"] is False
    assert summary["registry_events"] == 8
    registrations = ArtifactRegistry(tmp_path / "artifact-registry.jsonl").registrations()
    assert len(registrations) == 1
    assert registrations[0].role.value == "CHALLENGER"
    summary_file = json.loads((tmp_path / "summary.json").read_text())
    assert "SYNTHETIC_PIPELINE_VALIDATION_ONLY" in summary_file["reason_codes"]
    artifact_registry = ArtifactRegistry(tmp_path / "artifact-registry.jsonl")
    artifact = artifact_registry.registrations()[0].artifact
    forged_paper = PromotionDecision(
        experiment_id=artifact.experiment_id,
        binding=artifact.binding.model_copy(update={"validation_fold": "PROMOTION_DECISION"}),
        target=PromotionTarget.PROMOTE_TO_PAPER,
        decided_at=datetime.now(UTC),
        gate_version="forged",
        passed_rules=(),
        failed_rules=(),
        reason_codes=(),
        decision_hash="f" * 64,
    )
    with pytest.raises(ValueError, match="synthetic artifacts"):
        artifact_registry.promote_champion(artifact, forged_paper)


def test_same_fixed_seed_lifecycle_is_reproducible(tmp_path: Path) -> None:
    first = run_synthetic_experiment(tmp_path / "first")
    second = run_synthetic_experiment(tmp_path / "second")
    assert first["decision_hash"] == second["decision_hash"]
    assert first["decision"] == second["decision"]
    assert first["holdout_seal"] == second["holdout_seal"]


def test_deterministic_gate_hash_ignores_decision_timestamp() -> None:
    spec = _spec("a" * 64)
    artifact, development, validation, backtest, stress = _evidence_bundle(spec)
    review = IndependentCriticAgent().review(
        spec=spec,
        artifact=artifact,
        validation=validation,
        backtest=backtest,
        stress_results=stress,
        observations=development,
        review_round=2,
    )
    gate = DeterministicPromotionGate()
    first = gate.decide(
        spec=spec,
        artifact=artifact,
        validation=validation,
        final_review=review,
        backtest=backtest,
        stress_results=stress,
        holdout_evaluation=None,
        decided_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    second = gate.decide(
        spec=spec,
        artifact=artifact,
        validation=validation,
        final_review=review,
        backtest=backtest,
        stress_results=stress,
        holdout_evaluation=None,
        decided_at=datetime(2026, 1, 2, tzinfo=UTC),
    )
    assert first.target == PromotionTarget.REJECTED
    assert first.decision_hash == second.decision_hash

    altered_backtest = backtest.model_copy(update={"assumptions_hash": "f" * 64})
    with pytest.raises(ValueError, match="not bound"):
        gate.decide(
            spec=spec,
            artifact=artifact,
            validation=validation,
            final_review=review,
            backtest=altered_backtest,
            stress_results=stress,
            holdout_evaluation=None,
        )
    altered_review = IndependentCriticAgent().review(
        spec=spec,
        artifact=artifact,
        validation=validation,
        backtest=altered_backtest,
        stress_results=stress,
        observations=development,
        review_round=2,
    )
    altered = gate.decide(
        spec=spec,
        artifact=artifact,
        validation=validation,
        final_review=altered_review,
        backtest=altered_backtest,
        stress_results=stress,
        holdout_evaluation=None,
    )
    assert altered.decision_hash != first.decision_hash

    mismatched_stress = (stress[0].model_copy(update={"experiment_id": "other"}),)
    with pytest.raises(ValueError, match="different experiment"):
        gate.decide(
            spec=spec,
            artifact=artifact,
            validation=validation,
            final_review=review,
            backtest=backtest,
            stress_results=mismatched_stress,
            holdout_evaluation=None,
        )


def test_champion_requires_registered_challenger_and_verified_gate_evidence(tmp_path: Path) -> None:
    base_spec = _spec("a" * 64)
    spec = base_spec.model_copy(
        update={
            "data_mode": DataMode.REPLAY,
            "implementation_claim": "Replay-only governed challenger; no live or profitability claim.",
        }
    )
    artifact, development, validation, backtest, stress = _evidence_bundle(
        spec,
        with_returns=True,
    )
    review = IndependentCriticAgent().review(
        spec=spec,
        artifact=artifact,
        validation=validation,
        backtest=backtest,
        stress_results=stress,
        observations=development,
        review_round=2,
    )
    decision = DeterministicPromotionGate().decide(
        spec=spec,
        artifact=artifact,
        validation=validation,
        final_review=review,
        backtest=backtest,
        stress_results=stress,
        holdout_evaluation=None,
    )
    assert decision.target == PromotionTarget.PROMOTE_TO_REPLAY
    registry = ArtifactRegistry(tmp_path / "verified-artifacts.jsonl")
    forged = decision.model_copy(update={"decision_hash": "0" * 64})
    with pytest.raises(ValueError, match="registered as the identical challenger"):
        registry.promote_champion(
            artifact,
            forged,
            spec=spec,
            validation=validation,
            final_review=review,
            backtest=backtest,
            stress_results=stress,
            holdout_evaluation=None,
        )
    registry.register_challenger(artifact, _artifact_content())
    with pytest.raises(ValueError, match="does not verify"):
        registry.promote_champion(
            artifact,
            forged,
            spec=spec,
            validation=validation,
            final_review=review,
            backtest=backtest,
            stress_results=stress,
            holdout_evaluation=None,
        )
    promoted = registry.promote_champion(
        artifact,
        decision,
        spec=spec,
        validation=validation,
        final_review=review,
        backtest=backtest,
        stress_results=stress,
        holdout_evaluation=None,
    )
    assert promoted.role.value == "CHAMPION"
