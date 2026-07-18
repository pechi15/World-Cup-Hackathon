"""The two offline agent façades.

Neither façade is imported by, nor has a write path to, the live TheoProvider.
"""

from __future__ import annotations

from .colab import ColabJobSpec, generate_colab_job_spec
from .contracts import ExperimentSpec, Hypothesis
from .critic import IndependentCriticAgent
from .evidence import assert_spec_identity
from .interfaces import ResearcherTools, StructuredModelProvider
from .workflow import ActorRole, PROTECTED_RESOURCES, ResearchStateMachine


class QuantResearchAgent:
    def __init__(
        self,
        tools: ResearcherTools,
        *,
        model_provider: StructuredModelProvider | None = None,
    ) -> None:
        self.tools = tools
        self.model_provider = model_provider

    def draft_hypothesis(self, research_question: str) -> Hypothesis:
        if self.model_provider is None or not self.model_provider.enabled:
            raise RuntimeError("no enabled structured model provider is configured")
        return self.model_provider.generate(
            system_prompt=(
                "You are an offline quantitative researcher. Produce a falsifiable hypothesis, "
                "make no profitability claim, and treat market consensus as a benchmark."
            ),
            user_prompt=research_question,
            response_model=Hypothesis,
            schema_name="QuantHypothesis",
        )

    def validate_spec(self, spec: ExperimentSpec, dataset_id: str) -> tuple[str, ...]:
        reasons: list[str] = []
        try:
            assert_spec_identity(spec)
        except ValueError:
            reasons.append("FEATURE_MANIFEST_HASH_MISMATCH")
        actual_hash = self.tools.datasets.snapshot_hash(dataset_id)
        if actual_hash != spec.data_snapshot_hash:
            reasons.append("DATA_SNAPSHOT_HASH_MISMATCH")
        if not spec.split.fixture_grouped:
            reasons.append("FIXTURE_GROUPING_REQUIRED")
        if not spec.split.chronological:
            reasons.append("CHRONOLOGICAL_SPLIT_REQUIRED")
        for feature in spec.features:
            if not feature.known_at_field:
                reasons.append(f"FEATURE_AVAILABILITY_UNSPECIFIED:{feature.name}")
        return tuple(reasons)

    def colab_job_spec(
        self,
        experiment: ExperimentSpec,
        *,
        notebook_uri: str,
        source_revision: str,
        dataset_uri: str,
        output_uri: str,
    ) -> ColabJobSpec:
        return generate_colab_job_spec(
            experiment,
            notebook_uri=notebook_uri,
            source_revision=source_revision,
            dataset_uri=dataset_uri,
            output_uri=output_uri,
        )

    @staticmethod
    def assert_no_protected_write(resource: str) -> None:
        machine = ResearchStateMachine("capability-check")
        machine.require_resource_access(ActorRole.RESEARCHER, resource)

    @staticmethod
    def protected_resources() -> frozenset[str]:
        return PROTECTED_RESOURCES


__all__ = ["IndependentCriticAgent", "QuantResearchAgent"]
