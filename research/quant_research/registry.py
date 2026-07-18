"""Append-only experiment ledger and champion/challenger artifact registry."""

from __future__ import annotations

import hashlib
import json
import threading
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from .contracts import (
    ArtifactManifest,
    ArtifactRegistration,
    ArtifactRole,
    BacktestReport,
    HoldoutEvaluation,
    CriticReview,
    DataMode,
    ExperimentSpec,
    EvidenceBinding,
    PromotionDecision,
    PromotionTarget,
    RegistryEvent,
    ResearchState,
    StressResult,
    ValidationReport,
    utc_now,
)


GENESIS_HASH = "0" * 64
REQUIRED_LIFECYCLE_EVENTS = frozenset(
    {
        "EXPERIMENT_PROPOSED",
        "SPEC_VALIDATED",
        "CHALLENGER_TRAINED",
        "WALK_FORWARD_EVALUATED",
        "CRITIC_REVIEW",
        "BOUNDED_REVISION",
        "FINAL_CRITIC_REVIEW",
        "PROMOTION_DECISION",
    }
)
EXPECTED_LIFECYCLE = (
    ("EXPERIMENT_PROPOSED", ResearchState.PROPOSED, "QUANT_RESEARCH_AGENT"),
    ("SPEC_VALIDATED", ResearchState.SPEC_VALIDATED, "QUANT_RESEARCH_AGENT"),
    ("CHALLENGER_TRAINED", ResearchState.TRAINED, "QUANT_RESEARCH_AGENT"),
    ("WALK_FORWARD_EVALUATED", ResearchState.WALK_FORWARD_EVALUATED, "QUANT_RESEARCH_AGENT"),
    ("CRITIC_REVIEW", ResearchState.CRITIC_REVIEWED, "INDEPENDENT_CRITIC_AGENT"),
    ("BOUNDED_REVISION", ResearchState.REVISED_ONCE, "QUANT_RESEARCH_AGENT"),
    ("FINAL_CRITIC_REVIEW", ResearchState.FINAL_REVIEW, "INDEPENDENT_CRITIC_AGENT"),
    ("PROMOTION_DECISION", None, "DETERMINISTIC_GOVERNANCE"),
)


def canonical_json(value: Any) -> str:
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=_json_default)


def _json_default(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(f"cannot serialize {type(value)!r}")


class ExperimentRegistry:
    """Hash-chained JSONL ledger; every lifecycle artifact is an event payload."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def events(self, experiment_id: str | None = None) -> tuple[RegistryEvent, ...]:
        if not self.path.exists():
            return ()
        parsed = tuple(
            RegistryEvent.model_validate_json(line)
            for line in self.path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        )
        self._verify_chain(parsed)
        if experiment_id is None:
            return parsed
        return tuple(event for event in parsed if event.experiment_id == experiment_id)

    def append(
        self,
        *,
        experiment_id: str,
        event_type: str,
        state: ResearchState,
        actor: str,
        binding: EvidenceBinding,
        payload: BaseModel | dict[str, Any],
        occurred_at: datetime | None = None,
    ) -> RegistryEvent:
        with self._lock:
            if binding.experiment_id != experiment_id:
                raise ValueError("registry event binding experiment mismatch")
            if event_type == "EXPERIMENT_PROPOSED":
                if not isinstance(payload, ExperimentSpec):
                    raise ValueError("EXPERIMENT_PROPOSED must store the immutable experiment spec")
                expected_identity = (
                    payload.experiment_id,
                    payload.data_snapshot_hash,
                    payload.git_commit,
                    payload.feature_manifest_hash,
                    payload.training_cutoff,
                )
                actual_identity = (
                    binding.experiment_id,
                    binding.dataset_hash,
                    binding.git_commit,
                    binding.feature_manifest_hash,
                    binding.training_cutoff,
                )
                if actual_identity != expected_identity:
                    raise ValueError("proposed experiment binding does not match its immutable spec")
            if isinstance(payload, ArtifactManifest) and payload.binding != binding.model_copy(
                update={"validation_fold": payload.binding.validation_fold}
            ):
                raise ValueError("artifact registry event binding does not match the artifact")
            existing = self.events()
            experiment_events = tuple(
                event for event in existing if event.experiment_id == experiment_id
            )
            if experiment_events:
                original = experiment_events[0].binding
                for field in (
                    "experiment_id",
                    "dataset_hash",
                    "git_commit",
                    "feature_manifest_hash",
                    "training_cutoff",
                    "artifact_checksum",
                ):
                    if getattr(binding, field) != getattr(original, field):
                        raise ValueError(f"immutable experiment identity mismatch: {field}")
            if event_type == "EXPERIMENT_PROPOSED" and experiment_events:
                raise ValueError(f"experiment ID {experiment_id} is immutable and already registered")
            if not experiment_events and event_type != "EXPERIMENT_PROPOSED":
                raise ValueError("experiment must begin with EXPERIMENT_PROPOSED")
            if experiment_events:
                if any(event.event_type == event_type for event in experiment_events):
                    raise ValueError(f"duplicate lifecycle event {event_type} cannot overwrite history")
                expected_index = len(experiment_events)
                if expected_index >= len(EXPECTED_LIFECYCLE):
                    raise ValueError("terminal experiment cannot accept additional events")
                expected_type, expected_state, expected_actor = EXPECTED_LIFECYCLE[expected_index]
                if (
                    event_type != expected_type
                    or (expected_state is not None and state != expected_state)
                    or actor != expected_actor
                ):
                    raise ValueError("experiment registry lifecycle order, state, or actor is invalid")
            else:
                expected_type, expected_state, expected_actor = EXPECTED_LIFECYCLE[0]
                if event_type != expected_type or state != expected_state or actor != expected_actor:
                    raise ValueError("experiment registry must begin with the governed proposed event")
            previous_hash = existing[-1].event_hash if existing else GENESIS_HASH
            payload_dict = payload.model_dump(mode="json") if isinstance(payload, BaseModel) else payload
            draft = RegistryEvent(
                sequence=len(existing) + 1,
                experiment_id=experiment_id,
                event_type=event_type,
                state=state,
                occurred_at=occurred_at or utc_now(),
                actor=actor,
                binding=binding,
                payload=payload_dict,
                previous_hash=previous_hash,
                event_hash=GENESIS_HASH,
            )
            body = draft.model_dump(mode="json", exclude={"event_hash"})
            event_hash = hashlib.sha256(canonical_json(body).encode()).hexdigest()
            event = draft.model_copy(update={"event_hash": event_hash})
            with self.path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(event.model_dump_json() + "\n")
            return event

    def assert_complete(self, experiment_id: str) -> tuple[RegistryEvent, ...]:
        events = self.events(experiment_id)
        if len(events) != len(EXPECTED_LIFECYCLE):
            raise ValueError("experiment registry is incomplete or duplicated")
        for event, (event_type, state, actor) in zip(events, EXPECTED_LIFECYCLE, strict=True):
            if event.event_type != event_type or (state is not None and event.state != state) or event.actor != actor:
                raise ValueError("experiment registry lifecycle order, state, or actor is invalid")
        if events[-1].state not in (
            ResearchState.REJECTED,
            ResearchState.RESEARCH_ONLY,
            ResearchState.PROMOTE_TO_REPLAY,
            ResearchState.PROMOTE_TO_PAPER,
        ):
            raise ValueError("complete experiment registry must end in a terminal state")
        return events

    @staticmethod
    def _verify_chain(events: Iterable[RegistryEvent]) -> None:
        previous = GENESIS_HASH
        expected_sequence = 1
        for event in events:
            if event.sequence != expected_sequence or event.previous_hash != previous:
                raise ValueError("experiment registry chain is discontinuous")
            body = event.model_dump(mode="json", exclude={"event_hash"})
            expected_hash = hashlib.sha256(canonical_json(body).encode()).hexdigest()
            if event.event_hash != expected_hash:
                raise ValueError(f"experiment registry event {event.sequence} was modified")
            previous = event.event_hash
            expected_sequence += 1


class ArtifactRegistry:
    """Immutable artifact registrations with one current champion per model family."""

    def __init__(self, path: Path, *, expected_schema_version: str = "RESEARCH_ARTIFACT/1") -> None:
        self.path = path
        self.expected_schema_version = expected_schema_version
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def registrations(self) -> tuple[ArtifactRegistration, ...]:
        if not self.path.exists():
            return ()
        registrations = tuple(
            ArtifactRegistration.model_validate_json(line)
            for line in self.path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        )
        previous = GENESIS_HASH
        for registration in registrations:
            if registration.previous_hash != previous:
                raise ValueError("artifact registry chain is discontinuous")
            body = registration.model_dump(mode="json", exclude={"registration_hash"})
            expected = hashlib.sha256(canonical_json(body).encode()).hexdigest()
            if registration.registration_hash != expected:
                raise ValueError(f"artifact registration {registration.registration_id} was modified")
            previous = registration.registration_hash
        return registrations

    def register_challenger(
        self,
        artifact: ArtifactManifest,
        content: bytes,
    ) -> ArtifactRegistration:
        actual_checksum = hashlib.sha256(content).hexdigest()
        if actual_checksum != artifact.content_hash:
            raise ValueError("artifact checksum mismatch")
        if artifact.schema_version != self.expected_schema_version:
            raise ValueError("artifact schema is incompatible with this registry")
        if artifact.calibration.sample_size < 1:
            raise ValueError("artifact calibration metadata is missing")
        return self._append(
            artifact=artifact,
            role=ArtifactRole.CHALLENGER,
            replaced_artifact_id=None,
            promotion_decision_hash=None,
        )

    def promote_champion(
        self,
        artifact: ArtifactManifest,
        decision: PromotionDecision,
        *,
        spec: ExperimentSpec | None = None,
        validation: ValidationReport | None = None,
        final_review: CriticReview | None = None,
        backtest: BacktestReport | None = None,
        stress_results: tuple[StressResult, ...] = (),
        holdout_evaluation: HoldoutEvaluation | None = None,
    ) -> ArtifactRegistration:
        if artifact.experiment_id != decision.experiment_id:
            raise ValueError("artifact and decision experiment IDs differ")
        if decision.target not in (PromotionTarget.PROMOTE_TO_REPLAY, PromotionTarget.PROMOTE_TO_PAPER):
            raise ValueError("rejected artifacts cannot become champions")
        challenger = next(
            (
                registration
                for registration in self.registrations()
                if registration.role == ArtifactRole.CHALLENGER
                and registration.artifact.artifact_id == artifact.artifact_id
                and registration.artifact == artifact
            ),
            None,
        )
        if challenger is None:
            raise ValueError("artifact must be registered as the identical challenger before promotion")
        if not (
            challenger.checksum_verified
            and challenger.schema_verified
            and challenger.calibration_verified
        ):
            raise ValueError("champion must reference a verified registered artifact")
        if (
            decision.target == PromotionTarget.PROMOTE_TO_PAPER
            and artifact.data_mode == DataMode.SYNTHETIC_TEST
        ):
            raise ValueError("synthetic artifacts cannot be promoted to paper")
        if spec is None or validation is None or final_review is None or backtest is None:
            raise ValueError("complete deterministic gate evidence is required for champion promotion")
        from .promotion import DeterministicPromotionGate

        if not DeterministicPromotionGate().verify(
            decision,
            spec=spec,
            artifact=artifact,
            validation=validation,
            final_review=final_review,
            backtest=backtest,
            stress_results=stress_results,
            holdout_evaluation=holdout_evaluation,
        ):
            raise ValueError("promotion decision does not verify against deterministic gate evidence")
        current = self.champion(artifact.model_family)
        registration = self._append(
            artifact=artifact,
            role=ArtifactRole.CHAMPION,
            replaced_artifact_id=current.artifact.artifact_id if current else None,
            promotion_decision_hash=decision.decision_hash,
        )
        if current:
            self._append(
                artifact=current.artifact,
                role=ArtifactRole.ARCHIVED,
                replaced_artifact_id=artifact.artifact_id,
                promotion_decision_hash=decision.decision_hash,
            )
        return registration

    def champion(self, model_family: str) -> ArtifactRegistration | None:
        current: ArtifactRegistration | None = None
        for registration in self.registrations():
            if registration.artifact.model_family != model_family:
                continue
            if registration.role == ArtifactRole.CHAMPION:
                current = registration
            elif (
                registration.role == ArtifactRole.ARCHIVED
                and current
                and registration.artifact.artifact_id == current.artifact.artifact_id
            ):
                current = None
        return current

    def _append(
        self,
        *,
        artifact: ArtifactManifest,
        role: ArtifactRole,
        replaced_artifact_id: str | None,
        promotion_decision_hash: str | None,
    ) -> ArtifactRegistration:
        with self._lock:
            existing = self.registrations()
            if any(
                row.artifact.artifact_id == artifact.artifact_id and row.role == role
                for row in existing
            ):
                raise ValueError(f"artifact {artifact.artifact_id} is already registered as {role.value}")
            registered_at = utc_now()
            digest = hashlib.sha256(
                f"{artifact.artifact_id}:{role.value}:{registered_at.isoformat()}".encode()
            ).hexdigest()[:20]
            previous_hash = existing[-1].registration_hash if existing else GENESIS_HASH
            draft = ArtifactRegistration(
                registration_id=f"reg-{digest}",
                artifact=artifact,
                role=role,
                registered_at=registered_at,
                replaced_artifact_id=replaced_artifact_id,
                promotion_decision_hash=promotion_decision_hash,
            checksum_verified=True,
            schema_verified=artifact.schema_version == self.expected_schema_version,
            calibration_verified=artifact.calibration.sample_size > 0,
                previous_hash=previous_hash,
                registration_hash=GENESIS_HASH,
            )
            body = draft.model_dump(mode="json", exclude={"registration_hash"})
            registration = draft.model_copy(
                update={"registration_hash": hashlib.sha256(canonical_json(body).encode()).hexdigest()}
            )
            with self.path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(registration.model_dump_json() + "\n")
            return registration
