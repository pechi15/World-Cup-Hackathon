"""Provider-neutral agent and tool boundaries.

The live TypeScript trading controller does not import this package. These
interfaces are for offline research orchestration only.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol, Sequence, TypeVar

from pydantic import BaseModel

from .contracts import (
    ArtifactManifest,
    BacktestReport,
    CriticReview,
    ExperimentSpec,
    PredictionObservation,
    StressResult,
    ValidationReport,
)


ResponseT = TypeVar("ResponseT", bound=BaseModel)


class StructuredModelProvider(Protocol):
    @property
    def enabled(self) -> bool: ...

    def generate(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        response_model: type[ResponseT],
        schema_name: str,
    ) -> ResponseT: ...


class DatasetReader(Protocol):
    """Read-only, point-in-time data access exposed to the researcher."""

    def snapshot_hash(self, dataset_id: str) -> str: ...

    def observations(self, dataset_id: str) -> Sequence[PredictionObservation]: ...


class TrainingTool(Protocol):
    def train(self, spec: ExperimentSpec, train_ids: Sequence[str]) -> ArtifactManifest: ...


class ValidationTool(Protocol):
    def walk_forward(
        self,
        spec: ExperimentSpec,
        observations: Sequence[PredictionObservation],
    ) -> ValidationReport: ...


class BacktestTool(Protocol):
    def run(self, spec: ExperimentSpec) -> BacktestReport: ...


class ChallengerWriter(Protocol):
    """Write-only challenger storage; it cannot change the production provider."""

    def write_challenger(self, artifact: ArtifactManifest, content: bytes) -> Path: ...


class ResearcherTools(Protocol):
    datasets: DatasetReader
    trainer: TrainingTool
    validator: ValidationTool
    backtester: BacktestTool
    challengers: ChallengerWriter


class ExperimentReader(Protocol):
    def read_spec(self, experiment_id: str) -> ExperimentSpec: ...

    def read_validation(self, experiment_id: str) -> ValidationReport: ...

    def read_backtest(self, experiment_id: str) -> BacktestReport: ...

    def read_stress_results(self, experiment_id: str) -> Sequence[StressResult]: ...


class CriticDiagnostics(Protocol):
    def leakage_audit(self, experiment_id: str) -> tuple[bool, tuple[str, ...]]: ...

    def fixture_dependence_audit(self, experiment_id: str) -> tuple[bool, tuple[str, ...]]: ...

    def claim_implementation_diff(self, experiment_id: str) -> tuple[bool, tuple[str, ...]]: ...


class ReviewWriter(Protocol):
    def append_review(self, review: CriticReview) -> None: ...


class CriticTools(Protocol):
    experiments: ExperimentReader
    diagnostics: CriticDiagnostics
    reviews: ReviewWriter
