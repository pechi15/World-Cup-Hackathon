"""One deterministic end-to-end researcher/critic experiment for framework validation."""

from __future__ import annotations

import hashlib
import json
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .backtest import latency_aware_backtest, run_stress_suite
from .contracts import (
    ArtifactManifest,
    CalibrationMetadata,
    DataMode,
    ExperimentSpec,
    FeatureAvailability,
    FeatureDefinition,
    FillAssumptions,
    HoldoutSpec,
    Hypothesis,
    LatencyAssumptions,
    MarketTick,
    ModelParameter,
    OrderIntent,
    PredictionObservation,
    PromotionTarget,
    PurgedSplitSpec,
    ResearchState,
    StressScenario,
)
from .critic import IndependentCriticAgent
from .evidence import binding_for, feature_manifest_hash
from .promotion import DeterministicPromotionGate
from .registry import ArtifactRegistry, ExperimentRegistry
from .validation import seal_chronological_holdout, walk_forward_validation
from .workflow import ActorRole, ResearchStateMachine


EXPERIMENT_ID = "SYNTHETIC-GOVERNANCE-E2E-001"


def _current_git_commit() -> str:
    root = Path(__file__).resolve().parents[2]
    return subprocess.check_output(
        ("git", "rev-parse", "HEAD"),
        cwd=root,
        text=True,
    ).strip()


def _synthetic_observations(count: int = 200) -> tuple[PredictionObservation, ...]:
    probabilities = (0.05, 0.25, 0.50, 0.75, 0.95)
    start = datetime(2026, 1, 1, tzinfo=UTC)
    rows: list[PredictionObservation] = []
    for index in range(count):
        probability = probabilities[index % len(probabilities)]
        occurrence_index = index // len(probabilities)
        outcome = int(((occurrence_index * 17) % 40) < round(probability * 40))
        timestamp = start + timedelta(hours=index * 3)
        rows.append(
            PredictionObservation(
                observation_id=f"obs-{index:04d}",
                fixture_id=f"fixture-{index:04d}",
                event_time=timestamp,
                available_at=timestamp + timedelta(milliseconds=10),
                decision_time=timestamp + timedelta(milliseconds=20),
                target_available_at=timestamp + timedelta(hours=2),
                probability=probability,
                baseline_probability=0.5 + 0.6 * (probability - 0.5),
                outcome=outcome,
                strategy_return=None,
            )
        )
    return tuple(rows)


def _execution_inputs(
    observations: tuple[PredictionObservation, ...],
) -> tuple[tuple[OrderIntent, ...], tuple[MarketTick, ...]]:
    orders: list[OrderIntent] = []
    ticks: list[MarketTick] = []
    for index, row in enumerate(observations):
        quoted_ask = min(0.99, row.probability + 0.01)
        quoted_bid = max(0.01, row.probability - 0.01)
        limit = quoted_ask + 0.001 if index % 2 == 0 else quoted_bid
        orders.append(
            OrderIntent(
                order_id=f"order-{index:04d}",
                fixture_id=row.fixture_id,
                selection_id="YES",
                decision_time=row.decision_time,
                side="BUY",
                limit_price=limit,
                quantity=1.0,
            )
        )
        ticks.extend(
            (
                MarketTick(
                    fixture_id=row.fixture_id,
                    selection_id="YES",
                    event_time=row.decision_time + timedelta(milliseconds=150),
                    available_at=row.decision_time + timedelta(milliseconds=200),
                    bid=quoted_bid,
                    ask=quoted_ask,
                    available_size=1.0,
                ),
                MarketTick(
                    fixture_id=row.fixture_id,
                    selection_id="YES",
                    event_time=row.decision_time + timedelta(seconds=60),
                    available_at=row.decision_time + timedelta(seconds=61),
                    bid=min(0.99, quoted_bid + 0.01),
                    ask=min(1.0, quoted_ask + 0.01),
                    available_size=1.0,
                ),
                MarketTick(
                    fixture_id=row.fixture_id,
                    selection_id="YES",
                    event_time=row.decision_time + timedelta(seconds=300),
                    available_at=row.decision_time + timedelta(seconds=301),
                    bid=min(0.99, quoted_bid + 0.005),
                    ask=min(1.0, quoted_ask + 0.005),
                    available_size=1.0,
                ),
            )
        )
    return tuple(orders), tuple(ticks)


def _spec(snapshot_hash: str, git_commit: str = "0000000") -> ExperimentSpec:
    features = (
        FeatureDefinition(
            name="synthetic_probability",
            dtype="float64",
            description="Known synthetic event probability.",
            source="deterministic_fixture_generator",
            availability=FeatureAvailability.RECEIVE_TIME,
            lookback_seconds=0,
            known_at_field="available_at",
        ),
    )
    return ExperimentSpec(
        experiment_id=EXPERIMENT_ID,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        data_mode=DataMode.SYNTHETIC,
        hypothesis=Hypothesis(
            hypothesis_id="SYNTHETIC_CALIBRATION",
            statement="A known synthetic probability process should recover calibrated fixture-safe scores.",
            mechanism="Outcomes are generated at deterministic frequencies matching five probability levels.",
            falsification_criteria=("Walk-forward ECE exceeds 0.08.", "Fixture overlap is detected."),
            academic_references=("brier1950verification", "gneiting2007proper"),
            primary_metric="brier_score",
            benchmark_id="SHRUNK_SYNTHETIC_BASELINE",
        ),
        features=features,
        split=PurgedSplitSpec(
            folds=3,
            min_train_fixtures=30,
            min_test_fixtures=20,
            purge_seconds=60,
            embargo_seconds=60,
        ),
        holdout=HoldoutSpec(fraction=0.2, salt_id="synthetic-e2e-v1", minimum_fixtures=20),
        latency=LatencyAssumptions(
            decision_ms=25,
            network_ms=75,
            exchange_ms=50,
            cancel_ms=100,
            max_staleness_ms=500,
        ),
        fills=FillAssumptions(
            mode="CROSS",
            queue_fraction=1.0,
            slippage_bps=0.0,
            fee_bps=2.0,
            partial_fills=True,
        ),
        model_family="SYNTHETIC_FREQUENCY_MODEL",
        model_parameters=(ModelParameter(name="kelly_fraction", value=0.10),),
        random_seed=7,
        primary_metrics=("brier_score", "expected_calibration_error"),
        stress_scenarios=("DOUBLE_LATENCY", "WIDER_BOOK"),
        max_trials=2,
        implementation_claim=(
            "Synthetic pipeline validation only; this is not evidence of alpha, profitability, or live readiness."
        ),
        data_snapshot_hash=snapshot_hash,
        git_commit=git_commit,
        feature_manifest_hash=feature_manifest_hash(features),
        training_cutoff=datetime(2026, 1, 20, tzinfo=UTC),
    )


def run_synthetic_experiment(output_dir: Path) -> dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)
    experiment_ledger = ExperimentRegistry(output_dir / "experiment-events.jsonl")
    artifact_ledger = ArtifactRegistry(output_dir / "artifact-registry.jsonl")
    if experiment_ledger.events():
        raise FileExistsError("output directory already contains an experiment ledger")

    observations = _synthetic_observations()
    snapshot_hash = hashlib.sha256(
        json.dumps([row.model_dump(mode="json") for row in observations], sort_keys=True).encode()
    ).hexdigest()
    spec = _spec(snapshot_hash, _current_git_commit())
    artifact_bytes = b"deterministic synthetic frequency model; no production integration"
    artifact_checksum = hashlib.sha256(artifact_bytes).hexdigest()
    artifact = ArtifactManifest(
        artifact_id="artifact-synthetic-e2e-001",
        experiment_id=EXPERIMENT_ID,
        content_hash=artifact_checksum,
        uri="isolated://challengers/artifact-synthetic-e2e-001",
        media_type="application/octet-stream",
        created_at=spec.training_cutoff,
        model_family=spec.model_family,
        data_snapshot_hash=snapshot_hash,
        code_revision=spec.git_commit,
        feature_manifest_hash=spec.feature_manifest_hash,
        training_cutoff=spec.training_cutoff,
        schema_version="RESEARCH_ARTIFACT/1",
        calibration=CalibrationMetadata(
            method="SYNTHETIC_GENERATOR_FREQUENCY_CALIBRATION",
            fitted_at=spec.training_cutoff,
            sample_size=120,
            expected_calibration_error=0.05,
            schema_version="CALIBRATION/1",
        ),
        data_mode=spec.data_mode,
        binding=binding_for(
            spec,
            artifact_checksum=artifact_checksum,
            validation_fold="TRAINING",
        ),
    )
    machine = ResearchStateMachine(EXPERIMENT_ID)
    experiment_ledger.append(
        experiment_id=EXPERIMENT_ID,
        event_type="EXPERIMENT_PROPOSED",
        state=machine.state,
        actor=ActorRole.RESEARCHER.value,
        binding=binding_for(
            spec,
            artifact_checksum=artifact_checksum,
            validation_fold="EXPERIMENT_PROPOSED",
        ),
        payload=spec,
        occurred_at=spec.created_at,
    )

    machine = machine.transition(ResearchState.SPEC_VALIDATED, ActorRole.RESEARCHER)
    experiment_ledger.append(
        experiment_id=EXPERIMENT_ID,
        event_type="SPEC_VALIDATED",
        state=machine.state,
        actor=ActorRole.RESEARCHER.value,
        binding=binding_for(
            spec,
            artifact_checksum=artifact_checksum,
            validation_fold="SPEC_VALIDATED",
        ),
        payload={"data_snapshot_hash": snapshot_hash, "protected_resources_unchanged": True},
    )

    artifact_ledger.register_challenger(artifact, artifact_bytes)
    machine = machine.transition(ResearchState.TRAINED, ActorRole.RESEARCHER)
    experiment_ledger.append(
        experiment_id=EXPERIMENT_ID,
        event_type="CHALLENGER_TRAINED",
        state=machine.state,
        actor=ActorRole.RESEARCHER.value,
        binding=binding_for(
            spec,
            artifact_checksum=artifact_checksum,
            validation_fold="CHALLENGER_TRAINED",
        ),
        payload=artifact,
    )

    sealed, _governance_holdout = seal_chronological_holdout(
        observations,
        spec,
        artifact_checksum,
    )
    validation = walk_forward_validation(
        spec,
        sealed.development,
        sealed.seal,
        artifact_checksum,
    )
    orders, ticks = _execution_inputs(sealed.development)
    backtest = latency_aware_backtest(
        orders,
        ticks,
        spec.latency,
        spec.fills,
        experiment_id=spec.experiment_id,
        data_snapshot_hash=spec.data_snapshot_hash,
        binding=binding_for(
            spec,
            artifact_checksum=artifact_checksum,
            validation_fold="BACKTEST",
        ),
    )
    stress_results = run_stress_suite(
        orders,
        ticks,
        spec.latency,
        spec.fills,
        (
            StressScenario(
                name="DOUBLE_LATENCY",
                latency_multiplier=2.0,
                slippage_multiplier=1.0,
                fill_probability_multiplier=1.0,
                probability_shock=0.0,
            ),
            StressScenario(
                name="WIDER_BOOK",
                latency_multiplier=1.0,
                slippage_multiplier=2.0,
                fill_probability_multiplier=0.8,
                probability_shock=0.005,
            ),
        ),
        experiment_id=spec.experiment_id,
        data_snapshot_hash=spec.data_snapshot_hash,
        binding=binding_for(
            spec,
            artifact_checksum=artifact_checksum,
            validation_fold="STRESS_SUITE",
        ),
    )
    machine = machine.transition(ResearchState.WALK_FORWARD_EVALUATED, ActorRole.RESEARCHER)
    experiment_ledger.append(
        experiment_id=EXPERIMENT_ID,
        event_type="WALK_FORWARD_EVALUATED",
        state=machine.state,
        actor=ActorRole.RESEARCHER.value,
        binding=binding_for(
            spec,
            artifact_checksum=artifact_checksum,
            validation_fold="WALK_FORWARD_EVALUATED",
        ),
        payload={
            "validation": validation.model_dump(mode="json"),
            "backtest": backtest.model_dump(mode="json"),
            "stress_results": [item.model_dump(mode="json") for item in stress_results],
        },
    )

    critic = IndependentCriticAgent()
    first_review = critic.review(
        spec=spec,
        artifact=artifact,
        validation=validation,
        backtest=backtest,
        stress_results=stress_results,
        observations=sealed.development,
        review_round=1,
    )
    machine = machine.transition(ResearchState.CRITIC_REVIEWED, ActorRole.CRITIC)
    experiment_ledger.append(
        experiment_id=EXPERIMENT_ID,
        event_type="CRITIC_REVIEW",
        state=machine.state,
        actor=ActorRole.CRITIC.value,
        binding=binding_for(
            spec,
            artifact_checksum=artifact_checksum,
            validation_fold="CRITIC_REVIEW_1",
        ),
        payload=first_review,
    )

    machine = machine.transition(ResearchState.REVISED_ONCE, ActorRole.RESEARCHER)
    experiment_ledger.append(
        experiment_id=EXPERIMENT_ID,
        event_type="BOUNDED_REVISION",
        state=machine.state,
        actor=ActorRole.RESEARCHER.value,
        binding=binding_for(
            spec,
            artifact_checksum=artifact_checksum,
            validation_fold="BOUNDED_REVISION",
        ),
        payload={
            "revision_count": machine.revisions,
            "changes": ["Added explicit synthetic-only claim and retained all original metrics."],
            "model_retrained": False,
        },
    )

    final_review = critic.review(
        spec=spec,
        artifact=artifact,
        validation=validation,
        backtest=backtest,
        stress_results=stress_results,
        observations=sealed.development,
        review_round=2,
    )
    machine = machine.transition(ResearchState.FINAL_REVIEW, ActorRole.CRITIC)
    experiment_ledger.append(
        experiment_id=EXPERIMENT_ID,
        event_type="FINAL_CRITIC_REVIEW",
        state=machine.state,
        actor=ActorRole.CRITIC.value,
        binding=binding_for(
            spec,
            artifact_checksum=artifact_checksum,
            validation_fold="CRITIC_REVIEW_2",
        ),
        payload=final_review,
    )

    decision = DeterministicPromotionGate().decide(
        spec=spec,
        artifact=artifact,
        validation=validation,
        final_review=final_review,
        backtest=backtest,
        stress_results=stress_results,
        holdout_evaluation=None,
    )
    target_state = ResearchState(decision.target.value)
    machine = machine.transition(target_state, ActorRole.GOVERNANCE)
    experiment_ledger.append(
        experiment_id=EXPERIMENT_ID,
        event_type="PROMOTION_DECISION",
        state=machine.state,
        actor=ActorRole.GOVERNANCE.value,
        binding=binding_for(
            spec,
            artifact_checksum=artifact_checksum,
            validation_fold="PROMOTION_DECISION",
        ),
        payload=decision,
    )
    summary: dict[str, object] = {
        "experiment_id": EXPERIMENT_ID,
        "final_state": machine.state.value,
        "decision": decision.target.value,
        "decision_hash": decision.decision_hash,
        "critic_approved": final_review.approved,
        "holdout_seal": sealed.seal,
        "holdout_evaluated": False,
        "registry_events": len(experiment_ledger.assert_complete(EXPERIMENT_ID)),
        "challenger_artifact_id": artifact.artifact_id,
        "production_theo_provider_modified": False,
        "reason_codes": list(decision.reason_codes),
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    if decision.target != PromotionTarget.REJECTED:
        raise AssertionError("synthetic evidence must never pass the promotion gate")
    return summary


def main() -> None:
    run_synthetic_experiment(Path("examples/output/synthetic-e2e"))


if __name__ == "__main__":
    main()
