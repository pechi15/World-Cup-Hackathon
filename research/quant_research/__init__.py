"""Offline quantitative research and independent governance framework."""

from .agents import IndependentCriticAgent, QuantResearchAgent
from .backtest import evaluate_markouts, latency_aware_backtest, run_stress_suite
from .colab import ColabJobSpec, ColabResourceSpec, generate_colab_job_spec
from .contracts import *  # noqa: F403
from .promotion import DeterministicPromotionGate, PromotionGateConfig
from .providers import PerplexityAgentProvider
from .registry import ArtifactRegistry, ExperimentRegistry
from .validation import (
    evaluate_calibration,
    fixture_grouped_purged_walk_forward,
    seal_chronological_holdout,
    walk_forward_validation,
)
from .workflow import ActorRole, ResearchStateMachine

__all__ = [
    "ActorRole",
    "ArtifactRegistry",
    "ColabJobSpec",
    "ColabResourceSpec",
    "DeterministicPromotionGate",
    "ExperimentRegistry",
    "IndependentCriticAgent",
    "PerplexityAgentProvider",
    "PromotionGateConfig",
    "QuantResearchAgent",
    "ResearchStateMachine",
    "evaluate_calibration",
    "evaluate_markouts",
    "fixture_grouped_purged_walk_forward",
    "generate_colab_job_spec",
    "latency_aware_backtest",
    "run_stress_suite",
    "seal_chronological_holdout",
    "walk_forward_validation",
]
