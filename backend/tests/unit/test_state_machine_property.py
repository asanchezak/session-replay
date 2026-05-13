"""Property-based test for the run state machine.

We use `hypothesis` to generate random walks through the state graph and assert
that the machine never allows an undeclared transition and never spontaneously
mutates state.
"""
from __future__ import annotations

import pytest

from core.exceptions import StateTransitionError
from core.state_machine import _TRANSITIONS, RunStatus, WorkflowStateMachine

hypothesis = pytest.importorskip("hypothesis")
from hypothesis import given  # noqa: E402
from hypothesis import settings as hyp_settings
from hypothesis import strategies as st


@given(
    walk=st.lists(st.sampled_from(list(RunStatus)), min_size=1, max_size=20),
)
@hyp_settings(max_examples=200, deadline=None)
def test_random_walk_never_takes_undeclared_edge(walk):
    """For any sequence of attempted transitions, illegal ones must raise."""
    current = RunStatus.IDLE
    for target in walk:
        if WorkflowStateMachine.can_transition(current, target):
            current = WorkflowStateMachine.transition(current, target)
            assert current == target
        else:
            with pytest.raises(StateTransitionError):
                WorkflowStateMachine.transition(current, target)


@given(state=st.sampled_from(list(RunStatus)))
def test_can_transition_is_consistent_with_transitions_table(state):
    allowed = _TRANSITIONS.get(state, set())
    for target in RunStatus:
        if target in allowed:
            assert WorkflowStateMachine.can_transition(state, target)
        else:
            assert not WorkflowStateMachine.can_transition(state, target)
