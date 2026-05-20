from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


# Workstream E: the decision verb on the wire. Ten string literals; the
# extension dispatcher in service-worker.ts switches on these strings
# literally — they must stay in sync.
DecisionValue = Literal[
    "EXECUTE",
    "SKIP",
    "RETRY",
    "HEAL",
    "ADAPT",
    "WAIT",
    "RESTART",
    "ROLLBACK",
    "PAUSE",
    "COMPLETED",
]


class CommandAction(str, Enum):
    NAVIGATE = "navigate"
    CLICK = "click"
    TYPE = "type"
    SELECT = "select"
    SCROLL = "scroll"
    EXTRACT = "extract"
    RUN_SCRIPT = "run_script"


class ChallengeType(str, Enum):
    CAPTCHA = "captcha"
    LOGIN_FORM = "login_form"
    TWO_FACTOR = "two_factor"
    UNEXPECTED_MODAL = "unexpected_modal"
    CONSENT_BANNER = "consent_banner"


class PageContext(BaseModel):
    url: str
    title: str
    dom_snippet: str = ""
    accessibility_tree: str = ""
    visible_text: str = ""
    visible_elements: list[dict[str, Any]] = Field(default_factory=list)
    is_blocking: bool = False
    blocking_type: ChallengeType | None = None
    page_unchanged: bool = False
    # Phase 2: per-poll delta computed by the extension's service worker.
    # Tells the agent "what changed since the last poll" so it can distinguish
    # navigation in progress vs. unexpected state vs. nothing happened.
    page_diff: dict[str, Any] | None = None


class CommandPreCondition(BaseModel):
    condition_type: Literal[
        "element_visible", "url_matches", "text_present", "page_loaded"
    ]
    selector: str | None = None
    pattern: str | None = None
    timeout_ms: int = 2000


class AgentCommand(BaseModel):
    action: CommandAction
    target: str | None = None
    value: str | None = None
    selector_chain: list[dict[str, Any]] = Field(default_factory=list)
    intent: str | None = None
    methods: list[dict[str, Any]] = Field(default_factory=list)
    timeout_ms: int = 15000
    success_condition: dict[str, Any] | None = None
    pre_condition: CommandPreCondition | None = None
    script: str | None = None
    script_args: dict[str, Any] = Field(default_factory=dict)
    script_timeout_ms: int = 5000
    delay_before_ms: int = 0


class PlanUpdateOperation(str, Enum):
    INSERT = "INSERT"
    ADD = "ADD"
    REMOVE = "REMOVE"
    MODIFY = "MODIFY"
    REORDER = "REORDER"
    SIMPLIFY = "SIMPLIFY"


class PlanUpdate(BaseModel):
    operation: PlanUpdateOperation
    step_index: int
    new_step: dict[str, Any] | None = None
    reason: str = ""


class AgentDecision(BaseModel):
    decision: DecisionValue
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str = ""
    command: AgentCommand | None = None
    plan_updates: list[PlanUpdate] = Field(default_factory=list)
    pause_reason: str | None = None
    wait_ms: int | None = None
    rollback_to: int | None = None
    requires_human: bool = False


class PollRequest(BaseModel):
    page_context: PageContext
    current_step_index: int | None = None
    screenshot_b64: str | None = None
    screenshot_mime: str = "image/jpeg"
    screenshot_trigger: str | None = None


class PollResponse(BaseModel):
    decision: DecisionValue
    confidence: float
    reasoning: str
    command: AgentCommand | None = None
    next_step_index: int | None = None
    pause_reason: str | None = None
    wait_ms: int | None = None
    rollback_to: int | None = None
    requires_human: bool = False
    plan_updates: list[PlanUpdate] = Field(default_factory=list)
    vision_policy: Literal["auto", "always", "never"] | None = None


class ResultRequest(BaseModel):
    step_index: int
    success: bool
    error: str | None = None
    page_context_after: PageContext | None = None
    error_context: str | None = None
    # Index into the step's `methods` array, set by the executor when the
    # primary selector chain failed and a fallback method recovered the step.
    # None when the primary chain succeeded.
    via_method_index: int | None = None
    script_result: Any | None = None
    script_logs: list[str] = Field(default_factory=list)
    script_duration_ms: int | None = None


class ResultResponse(BaseModel):
    accepted: bool
    decision: DecisionValue | None = None
    next_step_index: int | None = None
    ai_analysis: dict[str, Any] | None = None
    should_poll: bool = False
    plan_updates: list[PlanUpdate] = Field(default_factory=list)


class DashboardAction(BaseModel):
    action: Literal["continue", "cancel", "retry"]


class DashboardActionResponse(BaseModel):
    accepted: bool
    pending_action: str | None = None


SAFETY_LIMITS = {
    "max_retries_per_step": 3,
    "max_heal_attempts_per_step": 2,
    # Adapt budget is the AI's discretion budget. With AI-first decision making
    # this can be generous — long workflows often need 10+ adaptations.
    "max_adapt_per_run": 25,
    "max_plan_updates_per_run": 15,
    "max_consecutive_waits_per_step": 4,
    "max_total_waits_per_run": 20,
    "wait_min_ms": 500,
    "wait_max_ms": 5000,
    "max_restarts_per_run": 2,
    "max_rollbacks_per_run": 3,
    "max_ai_attempts_per_poll": 3,
    "max_consecutive_failures": 5,
    "max_ai_unusable_output_wait_cycles": 4,
    "max_loop_iterations": 200,
    "max_dom_snippet_bytes": 8192,
    "max_visible_text_bytes": 2048,
    "max_visible_elements": 30,
    "max_run_duration_seconds": 1800,
    "max_tokens_per_run": 200000,
    "stale_poll_timeout_seconds": 300,
    "max_run_script_per_run": 30,
    "max_script_no_target_repeats": 2,
}
