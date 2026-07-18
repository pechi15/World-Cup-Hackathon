"""Deterministic evidence identity and cross-artifact verification."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from datetime import datetime

from .contracts import ArtifactManifest, EvidenceBinding, ExperimentSpec, FeatureDefinition


def feature_manifest_hash(features: Sequence[FeatureDefinition]) -> str:
    payload = [feature.model_dump(mode="json") for feature in sorted(features, key=lambda item: item.name)]
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def binding_for(
    spec: ExperimentSpec,
    *,
    artifact_checksum: str,
    validation_fold: str,
    training_cutoff: datetime | None = None,
) -> EvidenceBinding:
    return EvidenceBinding(
        experiment_id=spec.experiment_id,
        dataset_hash=spec.data_snapshot_hash,
        git_commit=spec.git_commit,
        feature_manifest_hash=spec.feature_manifest_hash,
        training_cutoff=training_cutoff or spec.training_cutoff,
        validation_fold=validation_fold,
        artifact_checksum=artifact_checksum,
    )


def verify_binding(
    binding: EvidenceBinding,
    *,
    spec: ExperimentSpec,
    artifact: ArtifactManifest,
    validation_fold: str | None = None,
    training_cutoff: datetime | None = None,
) -> tuple[str, ...]:
    failures: list[str] = []
    expected = {
        "experiment_id": spec.experiment_id,
        "dataset_hash": spec.data_snapshot_hash,
        "git_commit": spec.git_commit,
        "feature_manifest_hash": spec.feature_manifest_hash,
        "training_cutoff": training_cutoff or spec.training_cutoff,
        "artifact_checksum": artifact.content_hash,
    }
    for field, value in expected.items():
        if getattr(binding, field) != value:
            failures.append(f"EVIDENCE_{field.upper()}_MISMATCH")
    if validation_fold is not None and binding.validation_fold != validation_fold:
        failures.append("EVIDENCE_VALIDATION_FOLD_MISMATCH")
    return tuple(failures)


def assert_spec_identity(spec: ExperimentSpec) -> None:
    calculated = feature_manifest_hash(spec.features)
    if calculated != spec.feature_manifest_hash:
        raise ValueError("feature-manifest hash does not match the declared features")
