import pytest

from core.exceptions import StateTransitionError
from core.state_machine import RunStatus, WorkflowStateMachine


def test_valid_transitions():
    sm = WorkflowStateMachine()
    assert sm.can_transition(RunStatus.IDLE, RunStatus.RECORDING)
    assert sm.can_transition(RunStatus.RECORDING, RunStatus.VALIDATED)
    assert sm.can_transition(RunStatus.VALIDATED, RunStatus.QUEUED)
    assert sm.can_transition(RunStatus.QUEUED, RunStatus.RUNNING)
    assert sm.can_transition(RunStatus.RUNNING, RunStatus.COMPLETED)
    assert sm.can_transition(RunStatus.RUNNING, RunStatus.FAILED)
    assert sm.can_transition(RunStatus.RUNNING, RunStatus.WAITING_FOR_USER)
    assert sm.can_transition(RunStatus.WAITING_FOR_USER, RunStatus.RUNNING)
    assert sm.can_transition(RunStatus.RECOVERING, RunStatus.RUNNING)


def test_terminal_states():
    sm = WorkflowStateMachine()
    assert not sm.can_transition(RunStatus.FAILED, RunStatus.RUNNING)
    assert not sm.can_transition(RunStatus.COMPLETED, RunStatus.RUNNING)
    assert not sm.can_transition(RunStatus.CANCELED, RunStatus.RUNNING)
    assert not sm.can_transition(RunStatus.FAILED, RunStatus.WAITING_FOR_USER)
    assert not sm.can_transition(RunStatus.COMPLETED, RunStatus.RECORDING)


def test_illegal_transitions():
    sm = WorkflowStateMachine()
    assert not sm.can_transition(RunStatus.IDLE, RunStatus.RUNNING)
    assert not sm.can_transition(RunStatus.RECORDING, RunStatus.RUNNING)
    assert not sm.can_transition(RunStatus.RUNNING, RunStatus.IDLE)
    assert not sm.can_transition(RunStatus.RUNNING, RunStatus.RECORDING)
    assert not sm.can_transition(RunStatus.WAITING_FOR_USER, RunStatus.QUEUED)


def test_transition_raises_on_illegal():
    sm = WorkflowStateMachine()
    with pytest.raises(StateTransitionError):
        sm.transition(RunStatus.IDLE, RunStatus.RUNNING)


def test_transition_returns_target_on_valid():
    sm = WorkflowStateMachine()
    result = sm.transition(RunStatus.IDLE, RunStatus.RECORDING)
    assert result == RunStatus.RECORDING


def test_all_terminal_states_have_no_transitions():
    for status in [RunStatus.FAILED, RunStatus.COMPLETED, RunStatus.CANCELED]:
        for target in RunStatus:
            if target != status:
                assert not WorkflowStateMachine.can_transition(status, target), (
                    f"{status.value} should not transition to {target.value}"
                )


def test_all_running_states_can_reach_cancel():
    cancellable_from = {
        RunStatus.IDLE, RunStatus.QUEUED, RunStatus.RUNNING,
        RunStatus.WAITING_FOR_USER, RunStatus.RECOVERING,
    }
    for status in cancellable_from:
        assert WorkflowStateMachine.can_transition(status, RunStatus.CANCELED), (
            f"{status.value} should be able to cancel"
        )
