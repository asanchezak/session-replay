"""Workstream C: tool definitions for the agent loop.

The agent uses OpenAI function calling to emit structured decisions instead
of free-form JSON. Each "decision verb" from the legacy schema becomes a
distinct tool the model may call; the dispatcher translates the tool call
back into the existing ai_decision dict shape so the surrounding poll()
machinery (audit, plan_updates, recovery state) is unchanged.

The Pydantic models below are the single source of truth. Tool schemas
exported via `ALL_TOOLS` are derived from these models' JSON schemas.

Tools (8):
- execute_action — primary action verb (click/type/navigate/...).
                   Folds the legacy EXECUTE and ADAPT into one tool; the
                   dispatcher chooses ADAPT vs EXECUTE based on whether the
                   model's selectors match the recorded step.
- wait           — defer the current step for `wait_ms` while the page
                   transitions.
- skip_step      — this step is no longer needed.
- restart        — abandon the current path, navigate to a known URL.
- rollback       — return to a recorded checkpoint step.
- pause_for_human — only when no bounded path forward exists.
- mark_complete  — workflow goal satisfied; finish the run.
- update_plan    — mutate the run snapshot (INSERT/REMOVE/MODIFY/REORDER).
                   May be emitted alongside another tool in the same turn;
                   on its own, the inner loop iterates again so the model
                   can pick an action.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


# ---- Tool input models ------------------------------------------------------

class ExecuteActionInput(BaseModel):
    action: Literal[
        "navigate", "click", "type", "select", "scroll", "extract", "run_script",
    ] = Field(..., description="Primitive action to perform on the page.")
    target: str | None = Field(None, description="Optional target hint (URL for navigate, etc.).")
    value: str | None = Field(None, description="Value for type/select; URL for navigate.")
    selector_chain: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Prioritized selectors: list of {type: css|accessibility|text|xpath|anchor, value, score?}.",
    )
    intent: str | None = Field(None, description="What this action accomplishes (one sentence).")
    methods: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Optional fallback methods if the primary selector_chain fails.",
    )
    timeout_ms: int = Field(15000, ge=100, le=60_000)
    # Workstream A: run_script primitives.
    script: str | None = Field(None, description="When action=run_script: function body returning JSON.")
    script_args: dict[str, Any] = Field(default_factory=dict, description="Bound as `args` inside the script.")
    script_timeout_ms: int = Field(5000, ge=100, le=15_000)
    delay_before_ms: int = Field(
        0, ge=0, le=10_000,
        description=(
            "Milliseconds to wait before executing. Use when the recording shows a pause "
            "before this step, or the page needs time to settle after a prior action."
        ),
    )
    # Decision metadata
    confidence: float = Field(0.7, ge=0.0, le=1.0)
    reasoning: str = Field("", description="Brief explanation (one sentence).")


class WaitInput(BaseModel):
    wait_ms: int = Field(..., ge=500, le=5000, description="Sleep duration in ms.")
    reason: str = Field("page transitional", description="Why a wait is appropriate now.")
    expected_signal: str | None = Field(None, description="What you expect to see after the wait.")
    confidence: float = Field(0.5, ge=0.0, le=1.0)


class SkipStepInput(BaseModel):
    reason: str = Field(..., description="Why the recorded step is unnecessary on this page.")
    confidence: float = Field(0.7, ge=0.0, le=1.0)


class RestartInput(BaseModel):
    target_url: str = Field(..., description="URL to navigate back to before resuming.")
    reason: str = Field(..., description="Why restart is the right call.")
    confidence: float = Field(0.7, ge=0.0, le=1.0)


class RollbackInput(BaseModel):
    checkpoint_step_index: int = Field(..., ge=0, description="Step to roll back to.")
    checkpoint_url: str | None = Field(None, description="Optional URL associated with the checkpoint.")
    reason: str = Field(..., description="Why rollback is the right call.")
    confidence: float = Field(0.7, ge=0.0, le=1.0)


class PauseForHumanInput(BaseModel):
    pause_reason: str = Field(..., description="What the human needs to resolve.")
    requires_human: bool = Field(True, description="True for blocking conditions (captcha, login).")
    confidence: float = Field(0.5, ge=0.0, le=1.0)


class MarkCompleteInput(BaseModel):
    reason: str = Field(..., description="Why the workflow goal is satisfied.")
    confidence: float = Field(0.9, ge=0.0, le=1.0)


class PlanOperation(BaseModel):
    operation: Literal["INSERT", "REMOVE", "MODIFY", "REORDER", "SIMPLIFY"] = Field(...)
    step_index: int = Field(..., ge=0)
    new_step: dict[str, Any] | None = Field(None)
    reason: str = Field("")


class UpdatePlanInput(BaseModel):
    operations: list[PlanOperation] = Field(..., min_length=1, max_length=15)
    reasoning: str = Field("", description="Why the plan needs to change.")


# ---- Tool schema construction -----------------------------------------------

def _to_openai_tool(name: str, description: str, model: type[BaseModel]) -> dict[str, Any]:
    """Render a Pydantic model as an OpenAI function-calling tool schema.

    OpenAI's tool schema is `{type: 'function', function: {name, description,
    parameters}}` where `parameters` is a JSON schema. Pydantic's
    .model_json_schema() emits a draft-2020 JSON schema; we adapt it minimally
    (strip the auto-added 'title', un-inline $defs).
    """
    schema = model.model_json_schema()
    # OpenAI rejects $defs at the top level; flatten by inlining.
    defs = schema.pop("$defs", None) or schema.pop("definitions", None)
    if defs:
        def _inline(node: Any) -> Any:
            if isinstance(node, dict):
                ref = node.get("$ref")
                if isinstance(ref, str) and ref.startswith("#/$defs/"):
                    return _inline(defs.get(ref.split("/")[-1], {}))
                return {k: _inline(v) for k, v in node.items()}
            if isinstance(node, list):
                return [_inline(item) for item in node]
            return node
        schema = _inline(schema)
    schema.pop("title", None)
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": schema,
        },
    }


EXECUTE_ACTION_TOOL = _to_openai_tool(
    "execute_action",
    "Perform a primitive action on the page (click/type/navigate/scroll/select/extract/run_script). "
    "Use this for both the recorded step ('execute') and a fresh adapted approach ('adapt'); "
    "the dispatcher decides which based on whether your selectors match the recorded ones.",
    ExecuteActionInput,
)

WAIT_TOOL = _to_openai_tool(
    "wait",
    "Defer the current step for 500-5000ms because the page is transitional or still loading. "
    "Prefer wait over pause_for_human when the page looks mid-load.",
    WaitInput,
)

SKIP_STEP_TOOL = _to_openai_tool(
    "skip_step",
    "Skip the recorded step — it is unnecessary on the current page (already done, no longer applies).",
    SkipStepInput,
)

RESTART_TOOL = _to_openai_tool(
    "restart",
    "Abandon the current path, navigate to a known target URL, and resume from step 0.",
    RestartInput,
)

ROLLBACK_TOOL = _to_openai_tool(
    "rollback",
    "Return to a recorded checkpoint step and continue from there. Only valid when checkpoints exist.",
    RollbackInput,
)

PAUSE_FOR_HUMAN_TOOL = _to_openai_tool(
    "pause_for_human",
    "Pause the workflow because no bounded path forward exists or the page truly requires a human "
    "(captcha, login, ambiguous state). Use sparingly.",
    PauseForHumanInput,
)

MARK_COMPLETE_TOOL = _to_openai_tool(
    "mark_complete",
    "Declare the workflow goal satisfied. The run ends after this tool succeeds.",
    MarkCompleteInput,
)

UPDATE_PLAN_TOOL = _to_openai_tool(
    "update_plan",
    "Mutate the run's step plan (INSERT/REMOVE/MODIFY/REORDER/SIMPLIFY). May be emitted alongside "
    "another tool in the same turn. Plan changes apply BEFORE the sibling tool's effect.",
    UpdatePlanInput,
)


ALL_TOOLS: list[dict[str, Any]] = [
    EXECUTE_ACTION_TOOL,
    WAIT_TOOL,
    SKIP_STEP_TOOL,
    RESTART_TOOL,
    ROLLBACK_TOOL,
    PAUSE_FOR_HUMAN_TOOL,
    MARK_COMPLETE_TOOL,
    UPDATE_PLAN_TOOL,
]


TOOL_INPUT_MODELS: dict[str, type[BaseModel]] = {
    "execute_action": ExecuteActionInput,
    "wait": WaitInput,
    "skip_step": SkipStepInput,
    "restart": RestartInput,
    "rollback": RollbackInput,
    "pause_for_human": PauseForHumanInput,
    "mark_complete": MarkCompleteInput,
    "update_plan": UpdatePlanInput,
}
