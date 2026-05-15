# AI Agent Execution Model — Implementation Plan

## Overview

**Problem**: The current execution model is a blind linear iterator that fails when selectors change. The AI agent should orchestrate execution using the semantic plan, make intelligent decisions at each step, and adapt dynamically.

**Solution**: Move the execution loop from the extension to the backend. The AI agent becomes the "brain" that understands the plan and makes decisions, while the extension becomes the "hands" that execute actions in the browser.

## Revision Notes (2026-05-14)

Based on architecture review, the following refinements were applied to the Phase 1 implementation:

| # | Issue | Resolution |
|---|-------|------------|
| 1 | Stale context race condition | Added `CommandPreCondition` model; command executor verifies pre-conditions before acting |
| 2 | No push from dashboard→extension | Added `POST /v1/agent/{run_id}/action` endpoint; extension polls every 500ms in `waiting_for_user` |
| 3 | No run-level timeouts | Added `max_run_duration_seconds: 1800`, `max_tokens_per_run: 50000`, `stale_poll_timeout_seconds: 300` |
| 4 | Per-command timeout unspecified | `AgentCommand.timeout_ms` (default 15000) enforced via `Promise.race` in command executor |
| 5 | PII redaction strategy undefined | Email, phone, SSN/CC patterns via existing `dom.ts` `redactPII()` + `PII_PATTERNS` |
| 6 | `PlanUpdate` model undefined | Defined as `{operation: ADD\|REMOVE\|MODIFY\|REORDER\|SIMPLIFY, step_index, new_step, reason}` |
| 7 | Agent sub-states not mapped | Agent decisions audited as `agent_decision` events; top-level state machine unchanged |
| 8 | HealingService interaction unclear | Agent decides HEAL, delegates to existing `StepHealer`; backend `HealingService` provides AI suggestions |
| 9 | Poll interval unspecified | Normal: 200ms; `waiting_for_user`: 500ms; error backoff: exponential (1s→2s→4s, max 30s) |
| 10 | Confidence score generation unspecified | Fast path: 0.99; LLM path (Phase 2): parsed from model output (floor 0.50) |

### Additional endpoints:
```
POST /v1/agent/{run_id}/action    (dashboard → backend push)
  Request: { action: "continue" | "cancel" | "retry" }
```

### Additional safety limits:
| Limit | Value | Purpose |
|---|---|---|
| Max run duration | 1800s (30 min) | Prevent infinite runs |
| Max tokens per run | 50000 | Cap LLM spend |
| Stale poll timeout | 300s (5 min) | No polls → mark failed |

### Confidence score generation:
| Source | Confidence | How |
|---|---|---|
| Fast path (deterministic) | 0.99 | Selector matches expected; page state matches snapshot |
| Fast path (heuristic) | 0.80 | Selector not found but similar elements detected |
| LLM path | Parsed from model output | Model returns `{"confidence": 0.N}` with floor 0.50 |
| LLM parse failure | 0.50 | Default to PAUSE when response can't be parsed |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    BACKEND (AI Agent)                        │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │ Semantic     │    │ AI Agent     │    │ Execution    │   │
│  │ Plan         │───▶│ Orchestrator │◀──▶│ Coordinator  │   │
│  │ (phases,     │    │              │    │              │   │
│  │  params,     │    │ - Decides    │    │ - Manages    │   │
│  │  intent)     │    │   next step  │    │   run state  │   │
│  └──────────────┘    │ - Analyzes   │    │ - Audit trail│   │
│                      │   page state │    │ - Recovery   │   │
│                      │ - Updates    │    └──────────────┘   │
│                      │   plan       │                       │
│                      └──────┬───────┘                       │
│                             │ HTTP API                      │
└─────────────────────────────┼───────────────────────────────┘
                              │
┌─────────────────────────────┼───────────────────────────────┐
│                    EXTENSION (Browser Controller)            │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │ Page Context │    │ Command      │    │ Step         │   │
│  │ Capture      │    │ Executor     │    │ History      │   │
│  │              │    │              │    │              │   │
│  │ - DOM snippet│    │ - click      │    │ - What was   │   │
│  │ - A11y tree  │    │ - type       │    │   attempted  │   │
│  │ - URL/title  │    │ - navigate   │    │ - Results    │   │
│  │ - Elements   │    │ - extract    │    │ - Page state │   │
│  └──────────────┘    └──────────────┘    └──────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Execution Flow

```
1. Start Run → Backend fetches semantic plan
2. For each step:
   a. Agent requests page context (DOM, a11y tree, URL, elements)
   b. Extension captures and sends context
   c. Agent analyzes: "Is the page in expected state?"
   d. Agent decides:
      - EXECUTE: "Click the search button" (with selectors or intent)
      - SKIP: "Already done (results visible)"
      - RETRY: "Page didn't load, wait and retry"
      - HEAL: "Element moved, find using intent + context"
      - ADAPT: "Page structure changed, different approach"
      - PAUSE: "CAPTCHA detected, need human"
   e. Extension executes command
   f. Agent receives result + new page state
   g. Agent updates plan if needed
3. Run completes or pauses for human intervention
```

---

## Phase 1: Foundation (Week 1-2)

### Backend

**New Files:**
- `backend/services/agent_models.py` — Pydantic data structures
- `backend/services/agent_service.py` — Agent service (fast path only)
- `backend/api/v1/agent.py` — Agent API endpoints

**Data Structures:**
```python
class PageContext(BaseModel):
    url: str
    title: str
    dom_snippet: str
    accessibility_tree: str
    visible_elements: list[dict]
    is_blocking: bool
    blocking_type: str | None

class AgentCommand(BaseModel):
    action: CommandAction  # navigate, click, type, select, scroll, extract
    target: str | None
    value: str | None
    selector_chain: list[dict]
    intent: str | None
    methods: list[dict]
    timeout_ms: int = 15000
    success_condition: dict | None
    pre_condition: CommandPreCondition | None

class AgentDecision(BaseModel):
    decision: DecisionType  # EXECUTE, SKIP, RETRY, HEAL, ADAPT, PAUSE
    confidence: float
    reasoning: str
    command: AgentCommand | None
    plan_updates: list[PlanUpdate]
    pause_reason: str | None
    requires_human: bool
```

**Agent Service (Fast Path):**
- Deterministic decision-making without LLM
- Fast path: page matches step expectations → EXECUTE
- Blocking page detection → PAUSE
- Confidence thresholds per decision type
- Integration with existing ExecutionService and HealingService

**API Endpoints:**
```
POST /v1/agent/{run_id}/poll
  Request: { page_context: PageContext }
  Response: { decision, confidence, reasoning, command, ... }

POST /v1/agent/{run_id}/result
  Request: { step_index, success, error, page_context_after }
  Response: { decision, command, ... }

GET /v1/agent/{run_id}/decisions
  Response: [ { id, payload, hash, created_at }, ... ]

POST /v1/agent/{run_id}/action
  Request: { action: "continue" | "cancel" | "retry" }
  Response: { accepted: bool, pending_action: str | null }
```

### Extension

**New Files:**
- `extension/src/content/capture.ts` — Page context capture
- `extension/src/background/command-executor.ts` — Command executor

**Page Context Capture:**
- Targeted DOM snippet (~8KB, PII-redacted)
- Accessibility tree of interactive elements
- Visible text content (~2KB)
- Challenge detection (CAPTCHA, login, modal)

**Command Executor:**
- Receives commands from backend agent
- Executes actions in browser
- Returns results + post-execution context

### Tests
- Unit tests for agent service (fast path)
- Integration tests for API endpoints
- Extension tests for page context capture

---

## Phase 2: AI Intelligence (Week 3-4)

### Backend

**New Files:**
- `backend/ai/agent_prompts.py` — Prompt templates

**LLM Decision Path:**
- Build decision prompt with: workflow goal, current step, page context, execution history
- Call OpenAI with structured prompt
- Parse response into AgentDecision
- Confidence validation and downgrade chain:
  - ADAPT (0.90) → HEAL (0.85) → RETRY (0.60) → PAUSE (0.50)
- Audit logging for every decision

**Prompt Template:**
```
You are a browser workflow execution agent. Your job is to decide the next action
for each step in a workflow based on the current page state.

## Workflow Goal: {goal}
## Current Step (index {idx}): {action} — {intent}
## Remaining Steps ({count}): ...
## Current Page State:
  URL: {url}
  Title: {title}
  Visible interactive elements: {count}
  DOM snippet: {dom}
## Previous Step Results: ...
## Instructions: Decide the next action. Return only JSON.
```

### Extension

**Agent-Driven Execution Loop:**
- Replace linear for-loop with poll → execute → report cycle
- Poll backend for next command with page context
- Execute command via CommandExecutor
- Report result + new context back to backend
- Handle terminal commands (completed, failed, canceled)
- Exponential backoff on poll failures
- State persistence in `chrome.storage.session` (survives SW restart)

**Mode Selection:**
- `RUN_WORKFLOW` message includes optional `mode` field
- Defaults to `"linear"` for backward compatibility
- Agent mode selected when workflow has semantic analysis

### Tests
- Mock LLM tests for decision logic
- End-to-end tests with real OpenAI
- Extension tests for agent-driven loop

---

## Phase 3: Advanced Features (Week 5-6)

### Backend

**Plan Updates:**
- Agent can modify the workflow plan dynamically
- Operations: ADD, REMOVE, MODIFY, REORDER, SIMPLIFY
- Track plan update count (max 10 per run)
- Audit logging for all plan changes

**Loop Handling:**
- LoopState data structure:
  - loop_type: PAGINATION, REPEATED_EXTRACTION, CONDITIONAL_REPEAT
  - step_range: (start, end) inclusive
  - iteration: current count
  - max_iterations: safety limit (default 100)
  - collected_count: items extracted so far
- LLM decision for loop continuation
- Page hash comparison for pagination detection

**Conditional Execution:**
- If/else logic based on page state
- Skip steps when conditions not met
- Branch to different phases based on content

### Extension

**Loop Support:**
- Agent communicates loop state in commands
- Extension tracks iteration count
- Handles pagination clicks, scroll-more, extract-and-continue

**State Management:**
- AgentExecutionState in `chrome.storage.session`
- Survives service worker restarts
- Resume capability after user intervention

### Tests
- Complex workflow tests with loops
- Pagination tests
- Plan update tests
- Conditional execution tests

---

## Phase 4: Production Readiness (Week 7-8)

### Monitoring & Observability
- Agent decision latency tracking
- Token usage monitoring
- Confidence distribution analytics
- Error rate by decision type
- Seq logging for all agent decisions

### Error Handling
- Graceful degradation: AI failure → fallback to linear execution
- Safety limits: max retries, max loops, max plan updates
- Timeout handling for long-running operations
- Network failure recovery

### Documentation
- Architecture guide
- API documentation
- Migration guide from linear to agent mode
- Troubleshooting guide

### Performance Optimization
- Cache common decisions
- Stream long-running operations
- Optimize page context capture (tiered approach)
- Reduce LLM calls with better fast path

### Security Review
- PII redaction verification
- API key handling
- DOM snippet sanitization
- Audit trail integrity

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| **Execution loop on backend** | Solves MV3 service worker timeouts, centralizes AI logic |
| **Polling, not WebSocket** | Survives SW restarts, simpler to implement |
| **Targeted DOM capture** | Keeps payloads under 50KB, focuses on what agent needs |
| **Deterministic first, AI second** | Reduces latency and cost for simple decisions |
| **Confidence-driven decisions** | ADAPT→HEAL→RETRY→PAUSE downgrade chain for safety |
| **Plan updates in workflow_snapshot** | No new DB model needed, same pattern as healing |
| **Loop state in snapshot** | Execution-time data, not durable workflow definition |
| **Backward compatibility** | Linear mode still works, agent mode is opt-in |

---

## Confidence Thresholds

| Decision | Threshold | Below threshold → |
|---|---|---|
| EXECUTE | 0.70 | RETRY (if failed) or PAUSE |
| SKIP | 0.80 | PAUSE (don't skip uncertainly) |
| RETRY | 0.60 | HEAL (if retry limit reached) |
| HEAL | 0.85 | PAUSE (use existing HealingService threshold) |
| ADAPT | 0.90 | HEAL (plan change is highest risk) |
| PAUSE | 0.50 | Always pause (safety net) |

---

## Safety Limits

| Limit | Value | Purpose |
|---|---|---|
| Max retries per step | 3 | Prevent infinite retry loops |
| Max heal attempts per step | 2 | Limit AI healing cost |
| Max plan updates per run | 10 | Prevent runaway plan modifications |
| Max consecutive failures | 5 | Pause before human intervention |
| Max loop iterations | 100 | Prevent infinite pagination loops |
| Max DOM snippet size | 8KB | Keep payloads manageable |
| Max visible text | 2KB | Limit context size |
| Max interactive elements | 30 | Focus on relevant elements |

---

## Migration Path

| Phase | Scope | Deliverable | Risk |
|---|---|---|---|
| **1** | Foundation | Data structures, fast path agent, API endpoints | Low |
| **2** | AI Intelligence | LLM decision path, agent-driven loop | Medium |
| **3** | Advanced Features | Plan updates, loops, conditionals | Medium |
| **4** | Production | Monitoring, docs, optimization, security | Low |

**Backward Compatibility:**
- Existing `executeWorkflowRun` is untouched
- Mode selection via `RUN_WORKFLOW` message parameter
- Existing API endpoints unchanged
- New endpoints are additive
- Linear execution supported throughout until Phase 4 deprecation

---

## File Structure Summary

```
backend/
├── ai/
│   ├── agent_prompts.py          # NEW: prompt templates
│   ├── client.py                 # existing
│   └── prompts.py                # existing
├── services/
│   ├── agent_models.py           # NEW: Pydantic data structures
│   ├── agent_service.py          # NEW: main agent service
│   ├── execution_service.py      # existing
│   ├── healing_service.py        # existing
│   └── audit.py                  # existing
├── api/v1/
│   ├── agent.py                  # NEW: agent API endpoints
│   └── runs.py                   # existing (unchanged)
├── tests/
│   └── unit/
│       └── test_agent_service.py     # NEW: unit tests (11 tests)

extension/
├── src/
│   ├── content/
│   │   ├── capture.ts            # MODIFIED: add capturePageContext()
│   │   └── index.ts              # MODIFIED: add CAPTURE_PAGE_CONTEXT, EXECUTE_AGENT_COMMAND handlers
│   ├── background/
│   │   ├── command-executor.ts   # NEW: command executor
│   │   ├── service-worker.ts     # MODIFIED: add agent-driven loop + executeAgentRun()
│   │   ├── api.ts                # MODIFIED: add agent endpoints (poll, result, decisions, action)
│   │   └── orchestrator.ts       # existing
│   └── shared/
│       ├── types.ts              # MODIFIED: add agent types (AgentCommand, AgentDecision, PageContext, etc.)
│       └── messaging.ts          # MODIFIED: add CAPTURE_PAGE_CONTEXT, EXECUTE_AGENT_COMMAND messages
```

---

## Success Criteria

1. **Runs complete successfully** even when selectors change between recording and replay
2. **AI agent makes intelligent decisions** at each step (EXECUTE, SKIP, RETRY, HEAL, ADAPT, PAUSE)
3. **Plan updates work** — agent can add/remove/modify steps dynamically
4. **Loops are supported** — pagination, repeated extraction, conditional execution
5. **Backward compatibility maintained** — linear execution still works
6. **Audit trail is complete** — every agent decision logged
7. **Performance is acceptable** — <2s decision latency for 95% of steps
8. **Cost is controlled** — deterministic fast path reduces LLM calls by 70%+
