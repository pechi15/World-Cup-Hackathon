"""Pure job-spec generation for manually submitted Google Colab research jobs."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime

from pydantic import Field, model_validator

from .contracts import Contract, ExperimentSpec, utc_now


class ColabResourceSpec(Contract):
    accelerator: str = Field(pattern="^(CPU|T4|L4|A100)$")
    max_runtime_minutes: int = Field(ge=1, le=720)
    internet_access: bool = False


class ColabJobSpec(Contract):
    job_id: str
    experiment_id: str
    created_at: datetime
    notebook_uri: str
    source_revision: str
    dataset_uri: str
    dataset_snapshot_hash: str
    output_uri: str
    command: tuple[str, ...]
    environment: tuple[tuple[str, str], ...]
    resources: ColabResourceSpec
    spec_hash: str

    @model_validator(mode="after")
    def contains_no_secrets_or_production_target(self) -> ColabJobSpec:
        forbidden = ("KEY", "TOKEN", "SECRET", "PASSWORD", "WALLET")
        if any(fragment in key.upper() for key, _ in self.environment for fragment in forbidden):
            raise ValueError("Colab spec must not embed secret-bearing environment variables")
        if "production" in self.output_uri.lower() or "theoprovider" in self.output_uri.lower():
            raise ValueError("Colab output must target isolated challenger storage")
        return self


def generate_colab_job_spec(
    experiment: ExperimentSpec,
    *,
    notebook_uri: str,
    source_revision: str,
    dataset_uri: str,
    output_uri: str,
    resources: ColabResourceSpec | None = None,
    created_at: datetime | None = None,
) -> ColabJobSpec:
    if not output_uri.rstrip("/").endswith("challengers"):
        raise ValueError("Colab output_uri must end in /challengers")
    timestamp = created_at or utc_now()
    command = (
        "python",
        "-m",
        "quant_research.worker",
        "--experiment-id",
        experiment.experiment_id,
        "--seed",
        str(experiment.random_seed),
    )
    environment = (
        ("DATA_MODE", experiment.data_mode.value),
        ("RESEARCH_ONLY", "1"),
        ("DISABLE_PRODUCTION_DEPLOYMENT", "1"),
    )
    resource_spec = resources or ColabResourceSpec(accelerator="CPU", max_runtime_minutes=60)
    body = {
        "experiment_id": experiment.experiment_id,
        "notebook_uri": notebook_uri,
        "source_revision": source_revision,
        "dataset_uri": dataset_uri,
        "dataset_snapshot_hash": experiment.data_snapshot_hash,
        "output_uri": output_uri,
        "command": command,
        "environment": environment,
        "resources": resource_spec.model_dump(),
    }
    spec_hash = hashlib.sha256(
        json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return ColabJobSpec(
        job_id=f"colab-{experiment.experiment_id}-{spec_hash[:12]}",
        experiment_id=experiment.experiment_id,
        created_at=timestamp,
        notebook_uri=notebook_uri,
        source_revision=source_revision,
        dataset_uri=dataset_uri,
        dataset_snapshot_hash=experiment.data_snapshot_hash,
        output_uri=output_uri,
        command=command,
        environment=environment,
        resources=resource_spec,
        spec_hash=spec_hash,
    )
