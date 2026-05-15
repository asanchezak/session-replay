# AI Agent Execution Model — Architecture Design

## Overview

This document defines the detailed architecture for transitioning from a **linear step executor** to an **AI agent orchestrator** that makes intelligent decisions at every step based on full page context.

### Current vs Desired

| Aspect | Current | Desired |
|---|---|---|
| Execution model | Linear for-loop in extension | Agent decision loop on backend |
| AI usage | Reactive (healing only) + one-time analysis | Proactive (every step decision) |
| Page context | Captured only on failure | Captured before every decision |
| Plan | Static, generated once | Dynamic, updated during execution |
| Failure handling | Detect → heal → pause | Predict → adapt → execute |
| Control flow | Extension owns the loop | Backend owns the loop |

---

## 1. AI Agent Service (backend)

### 1.1 Location

`backend/services/agent_service.py`

### 1.2 Core Data Structures

```python
from enum import Enum
from dataclasses import dataclass, field
from typing import Any


class AgentAction(str, Enum):
    EXECUTE = "execute"          # Execute the planned step
    SKIP = "skip"                # Skip this step (no longer needed)
    RETRY = "retry"              # Retry the same step
    HEAL = "heal"                # Attempt selector healing
    ADAPT = "adapt"              # Modify the plan dynamically
    PAUSE = "pause"              # Pause for human intervention
    COMPLETE = "complete"        # All done
    VERIFY = "verify"            # Verify page state before proceeding
    WAIT = "wait"                # Wait for condition (element, URL, time)
    EXTRACT = "extract"          # Extract data from current page


class ConfidenceLevel(str, Enum):
    HIGH = "high"       # >= 0.85 — execute directly
    MEDIUM = "medium"   # 0.60-0.84 — execute with fallback
    LOW = "low"         # 0.30-0.59 — try but expect failure
    VERY_LOW = "very_low"  # < 0.30 — pause for human


@dataclass
class AgentCommand:
    """A single command sent to the extension for execution."""
    command_id: str                          # UUID for tracking
    action: str                              # click, type, navigate, etc.
    params: dict[str, Any] = field(default_factory=dict)
    timeout_ms: int = 30000
    retry_on_failure: bool = True
    max_retries: int = 2
    metadata: dict[str, Any] = field(default_factory=dict)
    # metadata includes: step_index, phase, intent, original_selector


@dataclass
class PlanUpdate:
    """A modification to the execution plan."""
    version: int
    changes: list[dict] = field(default_factory=list)
    # changes: [{"type": "skip_step", "step_index": 3, "reason": "..."},
    #           {"type": "insert_step", "after_index": 2, "step": {...}},
    #           {"type": "modify_param", "key": "search_query", "value": "..."}]
    reasoning: str = ""


@dataclass
class AgentDecision:
    """The agent's decision for the current execution state."""
    action: AgentAction
    command: AgentCommand | None = None
    confidence: float = 0.0
    confidence_level: ConfidenceLevel = ConfidenceLevel.LOW
    reasoning: str = ""
    plan_update: PlanUpdate | None = None
    # Tracking
    step_index: int = 0
    phase_index: int = 0
    retry_count: int = 0
    # Audit
    tokens_used: int = 0
    model_used: str = ""
    decision_latency_ms: int = 0
```

### 1.3 Agent Service Implementation

```python
class AgentService:
    """AI agent that orchestrates workflow execution."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.audit = AuditService(session)
        self.execution = ExecutionService(session)

    async def decide_next_action(
        self,
        run_id: str,
        page_context: PageContext,
        execution_history: list[ExecutionRecord],
    ) -> AgentDecision:
        """Given current state, decide what to do next."""
        run = await self.execution.get_run(run_id)
        plan = await self._load_execution_plan(run)
        current_step = self._get_current_step(plan, run.current_step_index)

        # Build the agent prompt
        prompt = build_agent_prompt(
            workflow_goal=plan.workflow_goal,
            current_phase=self._get_current_phase(plan, run.current_step_index),
            current_step=current_step,
            page_context=page_context,
            execution_history=execution_history,
            plan=plan,
            run_state=run,
        )

        # Call AI
        start = time.monotonic()
        provider = get_ai_provider()
        response = await provider.generate(
            prompt,
            system=AGENT_SYSTEM_PROMPT,
            max_tokens=1024,
        )
        latency_ms = int((time.monotonic() - start) * 1000)

        # Parse decision
        decision = self._parse_decision(response.content, current_step, plan)
        decision.tokens_used = response.usage.get("completion_tokens", 0)
        decision.model_used = response.model
        decision.decision_latency_ms = latency_ms

        # Apply confidence thresholds
        decision = self._apply_confidence_policy(decision, run)

        # Audit
        await self.audit.append(AppendEvent(
            event_type="agent_decision",
            payload={
                "action": decision.action.value,
                "confidence": decision.confidence,
                "reasoning": decision.reasoning,
                "step_index": decision.step_index,
                "tokens_used": decision.tokens_used,
                "latency_ms": decision.decision_latency_ms,
            },
            run_id=run_id,
        ))

        return decision
```

### 1.4 Prompt Templates

```python
AGENT_SYSTEM_PROMPT = """You are an AI agent that executes browser workflows. Your goal is to complete the workflow successfully by making intelligent decisions at each step.

DECISION RULES:
1. EXECUTE: Use when the current step can be performed on the current page with high confidence.
2. SKIP: Use when the step is no longer needed (e.g., element already in desired state, page already navigated).
3. RETRY: Use when the previous attempt failed but conditions suggest it might succeed now.
4. HEAL: Use when the selector is broken but the target element likely exists with different attributes.
5. VERIFY: Use when you need to confirm page state before proceeding (e.g., after navigation).
6. WAIT: Use when the page is loading or an element is not yet visible.
7. PAUSE: Use when you encounter a blocking condition (CAPTCHA, login, 2FA) that requires human action.
8. ADAPT: Use when the page structure has changed significantly and the plan needs modification.
9. COMPLETE: Use when all workflow goals have been achieved.
10. EXTRACT: Use when the current page contains data that should be extracted.

CONFIDENCE GUIDELINES:
- 0.9-1.0: Very confident, conditions match expectations perfectly
- 0.7-0.89: Confident, minor uncertainties but likely to succeed
- 0.5-0.69: Moderate, some uncertainty but worth attempting
- 0.3-0.49: Low, significant uncertainty, prepare for failure
- 0.0-0.29: Very low, likely to fail, consider pausing

OUTPUT FORMAT:
Return ONLY valid JSON with this structure:
{
  "action": "execute|skip|retry|heal|adapt|pause|complete|verify|wait|extract",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of why this decision was made",
  "command": {
    "action": "click|type|navigate|select|scroll|hover|wait_for|verify_state|extract_data",
    "params": {
      "selector": "css selector or null",
      "value": "text to type or null",
      "timeout_ms": 30000,
      "wait_for": "element|url|time",
      "wait_condition": "selector or URL pattern",
      "verify_check": "element_exists|text_present|url_matches"
    },
    "metadata": {
      "step_index": 0,
      "phase": "phase name",
      "intent": "what this action accomplishes"
    }
  },
  "plan_update": {
    "changes": [{"type": "skip_step|insert_step|modify_param", ...}],
    "reasoning": "why the plan needs to change"
  }
}

Only include "command" if action is execute/retry/heal/verify/wait/extract.
Only include "plan_update" if action is adapt or skip."""


def build_agent_prompt(
    workflow_goal: str | None,
    current_phase: dict | None,
    current_step: dict | None,
    page_context: "PageContext",
    execution_history: list[dict],
    plan: dict,
    run_state: Any,
) -> str:
    """Build the full prompt for the agent decision."""
    parts = []

    # Workflow context
    parts.append(f"## WORKFLOW GOAL\n{workflow_goal or 'Unknown'}")

    # Current phase
    if current_phase:
        parts.append(f"\n## CURRENT PHASE\n{current_phase.get('name', 'Unknown')}: {current_phase.get('goal', '')}")

    # Current step
    if current_step:
        parts.append(f"\n## CURRENT STEP (index {current_step.get('step_index', '?')})")
        parts.append(f"Action: {current_step.get('action_type', 'unknown')}")
        parts.append(f"Intent: {current_step.get('intent', 'none')}")
        if current_step.get('selector_chain'):
            selectors = [s.get('value', '') for s in current_step['selector_chain']]
            parts.append(f"Selectors: {', '.join(selectors)}")
        if current_step.get('value'):
            parts.append(f"Value: {current_step['value'][:100]}")

    # Page context
    parts.append(f"\n## CURRENT PAGE STATE")
    parts.append(f"URL: {page_context.url}")
    parts.append(f"Title: {page_context.title}")
    parts.append(f"\n### Interactive Elements ({len(page_context.interactive_elements)} found)")
    for el in page_context.interactive_elements[:30]:  # Cap at 30
        parts.append(f"- [{el.get('role', 'element')}] \"{el.get('text', '')[:50]}\" {el.get('selector', '')}")
    if page_context.challenges:
        parts.append(f"\n### Challenges Detected")
        for c in page_context.challenges:
            parts.append(f"- {c['type']}: {c['description']}")
    if page_context.visible_text:
        parts.append(f"\n### Visible Text (first 1000 chars)")
        parts.append(page_context.visible_text[:1000])

    # Execution history
    if execution_history:
        parts.append(f"\n## EXECUTION HISTORY (last {len(execution_history)} steps)")
        for record in execution_history[-10:]:  # Last 10
            status = "✓" if record.get("success") else "✗"
            parts.append(f"{status} Step {record['step_index']}: {record['action']} — {record.get('error', 'ok')}")

    # Plan overview
    parts.append(f"\n## EXECUTION PLAN")
    parts.append(f"Total steps: {plan.get('total_steps', '?')}")
    parts.append(f"Current step: {run_state.current_step_index}")
    if plan.get('phases'):
        for phase in plan['phases']:
            marker = ">>>" if phase.get('index') == (current_phase or {}).get('index') else "   "
            parts.append(f"{marker} Phase {phase['index']}: {phase['name']} (steps {phase.get('steps', [])})")

    # Previous failures
    if run_state.retry_count > 0:
        parts.append(f"\n## RETRY CONTEXT")
        parts.append(f"This step has been attempted {run_state.retry_count} times already")

    parts.append(f"\n## DECISION\nBased on the current page state and execution history, what should be done next?")

    return "\n".join(parts)
```

### 1.5 Page Context Data Structure

```python
@dataclass
class PageContext:
    """Snapshot of the current page state."""
    url: str
    title: str
    # Level 1: Always captured (~2KB)
    interactive_elements: list[dict] = field(default_factory=list)
    # [{role, text, selector, aria_label, tag, visible}]
    visible_text: str = ""
    challenges: list[dict] = field(default_factory=list)
    # [{type, confidence, description}]

    # Level 2: On demand (~10KB)
    dom_snippet: str = ""
    accessibility_tree: str = ""

    # Level 3: Rare (~50KB+)
    full_dom: str = ""
    screenshot_ref: str = ""

    # Metadata
    captured_at: str = ""
    capture_duration_ms: int = 0
    element_count: int = 0
    load_state: str = "complete"  # loading | interactive | complete

    def summary(self) -> str:
        """Return a compact summary for the agent prompt."""
        return (
            f"URL: {self.url}\n"
            f"Title: {self.title}\n"
            f"Interactive elements: {len(self.interactive_elements)}\n"
            f"Challenges: {len(self.challenges)}"
        )
```

### 1.6 Confidence Threshold Policy

```python
class ConfidencePolicy:
    """Applies confidence thresholds to agent decisions."""

    def __init__(self, config: AgentConfig):
        self.high_threshold = config.high_threshold      # 0.85
        self.medium_threshold = config.medium_threshold  # 0.60
        self.low_threshold = config.low_threshold        # 0.30
        self.max_retries = config.max_retries            # 3
        self.max_consecutive_failures = config.max_consecutive_failures  # 5

    def apply(self, decision: AgentDecision, run_state: Any) -> AgentDecision:
        """Adjust decision based on confidence and run state."""
        # Classify confidence level
        if decision.confidence >= self.high_threshold:
            decision.confidence_level = ConfidenceLevel.HIGH
        elif decision.confidence >= self.medium_threshold:
            decision.confidence_level = ConfidenceLevel.MEDIUM
        elif decision.confidence >= self.low_threshold:
            decision.confidence_level = ConfidenceLevel.LOW
        else:
            decision.confidence_level = ConfidenceLevel.VERY_LOW

        # Very low confidence → force pause
        if decision.confidence_level == ConfidenceLevel.VERY_LOW:
            decision.action = AgentAction.PAUSE
            decision.reasoning = (
                f"Confidence too low ({decision.confidence:.2f}) — "
                f"pausing for human review. Original: {decision.reasoning}"
            )
            decision.command = None

        # Low confidence + many retries → pause
        if (decision.confidence_level == ConfidenceLevel.LOW
                and run_state.retry_count >= self.max_retries):
            decision.action = AgentAction.PAUSE
            decision.reasoning = (
                f"Low confidence after {run_state.retry_count} retries — "
                f"pausing for human review."
            )

        # Medium confidence → add fallback to command
        if decision.confidence_level == ConfidenceLevel.MEDIUM and decision.command:
            decision.command.params["fallback_selectors"] = (
                decision.command.metadata.get("original_selectors", [])
            )
            decision.command.max_retries = 1

        # Consecutive failures → pause
        if run_state.consecutive_failures >= self.max_consecutive_failures:
            decision.action = AgentAction.PAUSE
            decision.reasoning = (
                f"{run_state.consecutive_failures} consecutive failures — "
                f"circuit breaker triggered."
            )

        return decision
```

---

## 2. Execution Coordinator (backend)

### 2.1 Location

`backend/services/agent_coordinator.py`

### 2.2 Execution Loop

```python
class AgentCoordinator:
    """Manages the agent execution loop."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.agent = AgentService(session)
        self.execution = ExecutionService(session)
        self.audit = AuditService(session)
        self._active_commands: dict[str, ActiveCommand] = {}

    async def start_agent_execution(self, run_id: str, parameters: dict | None = None) -> dict:
        """Start agent-mode execution for a run."""
        run = await self.execution.get_run(run_id)
        await self.execution.transition(run_id, RunStatus.RUNNING)

        # Load and apply parameters to the plan
        plan = await self._load_and_parameterize(run.workflow_id, parameters)

        # Store execution state
        exec_state = AgentExecutionState(
            run_id=run_id,
            plan=plan,
            current_step_index=0,
            current_phase_index=0,
            history=[],
            consecutive_failures=0,
            total_retries=0,
            plan_version=1,
        )
        await self._store_state(exec_state)

        # Get initial context from extension
        await self.audit.append(AppendEvent(
            event_type="agent_started",
            payload={"run_id": run_id, "plan_version": 1},
            run_id=run_id,
        ))

        return {"run_id": run_id, "status": "running", "mode": "agent"}

    async def get_next_command(self, run_id: str, context: PageContext | None = None) -> dict:
        """Get the next command for the extension to execute.

        This is the polling endpoint. The extension calls this after:
        1. Starting agent execution
        2. Completing a previous command
        3. Periodically (long-polling, up to 30s timeout)
        """
        state = await self._load_state(run_id)
        run = await self.execution.get_run(run_id)

        # If no context provided, request one
        if context is None:
            return {
                "command": {
                    "command_id": str(uuid4()),
                    "action": "capture_context",
                    "params": {"level": 1},
                    "timeout_ms": 5000,
                },
                "run_status": run.status,
            }

        # Record context in history
        state.history.append({
            "type": "context",
            "step_index": state.current_step_index,
            "context": context.summary(),
            "timestamp": datetime.now(UTC).isoformat(),
        })

        # Ask agent for decision
        decision = await self.agent.decide_next_action(
            run_id=run_id,
            page_context=context,
            execution_history=state.history,
        )

        # Process decision
        return await self._process_decision(run_id, state, decision)

    async def report_command_result(
        self, run_id: str, command_id: str, result: CommandResult
    ) -> dict:
        """Process the result of a command execution."""
        state = await self._load_state(run_id)

        # Record result in history
        state.history.append({
            "type": "command_result",
            "command_id": command_id,
            "step_index": state.current_step_index,
            "success": result.success,
            "error": result.error,
            "context_after": result.context.summary() if result.context else None,
            "timing_ms": result.timing_ms,
            "timestamp": datetime.now(UTC).isoformat(),
        })

        # Update state based on result
        if result.success:
            state.consecutive_failures = 0
            state.current_step_index += 1
        else:
            state.consecutive_failures += 1
            state.total_retries += 1

        # Audit
        await self.audit.append(AppendEvent(
            event_type="command_executed",
            payload={
                "command_id": command_id,
                "success": result.success,
                "error": result.error,
                "step_index": state.current_step_index,
            },
            run_id=run_id,
        ))

        await self._store_state(state)

        # Return next command
        return await self.get_next_command(run_id, result.context)

    async def _process_decision(
        self, run_id: str, state: AgentExecutionState, decision: AgentDecision
    ) -> dict:
        """Convert an agent decision into a response for the extension."""
        run = await self.execution.get_run(run_id)

        if decision.action == AgentAction.COMPLETE:
            await self.execution.complete(run_id)
            return {"command": None, "run_status": "completed"}

        if decision.action == AgentAction.PAUSE:
            await self.execution.pause(run_id, decision.reasoning)
            return {
                "command": None,
                "run_status": "waiting_for_user",
                "pause_reason": decision.reasoning,
            }

        if decision.action == AgentAction.ADAPT and decision.plan_update:
            await self._apply_plan_update(state, decision.plan_update)

        if decision.command:
            # Store active command for timeout tracking
            self._active_commands[decision.command.command_id] = ActiveCommand(
                command_id=decision.command.command_id,
                run_id=run_id,
                created_at=datetime.now(UTC),
                timeout_ms=decision.command.timeout_ms,
            )

            return {
                "command": {
                    "command_id": decision.command.command_id,
                    "action": decision.command.action,
                    "params": decision.command.params,
                    "timeout_ms": decision.command.timeout_ms,
                    "metadata": decision.command.metadata,
                },
                "run_status": run.status,
                "decision": {
                    "action": decision.action.value,
                    "confidence": decision.confidence,
                    "reasoning": decision.reasoning,
                },
            }

        # No command — tell extension to wait and poll again
        return {"command": None, "run_status": run.status, "wait_ms": 1000}
```

### 2.3 State Machine Transitions (Additions)

The existing state machine remains, but new events are added to the audit trail:

| Event | From | To | Trigger |
|---|---|---|---|
| `agent_started` | QUEUED | RUNNING | Agent execution begins |
| `agent_decision` | RUNNING | RUNNING | Agent makes a decision |
| `command_executed` | RUNNING | RUNNING | Extension reports result |
| `plan_updated` | RUNNING | RUNNING | Agent adapts the plan |
| `agent_paused` | RUNNING | WAITING_FOR_USER | Agent requests human help |
| `agent_completed` | RUNNING | COMPLETED | All steps done |

No new states are needed — the existing states cover all agent scenarios.

### 2.4 Timeout and Retry Management

```python
class CommandTimeoutManager:
    """Tracks active commands and handles timeouts."""

    def __init__(self):
        self._active: dict[str, ActiveCommand] = {}
        self._check_interval = 10  # seconds

    async def register(self, command: ActiveCommand):
        self._active[command.command_id] = command

    async def check_timeouts(self) -> list[str]:
        """Return list of timed-out command IDs."""
        now = datetime.now(UTC)
        timed_out = []
        for cmd_id, cmd in list(self._active.items()):
            elapsed = (now - cmd.created_at).total_seconds() * 1000
            if elapsed > cmd.timeout_ms:
                timed_out.append(cmd_id)
                del self._active[cmd_id]
        return timed_out

    async def complete(self, command_id: str):
        self._active.pop(command_id, None)
```

---

## 3. Page Context Capture (extension)

### 3.1 Location

`extension/src/content/context.ts` (new file)

### 3.2 Implementation

```typescript
export interface InteractiveElement {
  tag: string;
  role: string;
  text: string;
  ariaLabel: string | null;
  selector: string;
  visible: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface ChallengeIndicator {
  type: "captcha" | "login" | "2fa" | "modal" | "error" | "cookie_consent";
  confidence: number;
  description: string;
}

export interface PageContextSnapshot {
  // Always captured
  url: string;
  title: string;
  interactiveElements: InteractiveElement[];
  visibleText: string;
  challenges: ChallengeIndicator[];
  loadState: "loading" | "interactive" | "complete";

  // On demand (level 2+)
  domSnippet?: string;
  accessibilityTree?: string;

  // Rare (level 3)
  fullDom?: string;
  screenshotDataUrl?: string;

  // Metadata
  capturedAt: string;
  captureDurationMs: number;
  elementCount: number;
}

export async function capturePageContext(
  options: { level?: 1 | 2 | 3; targetSelector?: string } = {},
): Promise<PageContextSnapshot> {
  const start = performance.now();
  const level = options.level ?? 1;

  const snapshot: PageContextSnapshot = {
    url: window.location.href,
    title: document.title,
    interactiveElements: [],
    visibleText: "",
    challenges: [],
    loadState: document.readyState === "complete" ? "complete" : "interactive",
    capturedAt: new Date().toISOString(),
    captureDurationMs: 0,
    elementCount: 0,
  };

  // Level 1: Interactive elements summary
  snapshot.interactiveElements = captureInteractiveElements();
  snapshot.visibleText = captureVisibleText(2000);
  snapshot.challenges = detectChallenges();
  snapshot.elementCount = document.querySelectorAll("*").length;

  // Level 2: DOM snippet + accessibility tree
  if (level >= 2) {
    snapshot.domSnippet = captureDomSnippet(options.targetSelector);
    snapshot.accessibilityTree = captureAccessibilityTree();
  }

  // Level 3: Full DOM + screenshot
  if (level >= 3) {
    snapshot.fullDom = captureFullDomSnapshot();
    // Screenshot requires canvas capture — optional
  }

  snapshot.captureDurationMs = Math.round(performance.now() - start);
  return snapshot;
}

function captureInteractiveElements(): InteractiveElement[] {
  const elements: InteractiveElement[] = [];
  const selector = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="menuitem"], [tabindex="0"]';

  const nodes = document.querySelectorAll<HTMLElement>(selector);
  for (const el of nodes) {
    if (!isElementVisible(el)) continue;

    elements.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || inferRole(el),
      text: (el.textContent || "").trim().slice(0, 100),
      ariaLabel: el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || null,
      selector: buildCompactSelector(el),
      visible: true,
      rect: {
        x: Math.round(el.getBoundingClientRect().x),
        y: Math.round(el.getBoundingClientRect().y),
        width: Math.round(el.getBoundingClientRect().width),
        height: Math.round(el.getBoundingClientRect().height),
      },
    });

    if (elements.length >= 100) break; // Cap at 100 elements
  }

  return elements;
}

function captureVisibleText(maxLength: number): string {
  // Get visible text from body, excluding scripts/styles
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "noscript") {
          return NodeFilter.FILTER_REJECT;
        }
        if (!isElementVisible(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  const texts: string[] = [];
  let totalLength = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim();
    if (text && text.length > 0) {
      texts.push(text);
      totalLength += text.length;
      if (totalLength >= maxLength) break;
    }
  }

  return texts.join("\n").slice(0, maxLength);
}

function detectChallenges(): ChallengeIndicator[] {
  const challenges: ChallengeIndicator[] = [];

  // CAPTCHA detection
  const captchaSelectors = [
    '[class*="captcha"]', '[class*="g-recaptcha"]', '[class*="h-captcha"]',
    '[id*="captcha"]', 'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]',
  ];
  for (const sel of captchaSelectors) {
    if (document.querySelector(sel)) {
      challenges.push({
        type: "captcha",
        confidence: 0.95,
        description: "CAPTCHA element detected",
      });
      break;
    }
  }

  // Login form detection
  const passwordInputs = document.querySelectorAll('input[type="password"]');
  if (passwordInputs.length > 0) {
    challenges.push({
      type: "login",
      confidence: 0.8,
      description: `${passwordInputs.length} password field(s) detected`,
    });
  }

  // Cookie consent
  const cookieSelectors = [
    '[class*="cookie-consent"]', '[class*="cookie-banner"]',
    '[id*="cookie-consent"]', '[aria-label*="cookie"]',
  ];
  for (const sel of cookieSelectors) {
    if (document.querySelector(sel)) {
      challenges.push({
        type: "cookie_consent",
        confidence: 0.7,
        description: "Cookie consent banner detected",
      });
      break;
    }
  }

  // Modal/dialog detection
  const modals = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, .dialog');
  if (modals.length > 0) {
    challenges.push({
      type: "modal",
      confidence: 0.85,
      description: `${modals.length} modal dialog(s) detected`,
    });
  }

  return challenges;
}

function captureAccessibilityTree(): string {
  // Build a simplified accessibility tree
  const root = document.body;
  return buildAccessibilityNode(root, 0);
}

function buildAccessibilityNode(el: Element, depth: number): string {
  if (depth > 5) return ""; // Limit depth

  const role = el.getAttribute("role") || el.tagName.toLowerCase();
  const label = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || "";
  const name = el.getAttribute("name") || "";
  const indent = "  ".repeat(depth);

  let line = `${indent}[${role}]`;
  if (label) line += ` "${label.slice(0, 50)}"`;
  if (name) line += ` name="${name}"`;

  const children: string[] = [];
  for (const child of el.children) {
    const childStr = buildAccessibilityNode(child, depth + 1);
    if (childStr) children.push(childStr);
  }

  if (children.length > 0) {
    return line + "\n" + children.join("\n");
  }
  return line;
}
```

### 3.3 Messaging Updates

Add to `extension/src/shared/messaging.ts`:

```typescript
export interface CaptureContextMessage {
  type: "CAPTURE_CONTEXT";
  level: 1 | 2 | 3;
  targetSelector?: string;
  protocol_version?: number;
}

export interface ContextResultResponse {
  type: "CONTEXT_RESULT";
  context: PageContextSnapshot;
  error?: string;
}

export interface AgentCommandMessage {
  type: "AGENT_COMMAND";
  command: {
    command_id: string;
    action: string;
    params: Record<string, unknown>;
    timeout_ms: number;
    metadata?: Record<string, unknown>;
  };
  protocol_version?: number;
}

export interface AgentCommandResult {
  type: "AGENT_COMMAND_RESULT";
  command_id: string;
  success: boolean;
  result: Record<string, unknown>;
  context: PageContextSnapshot;
  error?: string;
  timing_ms: number;
}

// Add to ExtensionMessage union:
// | CaptureContextMessage | AgentCommandMessage

// Add to ExtensionResponse union:
// | ContextResultResponse | AgentCommandResult
```

---

## 4. Command Executor (extension)

### 4.1 Location

`extension/src/content/agent-executor.ts` (new file)

### 4.2 Implementation

```typescript
import { executeStep } from "./replay";
import { capturePageContext } from "./context";
import type { PageContextSnapshot } from "./context";

export interface CommandExecutionResult {
  commandId: string;
  success: boolean;
  result: Record<string, unknown>;
  context: PageContextSnapshot;
  error?: string;
  timingMs: number;
}

export async function executeAgentCommand(
  command: {
    command_id: string;
    action: string;
    params: Record<string, unknown>;
    timeout_ms: number;
  },
): Promise<CommandExecutionResult> {
  const start = performance.now();

  try {
    let result: Record<string, unknown>;

    switch (command.action) {
      case "capture_context": {
        const level = (command.params.level as 1 | 2 | 3) || 1;
        const context = await capturePageContext({ level });
        result = { context_summary: context.interactiveElements.length + " elements" };
        // Return context separately
        return {
          commandId: command.command_id,
          success: true,
          result,
          context,
          timingMs: Math.round(performance.now() - start),
        };
      }

      case "click":
      case "type":
      case "select":
      case "scroll":
      case "hover": {
        const stepResult = await executeStep({
          action_type: command.action,
          selector_chain: (command.params.selectors as Array<{ type: string; value: string }>) || [],
          value: command.params.value as string | undefined,
          intent: command.params.intent as string | undefined,
        });

        if (!stepResult.success) {
          const context = await capturePageContext({ level: 2 });
          return {
            commandId: command.command_id,
            success: false,
            result: {},
            context,
            error: stepResult.error,
            timingMs: Math.round(performance.now() - start),
          };
        }

        // Wait for potential navigation
        if (command.action === "click" || command.action === "select") {
          await waitForSettling(command.timeout_ms);
        }

        const context = await capturePageContext({ level: 1 });
        return {
          commandId: command.command_id,
          success: true,
          result: { action: command.action },
          context,
          timingMs: Math.round(performance.now() - start),
        };
      }

      case "navigate": {
        const url = command.params.url as string;
        if (!url) {
          return {
            commandId: command.command_id,
            success: false,
            result: {},
            context: await capturePageContext(),
            error: "No URL provided",
            timingMs: Math.round(performance.now() - start),
          };
        }
        window.location.href = url;
        await waitForPageLoad(command.timeout_ms);
        const context = await capturePageContext({ level: 1 });
        return {
          commandId: command.command_id,
          success: true,
          result: { url },
          context,
          timingMs: Math.round(performance.now() - start),
        };
      }

      case "wait_for": {
        const waitType = command.params.wait_for as string;
        const condition = command.params.wait_condition as string;
        const success = await waitForCondition(waitType, condition, command.timeout_ms);
        const context = await capturePageContext({ level: 1 });
        return {
          commandId: command.command_id,
          success,
          result: { wait_type: waitType, condition },
          context,
          error: success ? undefined : "Wait condition not met",
          timingMs: Math.round(performance.now() - start),
        };
      }

      case "verify_state": {
        const check = command.params.verify_check as string;
        const target = command.params.target as string;
        const success = await verifyState(check, target);
        const context = await capturePageContext({ level: 1 });
        return {
          commandId: command.command_id,
          success,
          result: { check, target },
          context,
          error: success ? undefined : "Verification failed",
          timingMs: Math.round(performance.now() - start),
        };
      }

      case "extract_data": {
        // Use existing extraction logic
        const schema = command.params.schema as Record<string, unknown> | null;
        const data = await extractDataWithSchema(schema);
        const context = await capturePageContext({ level: 1 });
        return {
          commandId: command.command_id,
          success: true,
          result: { records: data.length },
          context,
          timingMs: Math.round(performance.now() - start),
        };
      }

      default:
        return {
          commandId: command.command_id,
          success: false,
          result: {},
          context: await capturePageContext(),
          error: `Unknown command action: ${command.action}`,
          timingMs: Math.round(performance.now() - start),
        };
    }
  } catch (err) {
    return {
      commandId: command.command_id,
      success: false,
      result: {},
      context: await capturePageContext({ level: 2 }),
      error: err instanceof Error ? err.message : String(err),
      timingMs: Math.round(performance.now() - start),
    };
  }
}

async function waitForSettling(timeoutMs: number): Promise<void> {
  // Wait for network idle or DOM stability
  const start = Date.now();
  let stableFrames = 0;
  let lastCount = document.querySelectorAll("*").length;

  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
    const currentCount = document.querySelectorAll("*").length;
    if (currentCount === lastCount) {
      stableFrames++;
      if (stableFrames >= 3) return; // Stable for 3 checks
    } else {
      stableFrames = 0;
    }
    lastCount = currentCount;
  }
}

async function waitForPageLoad(timeoutMs: number): Promise<void> {
  if (document.readyState === "complete") return;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Page load timeout")), timeoutMs);
    const listener = () => {
      clearTimeout(timeout);
      window.removeEventListener("load", listener);
      resolve();
    };
    window.addEventListener("load", listener);
  });
}

async function waitForCondition(type: string, condition: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    switch (type) {
      case "element":
        if (document.querySelector(condition)) return true;
        break;
      case "url":
        if (window.location.href.includes(condition)) return true;
        break;
      case "text":
        if (document.body.textContent?.includes(condition)) return true;
        break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function verifyState(check: string, target: string): Promise<boolean> {
  switch (check) {
    case "element_exists":
      return !!document.querySelector(target);
    case "text_present":
      return !!document.body.textContent?.includes(target);
    case "url_matches":
      return window.location.href.includes(target);
    default:
      return false;
  }
}
```

---

## 5. API Contract

### 5.1 New Endpoints

All endpoints under `/v1/runs/{run_id}/agent/`

#### 5.1.1 Start Agent Execution

```
POST /v1/runs/{run_id}/agent/start
Authorization: X-API-Key: <key>
Content-Type: application/json

Request:
{
  "execution_mode": "agent",
  "parameters": {
    "search_query": "Senior React Developer",
    "location": "Berlin"
  }
}

Response (200):
{
  "run_id": "uuid",
  "status": "running",
  "mode": "agent",
  "plan_version": 1,
  "total_steps": 7
}

Error (404):
{ "error": { "code": "NOT_FOUND", "message": "Run not found" } }

Error (409):
{ "error": { "code": "STATE_ERROR", "message": "Run must be in 'queued' state" } }
```

#### 5.1.2 Get Next Command (Long-Polling)

```
POST /v1/runs/{run_id}/agent/next-command
Authorization: X-API-Key: <key>
Content-Type: application/json

Request:
{
  "context": {
    "url": "https://linkedin.com/jobs",
    "title": "Jobs | LinkedIn",
    "interactiveElements": [
      { "tag": "input", "role": "searchbox", "text": "Search jobs...", "selector": "input.jobs-search-box" }
    ],
    "visibleText": "Search for jobs...",
    "challenges": [],
    "loadState": "complete",
    "capturedAt": "2025-05-14T10:30:00Z",
    "captureDurationMs": 45,
    "elementCount": 342
  },
  "poll_timeout_ms": 30000  // Optional: how long to hold the connection
}

Response (200) — Command ready:
{
  "command": {
    "command_id": "uuid",
    "action": "click",
    "params": {
      "selectors": [
        { "type": "css", "value": "input.jobs-search-box" }
      ],
      "intent": "Click the search box to enter query"
    },
    "timeout_ms": 30000,
    "metadata": {
      "step_index": 0,
      "phase": "Search Configuration",
      "intent": "Focus the search input"
    }
  },
  "run_status": "running",
  "decision": {
    "action": "execute",
    "confidence": 0.92,
    "reasoning": "Search box is visible and ready for input"
  }
}

Response (200) — No command, wait:
{
  "command": null,
  "run_status": "running",
  "wait_ms": 1000
}

Response (200) — Run paused:
{
  "command": null,
  "run_status": "waiting_for_user",
  "pause_reason": "CAPTCHA detected on the page"
}
```

#### 5.1.3 Report Command Result

```
POST /v1/runs/{run_id}/agent/command-result
Authorization: X-API-Key: <key>
Content-Type: application/json

Request:
{
  "command_id": "uuid",
  "success": true,
  "result": { "action": "click" },
  "context": {
    "url": "https://linkedin.com/jobs",
    "title": "Jobs | LinkedIn",
    "interactiveElements": [
      { "tag": "input", "role": "searchbox", "text": "", "selector": "input.jobs-search-box", "visible": true }
    ],
    "visibleText": "",
    "challenges": [],
    "loadState": "complete",
    "capturedAt": "2025-05-14T10:30:01Z",
    "captureDurationMs": 30,
    "elementCount": 342
  },
  "error": null,
  "timing_ms": 150
}

Response (200):
{
  "command": { ... },  // Next command, or null
  "run_status": "running",
  "decision": { ... }  // Agent's reasoning for next command
}

Response (200) — Run completed:
{
  "command": null,
  "run_status": "completed"
}
```

#### 5.1.4 Get Agent State

```
GET /v1/runs/{run_id}/agent/state
Authorization: X-API-Key: <key>

Response (200):
{
  "run_id": "uuid",
  "mode": "agent",
  "current_phase_index": 1,
  "current_phase_name": "Search Configuration",
  "current_step_index": 2,
  "total_steps": 7,
  "plan_version": 1,
  "decisions_made": 5,
  "decisions": [
    { "action": "execute", "confidence": 0.92, "step_index": 0 },
    { "action": "execute", "confidence": 0.88, "step_index": 1 },
    { "action": "skip", "confidence": 0.75, "step_index": 2, "reasoning": "Already on jobs page" }
  ],
  "consecutive_failures": 0,
  "total_retries": 0,
  "tokens_used": 4520,
  "started_at": "2025-05-14T10:30:00Z"
}
```

#### 5.1.5 Resume After Human Intervention

```
POST /v1/runs/{run_id}/agent/resume
Authorization: X-API-Key: <key>
Content-Type: application/json

Request:
{
  "context": {
    "url": "https://linkedin.com/jobs",
    "title": "Jobs | LinkedIn",
    "interactiveElements": [...],
    "visibleText": "...",
    "challenges": [],
    "loadState": "complete",
    "capturedAt": "2025-05-14T10:35:00Z",
    "captureDurationMs": 40,
    "elementCount": 342
  }
}

Response (200):
{
  "command": { ... },  // Next command after intervention
  "run_status": "running"
}
```

### 5.2 Data Flow Diagram

```
┌─────────────┐                    ┌──────────────────┐                    ┌─────────────┐
│  Extension   │                    │  Backend Agent   │                    │    AI API   │
│  (SW + CS)   │                    │  Coordinator     │                    │  (OpenAI)   │
└──────┬───────┘                    └────────┬─────────┘                    └──────┬──────┘
       │                                     │                                     │
       │  POST /runs/{id}/agent/start        │                                     │
       │────────────────────────────────────>│                                     │
       │                                     │                                     │
       │  { run_id, status, mode }           │                                     │
       │<────────────────────────────────────│                                     │
       │                                     │                                     │
       │  Capture page context               │                                     │
       │  (content script)                   │                                     │
       │                                     │                                     │
       │  POST /runs/{id}/agent/next-command │                                     │
       │  { context }                        │                                     │
       │────────────────────────────────────>│                                     │
       │                                     │  Build prompt + call AI             │
       │                                     │────────────────────────────────────>│
       │                                     │                                     │
       │                                     │  { decision JSON }                  │
       │                                     │<────────────────────────────────────│
       │                                     │                                     │
       │  { command, decision }              │                                     │
       │<────────────────────────────────────│                                     │
       │                                     │                                     │
       │  Execute command + capture context  │                                     │
       │  (content script)                   │                                     │
       │                                     │                                     │
       │  POST /runs/{id}/agent/command-result│                                    │
       │  { command_id, success, context }   │                                     │
       │────────────────────────────────────>│                                     │
       │                                     │  Build prompt + call AI             │
       │                                     │────────────────────────────────────>│
       │                                     │                                     │
       │  { next_command } or { completed }  │                                     │
       │<────────────────────────────────────│                                     │
       │                                     │                                     │
       │  ... repeat until complete ...      │                                     │
       │                                     │                                     │
```

### 5.3 Backward Compatibility

Existing endpoints remain unchanged:

| Endpoint | Status | Notes |
|---|---|---|
| `POST /runs` | Unchanged | Creates run in `queued` state |
| `GET /runs/{id}/next-step` | Unchanged | Used by linear execution mode |
| `POST /runs/{id}/step-result` | Unchanged | Used by linear execution mode |
| `POST /runs/{id}/heal-step` | Unchanged | Used by linear execution mode |
| `POST /runs/{id}/agent/start` | **New** | Starts agent mode |
| `POST /runs/{id}/agent/next-command` | **New** | Agent polling endpoint |
| `POST /runs/{id}/agent/command-result` | **New** | Agent result reporting |

The extension chooses which mode to use based on the workflow's `replay_strategy`:
- `literal` → use existing linear endpoints
- `parameterized` → use existing linear endpoints with params
- `agent` → use new agent endpoints

---

## 6. Migration Path

### Phase 1: Agent Infrastructure (Week 1-2)

**Goal:** Add agent service and decision logic without changing execution flow.

**Changes:**
- Create `backend/services/agent_service.py` with `AgentService` class
- Create `backend/services/agent_coordinator.py` with `AgentCoordinator` class
- Add `AgentDecision`, `AgentCommand`, `PageContext` data structures
- Add prompt templates to `backend/ai/prompts.py`
- Add unit tests for agent decision logic with mock contexts
- Add `execution_mode` field to `ExecutionRun` model (nullable, defaults to `null`)

**No changes to extension or existing endpoints.**

### Phase 2: Page Context Capture (Week 2-3)

**Goal:** Capture page context during existing execution.

**Changes:**
- Create `extension/src/content/context.ts` with `capturePageContext()`
- Add `CAPTURE_CONTEXT` / `CONTEXT_RESULT` message types
- Modify existing execution to capture context after each step (level 1)
- Store context snapshots in `EventLog` as `page_context` events
- Add context to healing service (already captures DOM, now captures full context)

**Existing execution flow unchanged — context is captured but not yet used by agent.**

### Phase 3: Agent-Mode Execution (Week 3-4)

**Goal:** Enable agent-mode execution as an opt-in feature.

**Changes:**
- Add new API endpoints under `/runs/{id}/agent/`
- Add `POST /workflows/{id}/run-agent` endpoint (creates run + starts agent mode)
- Extension: add `AgentExecutor` class that polls for commands
- Extension: modify service worker to detect `replay_strategy: "agent"` and use agent loop
- Feature flag: `settings.deterministic_only` disables agent mode
- Add integration tests for the full agent loop

**Both execution modes coexist. Existing workflows continue to use linear execution.**

### Phase 4: Dynamic Plan Adaptation (Week 4-5)

**Goal:** Agent can modify the plan during execution.

**Changes:**
- Add `plan_version` field to `ExecutionRun`
- Add `PlanUpdate` model for tracking plan changes
- Agent service can return `plan_update` in decisions
- Coordinator applies plan updates and stores them
- Audit trail records all plan changes
- Frontend: display plan changes in run detail view

### Phase 5: Proactive Failure Handling (Week 5-6)

**Goal:** Agent predicts and prevents failures.

**Changes:**
- Agent verifies selectors before executing (pre-emptive healing)
- Agent detects when steps are no longer needed (smart skipping)
- Agent recognizes page patterns and adapts strategy
- Add `verify` and `wait_for` command types
- Agent can insert new steps dynamically (e.g., "close modal before clicking")

### Backward Compatibility Guarantees

1. **Existing runs are unaffected.** Runs created before Phase 3 continue using linear execution.
2. **Existing endpoints are not modified.** New endpoints are additive.
3. **Extension supports both modes.** The service worker checks `replay_strategy` and routes accordingly.
4. **Feature flag for safety.** `deterministic_only=true` forces linear execution even for agent workflows.
5. **Graceful degradation.** If AI service is unavailable, agent mode falls back to linear execution.

### Testing Strategy

| Test Type | Scope | How |
|---|---|---|
| Unit | Agent decision logic | Mock contexts, verify decisions match expected actions |
| Unit | Confidence policy | Test threshold boundaries and override rules |
| Unit | Prompt building | Verify prompt contains all required sections |
| Integration | Agent loop | Mock AI responses, verify full loop completes |
| Integration | API endpoints | Test all new endpoints with realistic payloads |
| E2E | Agent vs Linear | Run same workflow both ways, compare success rates |
| E2E | Plan adaptation | Run workflow with changed page, verify agent adapts |
| E2E | Human intervention | Trigger CAPTCHA, verify agent pauses and resumes |
| Performance | Context capture | Measure capture time at each level (target: <100ms for level 1) |
| Performance | Agent latency | Measure decision time (target: <3s per decision) |

---

## 7. Error Handling Strategies

### 7.1 Agent Decision Errors

| Error | Handling |
|---|---|
| AI returns invalid JSON | Retry once, then fall back to linear execution for this step |
| AI returns unknown action | Log warning, treat as `execute` with original step |
| AI timeout (>10s) | Retry once, then fall back to linear execution |
| AI rate limited | Queue decision, retry with exponential backoff (max 3) |
| AI returns confidence 0.0 | Treat as `pause` for human review |

### 7.2 Command Execution Errors

| Error | Handling |
|---|---|
| Element not found | Agent decides: retry, heal, skip, or pause |
| Navigation timeout | Agent decides: retry navigation or skip |
| Tab closed | Fail run immediately, notify user |
| Content script unavailable | Wait 2s, retry (SW may have restarted) |
| Command timeout | Agent decides: retry or skip |

### 7.3 Context Capture Errors

| Error | Handling |
|---|---|
| DOM too large (>100KB) | Truncate to 50KB, note truncation in metadata |
| Content script not injected | Retry injection, fall back to URL-only context |
| Cross-origin iframe | Skip iframe content, note in context |
| Page still loading | Wait up to 5s, then capture what's available |

### 7.4 State Consistency

```python
class ExecutionGuard:
    """Prevents concurrent commands for the same run."""

    def __init__(self):
        self._locks: dict[str, asyncio.Lock] = {}

    async def acquire(self, run_id: str) -> bool:
        if run_id not in self._locks:
            self._locks[run_id] = asyncio.Lock()
        return await self._locks[run_id].acquire()

    def release(self, run_id: str):
        if run_id in self._locks:
            self._locks[run_id].release()
```

---

## 8. Database Changes

### 8.1 ExecutionRun Model Additions

```python
# Add to ExecutionRun model:
execution_mode = Column(String(20), nullable=True)  # "linear" | "agent" | null
plan_version = Column(Integer, default=1)
agent_tokens_used = Column(Integer, default=0)
agent_decisions_count = Column(Integer, default=0)
```

### 8.2 New Model: AgentExecutionState

```python
class AgentExecutionState(Base):
    __tablename__ = "agent_execution_states"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    run_id = Column(UUID(as_uuid=True), ForeignKey("runs.id"), unique=True)
    plan_snapshot = Column(JSON)
    current_step_index = Column(Integer, default=0)
    current_phase_index = Column(Integer, default=0)
    history = Column(JSON)  # Execution history for agent context
    consecutive_failures = Column(Integer, default=0)
    total_retries = Column(Integer, default=0)
    plan_version = Column(Integer, default=1)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
```

### 8.3 New Model: PlanUpdate

```python
class PlanUpdate(Base):
    __tablename__ = "plan_updates"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    run_id = Column(UUID(as_uuid=True), ForeignKey("runs.id"))
    plan_version = Column(Integer)
    changes = Column(JSON)
    reasoning = Column(Text)
    agent_confidence = Column(Float)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
```

---

## 9. Configuration

### 9.1 Backend Settings

Add to `backend/core/config.py`:

```python
class Settings(BaseSettings):
    # ... existing settings ...

    # Agent execution
    agent_enabled: bool = True
    agent_model: str = "gpt-4o"  # More capable model for agent decisions
    agent_max_tokens: int = 1024
    agent_high_confidence: float = 0.85
    agent_medium_confidence: float = 0.60
    agent_low_confidence: float = 0.30
    agent_max_retries: int = 3
    agent_max_consecutive_failures: int = 5
    agent_poll_timeout_ms: int = 30000
    agent_decision_timeout_ms: int = 10000
    agent_context_max_elements: int = 100
    agent_context_max_text_length: int = 2000
```

### 9.2 Extension Storage

Add to extension session storage:

```typescript
interface AgentConfig {
  agentEnabled: boolean;
  pollIntervalMs: number;    // Default: 1000
  pollTimeoutMs: number;     // Default: 30000
}
```

---

## 10. Summary of Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Agent location | Backend | Centralized, auditable, updatable without extension updates |
| Execution model | Polling (not WebSocket) | MV3 SW lifecycle makes persistent connections unreliable |
| Context capture | Tiered (1/2/3) | Balances speed vs. detail; most decisions need only level 1 |
| Plan mutability | Versioned updates | Audit trail for all changes, can replay with original plan |
| Confidence thresholds | 3 levels + pause | Clear decision boundaries, prevents low-confidence execution |
| Backward compat | Additive endpoints | No breaking changes, both modes coexist |
| Fallback strategy | Linear execution | If AI fails, fall back to proven linear execution |
| State machine | No new states | Existing states cover all agent scenarios |
| Command format | JSON with action + params | Extensible, type-safe, easy to add new command types |
| Context always returned | Yes | Agent needs post-action context for next decision |
