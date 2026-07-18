from __future__ import annotations

import json
from pathlib import Path

import pyarrow.parquet as pq
import pytest
import yaml
from jsonschema import validate as validate_json_schema

from quant_research.colab_runtime import (
    REQUIRED_OUTPUTS,
    GovernedRun,
    load_feature_manifest,
    run_governed_experiment,
    save_artifacts,
    sha256_file,
    train_challenger,
)
from quant_research.contracts import ContextClaim, DataMode, PromotionTarget
from quant_research.providers import PerplexityAgentProvider, ProviderDisabled
from quant_research.secrets import configuration_status, load_perplexity_configuration


REPO_ROOT = Path(__file__).resolve().parents[2]
RESEARCH_ROOT = REPO_ROOT / "research"
EXPERIMENT_CONFIG = RESEARCH_ROOT / "configs" / "experiment-spec.example.yaml"


@pytest.fixture(scope="module")
def governed_run() -> GovernedRun:
    return run_governed_experiment(
        repo_root=REPO_ROOT,
        experiment_config_path=EXPERIMENT_CONFIG,
    )


def test_notebook_is_a_thin_repository_runner_without_mock_metrics() -> None:
    notebook = json.loads(
        (RESEARCH_ROOT / "notebooks" / "colab_runner.ipynb").read_text(encoding="utf-8")
    )
    code = "\n".join(
        "".join(cell["source"])
        for cell in notebook["cells"]
        if cell["cell_type"] == "code"
    )
    assert "research/colab/bootstrap.py" in code
    assert "research/colab/run_experiment.py" in code
    for forbidden in (
        "np.random.uniform",
        "DummyClassifier",
        "random P&L",
        "random Sharpe",
        "hard-coded markout",
        "promotion_decision =",
    ):
        assert forbidden not in code
    assert callable(train_challenger)


def test_synthetic_run_cannot_reach_paper(governed_run: GovernedRun) -> None:
    assert governed_run.spec.data_mode == DataMode.SYNTHETIC_TEST
    assert governed_run.promotion.target != PromotionTarget.PROMOTE_TO_PAPER
    assert "SYNTHETIC_PIPELINE_VALIDATION_ONLY" in governed_run.promotion.reason_codes


def test_exact_commit_and_all_provenance_are_recorded(
    governed_run: GovernedRun,
    tmp_path: Path,
) -> None:
    save_artifacts(
        governed_run,
        tmp_path,
        schemas_dir=RESEARCH_ROOT / "schemas",
    )
    metadata = json.loads((tmp_path / "run-metadata.json").read_text(encoding="utf-8"))
    assert metadata["git_commit"] == governed_run.provenance.commit
    assert metadata["branch"] == "cursor/quant-agents"
    assert metadata["dataset_hash"] == governed_run.dataset.content_hash
    assert metadata["feature_manifest_hash"] == governed_run.features.manifest_hash
    assert metadata["random_seed"] == governed_run.spec.random_seed
    assert metadata["training_cutoff"] == governed_run.spec.training_cutoff.isoformat().replace(
        "+00:00", "Z"
    )
    assert metadata["validation_windows"]
    assert metadata["package_versions"]
    assert metadata["agent_model_identifier"]
    assert metadata["prompt_version"]
    assert metadata["artifact_checksums"]


def test_dataset_and_feature_hash_mismatches_fail(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="dataset hash mismatch"):
        run_governed_experiment(
            repo_root=REPO_ROOT,
            experiment_config_path=EXPERIMENT_CONFIG,
            expected_dataset_hash="0" * 64,
        )
    source = json.loads(
        (RESEARCH_ROOT / "configs" / "feature-manifest.example.json").read_text(
            encoding="utf-8"
        )
    )
    source["manifest_hash"] = "0" * 64
    bad_manifest = tmp_path / "feature.json"
    bad_manifest.write_text(json.dumps(source), encoding="utf-8")
    with pytest.raises(ValueError, match="feature manifest hash mismatch"):
        load_feature_manifest(bad_manifest)


def test_colab_secrets_never_print_and_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    secret = "pplx-secret-value-that-must-never-print"
    monkeypatch.setenv("ENABLE_PERPLEXITY_CONTEXT", "true")
    configured = load_perplexity_configuration(secret_reader=lambda _: secret)
    print(configuration_status(configured))
    assert configured.configured is True
    assert secret not in capsys.readouterr().out

    missing = load_perplexity_configuration(secret_reader=lambda _: None)
    assert missing.configured is False
    provider = PerplexityAgentProvider(api_key=None, enable_context=False)
    assert provider.enabled is False
    with pytest.raises(ProviderDisabled):
        provider.generate(
            system_prompt="offline",
            user_prompt="disabled",
            response_model=ContextClaim,
            schema_name="ContextClaim",
        )


def test_output_artifacts_satisfy_schemas_and_have_real_parquet_rows(
    governed_run: GovernedRun,
    tmp_path: Path,
) -> None:
    save_artifacts(governed_run, tmp_path, schemas_dir=RESEARCH_ROOT / "schemas")
    assert set(REQUIRED_OUTPUTS).issubset({path.name for path in tmp_path.iterdir()})
    schema_pairs = (
        ("dataset-manifest.json", "dataset.schema.json"),
        ("feature-manifest.json", "feature-manifest.schema.json"),
        ("artifact-metadata.json", "artifact-metadata.schema.json"),
    )
    for artifact_name, schema_name in schema_pairs:
        instance = json.loads((tmp_path / artifact_name).read_text(encoding="utf-8"))
        schema = json.loads(
            (RESEARCH_ROOT / "schemas" / schema_name).read_text(encoding="utf-8")
        )
        validate_json_schema(instance=instance, schema=schema)
    experiment = yaml.safe_load((tmp_path / "experiment-spec.yaml").read_text(encoding="utf-8"))
    experiment_schema = json.loads(
        (RESEARCH_ROOT / "schemas" / "experiment.schema.json").read_text(encoding="utf-8")
    )
    validate_json_schema(instance=experiment, schema=experiment_schema)
    assert pq.read_table(tmp_path / "fold-results.parquet").num_rows == len(
        governed_run.validation.folds
    )
    assert pq.read_table(tmp_path / "predictions.parquet").num_rows > 0
    stress = json.loads((tmp_path / "stress-tests.json").read_text(encoding="utf-8"))
    assert all(item["pnl"] is None for item in stress["stress_tests"])
    assert all(not item["underlying_return_ids"] for item in stress["stress_tests"])


def test_same_seed_and_commit_produce_identical_artifacts(tmp_path: Path) -> None:
    first = run_governed_experiment(
        repo_root=REPO_ROOT,
        experiment_config_path=EXPERIMENT_CONFIG,
    )
    second = run_governed_experiment(
        repo_root=REPO_ROOT,
        experiment_config_path=EXPERIMENT_CONFIG,
    )
    first_dir = tmp_path / "first"
    second_dir = tmp_path / "second"
    save_artifacts(first, first_dir, schemas_dir=RESEARCH_ROOT / "schemas")
    save_artifacts(second, second_dir, schemas_dir=RESEARCH_ROOT / "schemas")
    first_ledger = json.loads((first_dir / "checksums.json").read_text(encoding="utf-8"))
    second_ledger = json.loads((second_dir / "checksums.json").read_text(encoding="utf-8"))
    assert first_ledger == second_ledger
    for record in first_ledger["files"]:
        assert sha256_file(first_dir / record["path"]) == record["sha256"]
        assert sha256_file(second_dir / record["path"]) == record["sha256"]
