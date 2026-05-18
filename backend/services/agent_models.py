from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


class DecisionType(str, Enum):
    EXECUTE = "EXECUTE"
    SKIP = "SKIP"
    RETRY = "RETRY"
    HEAL = "HEAL"
    ADAPT = "ADAPT"
    WAIT = "WAIT"
    RESTART = "RESTART"
    ROLLBACK = "ROLLBACK"
    PAUSE = "PAUSE"
    COMPLETED = "COMPLETED"


class CommandAction(str, Enum):
    NAVIGATE = "navigate"
    CLICK = "click"
    TYPE = "type"
    SELECT = "select"
    SCROLL = "scroll"
    EXTRACT = "extract"


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


class PlanUpdateOperation(str, Enum):
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
    decision: DecisionType
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


class PollResponse(BaseModel):
    decision: DecisionType
    confidence: float
    reasoning: str
    command: AgentCommand | None = None
    next_step_index: int | None = None
    pause_reason: str | None = None
    wait_ms: int | None = None
    rollback_to: int | None = None
    requires_human: bool = False
    plan_updates: list[PlanUpdate] = Field(default_factory=list)


class ResultRequest(BaseModel):
    step_index: int
    success: bool
    error: str | None = None
    page_context_after: PageContext | None = None
    error_context: str | None = None


class ResultResponse(BaseModel):
    accepted: bool
    decision: DecisionType | None = None
    next_step_index: int | None = None
    ai_analysis: dict[str, Any] | None = None
    should_poll: bool = False
    plan_updates: list[PlanUpdate] = Field(default_factory=list)


class DashboardAction(BaseModel):
    action: Literal["continue", "cancel", "retry"]


class DashboardActionResponse(BaseModel):
    accepted: bool
    pending_action: str | None = None


CONFIDENCE_THRESHOLDS: dict[DecisionType, float] = {
    DecisionType.EXECUTE: 0.70,
    DecisionType.SKIP: 0.80,
    DecisionType.RETRY: 0.60,
    DecisionType.HEAL: 0.85,
    DecisionType.ADAPT: 0.90,
    DecisionType.WAIT: 0.40,
    DecisionType.RESTART: 0.70,
    DecisionType.ROLLBACK: 0.70,
    DecisionType.PAUSE: 0.50,
}

CONFIDENCE_DOWNGRADE_CHAIN: list[tuple[DecisionType, DecisionType]] = [
    (DecisionType.ADAPT, DecisionType.HEAL),
    (DecisionType.HEAL, DecisionType.RETRY),
    (DecisionType.RETRY, DecisionType.PAUSE),
]

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
    "max_loop_iterations": 200,
    "max_dom_snippet_bytes": 8192,
    "max_visible_text_bytes": 2048,
    "max_visible_elements": 30,
    "max_run_duration_seconds": 1800,
    "max_tokens_per_run": 200000,
    "stale_poll_timeout_seconds": 300,
}
