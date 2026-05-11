from __future__ import annotations

from enum import Enum

from core.exceptions import StateTransitionError


class RunStatus(str, Enum):
    IDLE = "idle"
    RECORDING = "recording"
    VALIDATED = "validated"
    QUEUED = "queued"
    RUNNING = "running"
    WAITING_FOR_USER = "waiting_for_user"
    RECOVERING = "recovering"
    FAILED = "failed"
    COMPLETED = "completed"
    CANCELED = "canceled"


_TRANSITIONS: dict[RunStatus, set[RunStatus]] = {
    RunStatus.IDLE: {RunStatus.RECORDING, RunStatus.QUEUED, RunStatus.CANCELED},
    RunStatus.RECORDING: {RunStatus.VALIDATED, RunStatus.CANCELED},
    RunStatus.VALIDATED: {RunStatus.QUEUED, RunStatus.IDLE},
    RunStatus.QUEUED: {RunStatus.RUNNING, RunStatus.CANCELED},
    RunStatus.RUNNING: {
        RunStatus.WAITING_FOR_USER,
        RunStatus.RECOVERING,
        RunStatus.FAILED,
        RunStatus.COMPLETED,
        RunStatus.CANCELED,
    },
    RunStatus.WAITING_FOR_USER: {
        RunStatus.RUNNING, RunStatus.RECOVERING, RunStatus.CANCELED, RunStatus.FAILED,
    },
    RunStatus.RECOVERING: {
        RunStatus.RUNNING, RunStatus.WAITING_FOR_USER,
        RunStatus.FAILED, RunStatus.CANCELED,
    },
    RunStatus.FAILED: set(),
    RunStatus.COMPLETED: set(),
    RunStatus.CANCELED: set(),
}


class WorkflowStateMachine:
    @staticmethod
    def can_transition(current: RunStatus, target: RunStatus) -> bool:
        return target in _TRANSITIONS.get(current, set())

    @staticmethod
    def transition(current: RunStatus, target: RunStatus) -> RunStatus:
        if not WorkflowStateMachine.can_transition(current, target):
            raise StateTransitionError(
                f"Cannot transition from '{current.value}' to '{target.value}'"
            )
        return target
