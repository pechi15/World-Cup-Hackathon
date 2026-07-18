"""Authoritative repository-backed Colab experiment runtime."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import pyarrow as pa  # type: ignore[import-untyped]
import pyarrow.parquet as pq  # type: ignore[import-untyped]
import yaml  # type: ignore[import-untyped]
from jsonschema import validate as validate_json_schema  # type: ignore[import-untyped]

from .backtest import latency_aware_backtest, run_stress_suite
from .contracts import (
    ArtifactChecksum,
    ArtifactManifest,
    ArtifactMetadata,
    BacktestConfig,
    BacktestReport,
    CalibrationMetadata,
    CriticReview,
    DataMode,
    DatasetInputConfig,
    DatasetManifest,
    DatasetSourceType,
    ExperimentRunConfig,
    ExperimentSpec,
    FeatureManifest,
    PackageVersion,
    PredictionObservation,
    PromotionDecision,
    PromotionTarget,
    RunMetadata,
    ResearchState,
    StressResult,
    ValidationReport,
    ValidationWindow,
)
from .critic import IndependentCriticAgent
from .evidence import binding_for, feature_manifest_hash
from .promotion import DeterministicPromotionGate
from .providers import PerplexityAgentProvider
from .secrets import load_perplexity_configuration
from .synthetic import _execution_inputs, _synthetic_observations
from .validation import seal_chronological_holdout, walk_forward_validation
from .workflow import ActorRole, ResearchStateMachine


REQUIRED_OUTPUTS = (
    "run-metadata.json",
    "experiment-spec.yaml",
    "feature-manifest.json",
    "dataset-manifest.json",
    "fold-results.parquet",
    "predictions.parquet",
    "calibration-report.json",
    "execution-report.json",
    "markout-report.json",
    "stress-tests.json",
    "critic-review.json",
    "promotion-decision.json",
    "model-card.md",
    "checksums.json",
)


@dataclass(frozen=True, slots=True)
class GitProvenance:
    branch: str
    commit: str
    commit_time: datetime


@dataclass(frozen=True, slots=True)
class GovernedRun:
    spec: ExperimentSpec
    features: FeatureManifest
    dataset: DatasetManifest
    observations: tuple[PredictionObservation, ...]
    artifact: ArtifactManifest
    artifact_bytes: bytes
    validation: ValidationReport
    backtest: BacktestReport
    stress_results: tuple[StressResult, ...]
    critic_review: CriticReview
    promotion: PromotionDecision
    final_state: ResearchState
    provenance: GitProvenance
    agent_model_identifier: str
    prompt_version: str


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _git(repo_root: Path, *arguments: str) -> str:
    return subprocess.check_output(("git", *arguments), cwd=repo_root, text=True).strip()


def verify_git_provenance(
    repo_root: Path,
    *,
    expected_branch: str,
    expected_commit: str | None = None,
) -> GitProvenance:
    branch = _git(repo_root, "branch", "--show-current")
    commit = _git(repo_root, "rev-parse", "HEAD")
    if branch != expected_branch:
        raise ValueError(f"checked-out branch {branch!r} does not match {expected_branch!r}")
    if expected_commit is not None and commit != expected_commit:
        raise ValueError(f"checked-out commit {commit} does not match pinned commit {expected_commit}")
    commit_time = datetime.fromisoformat(_git(repo_root, "show", "-s", "--format=%cI", "HEAD"))
    return GitProvenance(branch=branch, commit=commit, commit_time=commit_time)


def _load_yaml(path: Path) -> dict[str, Any]:
    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a mapping")
    return payload


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain an object")
    return payload


def _resolve_path(repo_root: Path, config_path: Path, value: str) -> Path:
    repository_relative = repo_root / value
    return repository_relative if repository_relative.exists() else config_path.parent / value


def load_feature_manifest(path: Path, *, expected_hash: str | None = None) -> FeatureManifest:
    raw = _load_json(path)
    manifest = FeatureManifest.model_validate(raw)
    calculated = feature_manifest_hash(manifest.features)
    if manifest.manifest_hash != calculated:
        raise ValueError("feature manifest hash mismatch")
    if expected_hash is not None and calculated != expected_hash:
        raise ValueError("feature manifest does not match expected hash")
    return manifest


def _canonical_observation_hash(observations: tuple[PredictionObservation, ...]) -> str:
    payload = [row.model_dump(mode="json") for row in observations]
    return sha256_bytes(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())


def load_dataset(
    config: DatasetInputConfig,
    *,
    data_mode: DataMode,
    repo_root: Path,
    expected_hash: str | None = None,
) -> tuple[DatasetManifest, tuple[PredictionObservation, ...]]:
    if config.source_type == DatasetSourceType.DETERMINISTIC_GENERATOR:
        if data_mode != DataMode.SYNTHETIC_TEST or config.generator is None:
            raise ValueError("deterministic generator is restricted to SYNTHETIC_TEST")
        observations = _synthetic_observations(config.generator.count)
        source_uri = config.source_uri
        sanitized = True
    elif config.source_type == DatasetSourceType.JSON_OBSERVATIONS:
        source_path = _resolve_path(repo_root, repo_root, config.source_uri)
        raw = json.loads(source_path.read_text(encoding="utf-8"))
        if not isinstance(raw, list):
            raise ValueError("JSON observation dataset must be an array")
        observations = tuple(PredictionObservation.model_validate(item) for item in raw)
        source_uri = str(source_path.relative_to(repo_root)).replace("\\", "/")
        sanitized = data_mode != DataMode.REAL_HISTORICAL
    else:
        source_path = _resolve_path(repo_root, repo_root, config.source_uri)
        raw = _load_json(source_path)
        if "fixtures" not in raw and "updates" not in raw:
            raise ValueError("TxODDS replay dataset schema is not recognized")
        raise ValueError("SANITIZED_TXODDS sample has no settled outcomes; evaluation fails closed")

    dataset_hash = _canonical_observation_hash(observations)
    declared = expected_hash or config.expected_hash
    if declared is not None and dataset_hash != declared:
        raise ValueError("dataset hash mismatch")
    fixtures = {row.fixture_id for row in observations}
    manifest = DatasetManifest(
        schema_version="DATASET/1",
        dataset_id=f"{data_mode.value.lower()}-{dataset_hash[:12]}",
        data_mode=data_mode,
        source_type=config.source_type,
        source_uri=source_uri,
        content_hash=dataset_hash,
        record_count=len(observations),
        fixture_count=len(fixtures),
        contains_settled_outcomes=True,
        sanitized=sanitized,
        generator=config.generator,
    )
    return manifest, observations


def build_experiment(
    *,
    run_config: ExperimentRunConfig,
    feature_manifest: FeatureManifest,
    model_config_path: Path,
    backtest_config_path: Path,
    dataset: DatasetManifest,
    provenance: GitProvenance,
) -> tuple[ExperimentSpec, BacktestConfig, str, str]:
    from .contracts import ModelConfig

    model_config = ModelConfig.model_validate(_load_yaml(model_config_path))
    backtest_config = BacktestConfig.model_validate(_load_yaml(backtest_config_path))
    spec = ExperimentSpec(
        experiment_id=run_config.experiment_id,
        created_at=run_config.created_at,
        data_mode=run_config.data_mode,
        hypothesis=run_config.hypothesis,
        features=feature_manifest.features,
        split=run_config.split,
        holdout=run_config.holdout,
        latency=backtest_config.latency,
        fills=backtest_config.fills,
        model_family=model_config.model_family,
        model_parameters=model_config.parameters,
        random_seed=run_config.random_seed,
        primary_metrics=run_config.primary_metrics,
        stress_scenarios=tuple(scenario.name for scenario in backtest_config.stress_scenarios),
        max_trials=run_config.max_trials,
        implementation_claim=run_config.implementation_claim,
        data_snapshot_hash=dataset.content_hash,
        git_commit=provenance.commit,
        feature_manifest_hash=feature_manifest.manifest_hash,
        training_cutoff=run_config.training_cutoff,
    )
    return (
        spec,
        backtest_config,
        model_config.agent_model_identifier,
        model_config.prompt_version,
    )


def train_challenger(
    spec: ExperimentSpec,
    dataset: DatasetManifest,
) -> tuple[bytes, str]:
    payload = {
        "algorithm": spec.model_family,
        "dataset_hash": dataset.content_hash,
        "feature_manifest_hash": spec.feature_manifest_hash,
        "git_commit": spec.git_commit,
        "parameters": [parameter.model_dump(mode="json") for parameter in spec.model_parameters],
        "random_seed": spec.random_seed,
        "training_cutoff": spec.training_cutoff.isoformat(),
    }
    content = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return content, sha256_bytes(content)


def run_governed_experiment(
    *,
    repo_root: Path,
    experiment_config_path: Path,
    expected_commit: str | None = None,
    expected_dataset_hash: str | None = None,
    expected_feature_hash: str | None = None,
) -> GovernedRun:
    run_config = ExperimentRunConfig.model_validate(_load_yaml(experiment_config_path))
    provenance = verify_git_provenance(
        repo_root,
        expected_branch=run_config.expected_branch,
        expected_commit=expected_commit or run_config.expected_commit,
    )
    feature_path = _resolve_path(repo_root, experiment_config_path, run_config.feature_manifest_path)
    model_path = _resolve_path(repo_root, experiment_config_path, run_config.model_config_path)
    backtest_path = _resolve_path(repo_root, experiment_config_path, run_config.backtest_config_path)
    feature_manifest = load_feature_manifest(feature_path, expected_hash=expected_feature_hash)
    dataset, observations = load_dataset(
        run_config.dataset,
        data_mode=run_config.data_mode,
        repo_root=repo_root,
        expected_hash=expected_dataset_hash,
    )
    spec, backtest_config, configured_agent, prompt_version = build_experiment(
        run_config=run_config,
        feature_manifest=feature_manifest,
        model_config_path=model_path,
        backtest_config_path=backtest_path,
        dataset=dataset,
        provenance=provenance,
    )

    artifact_bytes, artifact_checksum = train_challenger(spec, dataset)
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
    calibration = validation.calibration
    artifact = ArtifactManifest(
        artifact_id=f"artifact-{spec.experiment_id}-{artifact_checksum[:12]}",
        experiment_id=spec.experiment_id,
        content_hash=artifact_checksum,
        uri="model.bin",
        media_type="application/octet-stream",
        created_at=spec.training_cutoff,
        model_family=spec.model_family,
        data_snapshot_hash=spec.data_snapshot_hash,
        code_revision=spec.git_commit,
        feature_manifest_hash=spec.feature_manifest_hash,
        training_cutoff=spec.training_cutoff,
        schema_version="RESEARCH_ARTIFACT/1",
        calibration=CalibrationMetadata(
            method="WALK_FORWARD_OUT_OF_SAMPLE",
            fitted_at=provenance.commit_time,
            sample_size=calibration.sample_size,
            expected_calibration_error=calibration.expected_calibration_error or 1.0,
            schema_version="CALIBRATION/1",
        ),
        data_mode=spec.data_mode,
        binding=binding_for(
            spec,
            artifact_checksum=artifact_checksum,
            validation_fold="TRAINING",
        ),
        metrics=validation.metrics,
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
        backtest_config.stress_scenarios,
        experiment_id=spec.experiment_id,
        data_snapshot_hash=spec.data_snapshot_hash,
        binding=binding_for(
            spec,
            artifact_checksum=artifact_checksum,
            validation_fold="STRESS_SUITE",
        ),
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
    ).model_copy(update={"reviewed_at": provenance.commit_time})
    final_review = critic.review(
        spec=spec,
        artifact=artifact,
        validation=validation,
        backtest=backtest,
        stress_results=stress_results,
        observations=sealed.development,
        review_round=2,
    ).model_copy(update={"reviewed_at": provenance.commit_time})
    promotion = DeterministicPromotionGate().decide(
        spec=spec,
        artifact=artifact,
        validation=validation,
        final_review=final_review,
        backtest=backtest,
        stress_results=stress_results,
        holdout_evaluation=None,
        decided_at=provenance.commit_time,
    )
    if spec.data_mode == DataMode.SYNTHETIC_TEST and promotion.target == PromotionTarget.PROMOTE_TO_PAPER:
        raise AssertionError("synthetic evidence cannot be promoted to paper")

    machine = ResearchStateMachine(spec.experiment_id)
    for target, actor in (
        (ResearchState.SPEC_VALIDATED, ActorRole.RESEARCHER),
        (ResearchState.TRAINED, ActorRole.RESEARCHER),
        (ResearchState.WALK_FORWARD_EVALUATED, ActorRole.RESEARCHER),
        (ResearchState.CRITIC_REVIEWED, ActorRole.CRITIC),
        (ResearchState.REVISED_ONCE, ActorRole.RESEARCHER),
        (ResearchState.FINAL_REVIEW, ActorRole.CRITIC),
        (ResearchState(promotion.target.value), ActorRole.GOVERNANCE),
    ):
        machine = machine.transition(target, actor)

    perplexity = load_perplexity_configuration()
    provider = PerplexityAgentProvider(
        api_key=perplexity.api_key,
        enable_context=perplexity.configured,
    )
    agent_model_identifier = (
        provider.model_identifier if provider.enabled else configured_agent
    )
    _ = first_review  # The bounded revision consumes round one before final review.
    return GovernedRun(
        spec=spec,
        features=feature_manifest,
        dataset=dataset,
        observations=observations,
        artifact=artifact,
        artifact_bytes=artifact_bytes,
        validation=validation,
        backtest=backtest,
        stress_results=stress_results,
        critic_review=final_review,
        promotion=promotion,
        final_state=machine.state,
        provenance=provenance,
        agent_model_identifier=agent_model_identifier,
        prompt_version=prompt_version,
    )


def _write_json(path: Path, value: Any) -> None:
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _write_parquet(path: Path, rows: list[dict[str, Any]]) -> None:
    table = pa.Table.from_pylist(rows)
    pq.write_table(table, path, compression="zstd", write_statistics=True)


def _package_versions() -> tuple[PackageVersion, ...]:
    names = ("jsonschema", "pyarrow", "pydantic", "PyYAML", "world-cup-quant-research")
    versions = [PackageVersion(name="python", version=platform.python_version())]
    for name in names:
        try:
            version = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            version = "NOT_INSTALLED"
        versions.append(PackageVersion(name=name, version=version))
    return tuple(sorted(versions, key=lambda item: item.name.lower()))


def _checksums(directory: Path, names: list[str]) -> tuple[ArtifactChecksum, ...]:
    return tuple(
        ArtifactChecksum(
            path=name,
            sha256=sha256_file(directory / name),
            size_bytes=(directory / name).stat().st_size,
        )
        for name in sorted(names)
    )


def _validate_checked_schema(instance: Any, schema_path: Path) -> None:
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    validate_json_schema(instance=instance, schema=schema)


def save_artifacts(run: GovernedRun, output_dir: Path, *, schemas_dir: Path) -> tuple[ArtifactChecksum, ...]:
    if output_dir.exists() and any(output_dir.iterdir()):
        raise FileExistsError(f"output directory is not empty: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "model.bin").write_bytes(run.artifact_bytes)
    (output_dir / "experiment-spec.yaml").write_text(
        yaml.safe_dump(run.spec.model_dump(mode="json"), sort_keys=True),
        encoding="utf-8",
    )
    _write_json(output_dir / "feature-manifest.json", run.features)
    _write_json(output_dir / "dataset-manifest.json", run.dataset)

    fold_rows = [
        {
            "fold_id": result.fold_id,
            "training_cutoff": fold.training_cutoff.isoformat(),
            "test_start": fold.test_start.isoformat(),
            "test_fixture_count": result.test_fixture_count,
            "test_observation_count": result.test_observation_count,
            "metrics_json": json.dumps(
                [metric.model_dump(mode="json") for metric in result.metrics],
                sort_keys=True,
            ),
        }
        for fold, result in zip(run.validation.folds, run.validation.fold_results, strict=True)
    ]
    _write_parquet(output_dir / "fold-results.parquet", fold_rows)
    fold_by_observation = {
        observation_id: fold.fold_id
        for fold in run.validation.folds
        for observation_id in fold.test_ids
    }
    prediction_rows = [
        {
            **row.model_dump(mode="json"),
            "fold_id": fold_by_observation[row.observation_id],
        }
        for row in run.observations
        if row.observation_id in fold_by_observation
    ]
    _write_parquet(output_dir / "predictions.parquet", prediction_rows)
    _write_json(output_dir / "calibration-report.json", run.validation.calibration)
    _write_json(output_dir / "execution-report.json", run.backtest)
    _write_json(
        output_dir / "markout-report.json",
        {"markouts": [item.model_dump(mode="json") for item in run.backtest.markouts]},
    )
    _write_json(
        output_dir / "stress-tests.json",
        {"stress_tests": [item.model_dump(mode="json") for item in run.stress_results]},
    )
    _write_json(output_dir / "critic-review.json", run.critic_review)
    _write_json(output_dir / "promotion-decision.json", run.promotion)
    model_card = (
        f"# Model card: {run.spec.experiment_id}\n\n"
        f"- Data mode: `{run.spec.data_mode.value}`\n"
        f"- Model family: `{run.spec.model_family}`\n"
        f"- Git commit: `{run.spec.git_commit}`\n"
        f"- Dataset hash: `{run.spec.data_snapshot_hash}`\n"
        f"- Feature hash: `{run.spec.feature_manifest_hash}`\n"
        f"- Final state: `{run.final_state.value}`\n"
        f"- Promotion: `{run.promotion.target.value}`\n\n"
        "Synthetic and sanitized evidence is pipeline validation only. This artifact is not integrated "
        "with production trading, wallets, deployment, or the live TheoProvider.\n"
    )
    (output_dir / "model-card.md").write_text(model_card, encoding="utf-8")

    initial_names = [
        "model.bin",
        "experiment-spec.yaml",
        "feature-manifest.json",
        "dataset-manifest.json",
        "fold-results.parquet",
        "predictions.parquet",
        "calibration-report.json",
        "execution-report.json",
        "markout-report.json",
        "stress-tests.json",
        "critic-review.json",
        "promotion-decision.json",
        "model-card.md",
    ]
    initial_checksums = _checksums(output_dir, initial_names)
    metadata = ArtifactMetadata(
        schema_version="ARTIFACT_METADATA/1",
        experiment_id=run.spec.experiment_id,
        data_mode=run.spec.data_mode,
        model_family=run.spec.model_family,
        model_artifact=next(item for item in initial_checksums if item.path == "model.bin"),
        generated_files=initial_checksums,
        promotion_target=run.promotion.target,
    )
    _write_json(output_dir / "artifact-metadata.json", metadata)
    provenance_checksums = _checksums(output_dir, [*initial_names, "artifact-metadata.json"])
    run_metadata = RunMetadata(
        schema_version="RUN_METADATA/1",
        git_commit=run.provenance.commit,
        branch=run.provenance.branch,
        dataset_hash=run.dataset.content_hash,
        feature_manifest_hash=run.features.manifest_hash,
        experiment_id=run.spec.experiment_id,
        random_seed=run.spec.random_seed,
        training_cutoff=run.spec.training_cutoff,
        validation_windows=tuple(
            ValidationWindow(
                fold_id=fold.fold_id,
                training_cutoff=fold.training_cutoff,
                test_start=fold.test_start,
                test_fixture_ids=fold.test_fixture_ids,
            )
            for fold in run.validation.folds
        ),
        package_versions=_package_versions(),
        agent_model_identifier=run.agent_model_identifier,
        prompt_version=run.prompt_version,
        run_timestamp=run.provenance.commit_time,
        artifact_checksums=provenance_checksums,
    )
    _write_json(output_dir / "run-metadata.json", run_metadata)
    final_names = [*initial_names, "artifact-metadata.json", "run-metadata.json"]
    final_checksums = _checksums(output_dir, final_names)
    _write_json(
        output_dir / "checksums.json",
        {
            "algorithm": "SHA-256",
            "files": [item.model_dump(mode="json") for item in final_checksums],
        },
    )

    _validate_checked_schema(
        run.dataset.model_dump(mode="json"),
        schemas_dir / "dataset.schema.json",
    )
    _validate_checked_schema(
        run.spec.model_dump(mode="json"),
        schemas_dir / "experiment.schema.json",
    )
    _validate_checked_schema(
        run.features.model_dump(mode="json"),
        schemas_dir / "feature-manifest.schema.json",
    )
    _validate_checked_schema(
        metadata.model_dump(mode="json"),
        schemas_dir / "artifact-metadata.schema.json",
    )
    return final_checksums


def copy_artifacts(source: Path, destination: Path) -> None:
    if not (source / "checksums.json").exists():
        raise ValueError("source does not contain checksums.json")
    destination.mkdir(parents=True, exist_ok=True)
    for item in source.iterdir():
        if item.is_file():
            shutil.copy2(item, destination / item.name)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run governed repository code for Colab")
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--experiment-config", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--expected-commit")
    parser.add_argument("--expected-dataset-hash")
    parser.add_argument("--expected-feature-hash")
    parser.add_argument("--allow-temporary-output", action="store_true")
    return parser


def main() -> None:
    arguments = build_parser().parse_args()
    output = arguments.output_dir.resolve()
    temporary_roots = (Path("/tmp"), Path("/content"))
    is_drive = str(output).startswith("/content/drive/")
    if (
        not arguments.allow_temporary_output
        and not is_drive
        and any(str(output).startswith(str(root)) for root in temporary_roots)
    ):
        raise ValueError("output must be persisted outside the temporary runtime")
    run = run_governed_experiment(
        repo_root=arguments.repo_root.resolve(),
        experiment_config_path=arguments.experiment_config.resolve(),
        expected_commit=arguments.expected_commit,
        expected_dataset_hash=arguments.expected_dataset_hash,
        expected_feature_hash=arguments.expected_feature_hash,
    )
    schemas = arguments.repo_root.resolve() / "research" / "schemas"
    save_artifacts(run, output, schemas_dir=schemas)
    print(json.dumps({"output_dir": str(output), "promotion": run.promotion.target.value}))


if __name__ == "__main__":
    main()
