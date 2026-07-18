"""Bounded state machine and role capabilities for the two-agent workflow."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Final

from .contracts import ResearchState


class ActorRole(StrEnum):
    RESEARCHER = "QUANT_RESEARCH_AGENT"
    CRITIC = "INDEPENDENT_CRITIC_AGENT"
    GOVERNANCE = "DETERMINISTIC_GOVERNANCE"


class InvalidTransition(ValueError):
    pass


class CapabilityViolation(PermissionError):
    pass


PROTECTED_RESOURCES: Final[frozenset[str]] = frozenset(
    {
        "final_holdout",
        "sealed_holdout_contents",
        "holdout_evaluation",
        "risk_limits",
        "promotion_gates",
        "wallet_permissions",
        "production_deployment",
        "production_theo_provider",
        "champion_registry",
        "terminal_promotion",
    }
)

ROLE_CAPABILITIES: Final[dict[ActorRole, frozenset[str]]] = {
    ActorRole.RESEARCHER: frozenset(
        {
            "propose",
            "validate_spec",
            "train",
            "evaluate_walk_forward",
            "revise_once",
            "write_challenger_artifact",
            "generate_colab_spec",
        }
    ),
    ActorRole.CRITIC: frozenset({"read_experiment", "run_diagnostics", "critic_review", "final_review"}),
    ActorRole.GOVERNANCE: frozenset({"decide_promotion", "register_artifact", "evaluate_sealed_holdout"}),
}

TRANSITIONS: Final[dict[ResearchState, tuple[ResearchState, ActorRole]]] = {
    ResearchState.PROPOSED: (ResearchState.SPEC_VALIDATED, ActorRole.RESEARCHER),
    ResearchState.SPEC_VALIDATED: (ResearchState.TRAINED, ActorRole.RESEARCHER),
    ResearchState.TRAINED: (ResearchState.WALK_FORWARD_EVALUATED, ActorRole.RESEARCHER),
    ResearchState.WALK_FORWARD_EVALUATED: (ResearchState.CRITIC_REVIEWED, ActorRole.CRITIC),
    ResearchState.CRITIC_REVIEWED: (ResearchState.REVISED_ONCE, ActorRole.RESEARCHER),
    ResearchState.REVISED_ONCE: (ResearchState.FINAL_REVIEW, ActorRole.CRITIC),
}

TERMINAL_STATES: Final[frozenset[ResearchState]] = frozenset(
    {
        ResearchState.REJECTED,
        ResearchState.RESEARCH_ONLY,
        ResearchState.PROMOTE_TO_REPLAY,
        ResearchState.PROMOTE_TO_PAPER,
    }
)


@dataclass(frozen=True, slots=True, init=False)
class ResearchStateMachine:
    experiment_id: str
    state: ResearchState
    revisions: int

    def __init__(self, experiment_id: str) -> None:
        object.__setattr__(self, "experiment_id", experiment_id)
        object.__setattr__(self, "state", ResearchState.PROPOSED)
        object.__setattr__(self, "revisions", 0)

    @classmethod
    def _after_validated_transition(
        cls,
        experiment_id: str,
        state: ResearchState,
        revisions: int,
    ) -> ResearchStateMachine:
        machine = object.__new__(cls)
        object.__setattr__(machine, "experiment_id", experiment_id)
        object.__setattr__(machine, "state", state)
        object.__setattr__(machine, "revisions", revisions)
        return machine

    def require_capability(self, actor: ActorRole, capability: str) -> None:
        if capability not in ROLE_CAPABILITIES[actor]:
            raise CapabilityViolation(f"{actor.value} lacks capability {capability}")

    def require_resource_access(self, actor: ActorRole, resource: str) -> None:
        if actor != ActorRole.GOVERNANCE and resource in PROTECTED_RESOURCES:
            raise CapabilityViolation(f"{actor.value} cannot modify {resource}")

    def transition(self, target: ResearchState, actor: ActorRole) -> ResearchStateMachine:
        if self.state in TERMINAL_STATES:
            raise InvalidTransition(f"{self.state.value} is terminal")

        if self.state == ResearchState.FINAL_REVIEW:
            if actor != ActorRole.GOVERNANCE or target not in TERMINAL_STATES:
                raise InvalidTransition("only deterministic governance may make a terminal decision")
            return self._after_validated_transition(self.experiment_id, target, self.revisions)

        expected = TRANSITIONS.get(self.state)
        if expected is None:
            raise InvalidTransition(f"no transition is defined from {self.state.value}")
        expected_target, expected_actor = expected
        if target != expected_target or actor != expected_actor:
            raise InvalidTransition(
                f"{self.state.value} requires {expected_actor.value} -> {expected_target.value}"
            )
        revisions = self.revisions + (1 if target == ResearchState.REVISED_ONCE else 0)
        if revisions > 1:
            raise InvalidTransition("at most one researcher revision is permitted")
        return self._after_validated_transition(self.experiment_id, target, revisions)
