# Agent-Driven Execution: API Contract & Migration Plan

## 1. Overview

### Current Model (Linear)
The extension owns the execution loop: it fetches workflow steps, executes them sequentially via content script, and reports results to the backend. The backend is passive — it records events and transitions state when told to.

### Target Model (Agent-Driven)
The backend owns the execution loop via an **agent engine**. The extension becomes a thin executor: it polls for commands, executes them in the browser, and reports results with page context. The agent engine decides what to do next based on workflow definition, accumulated context, and (eventually) AI reasoning.

### Key Principle
**Same state machine, different driver.** The run states and transitions don't change. What changes is who decides the next action: the extension's for-loop (linear) or the backend's agent engine (agent).

---

## 2. Data Flow

### Linear (Current)
```
Extension                          Backend
   │                                 │
   ├─ POST /workflows/{id}/run ─────►│
   │◄─ { run_id, steps }────────────┤
   │                                 │
   ├─ For each step:                 │
   │  ├─ execute via content script  │
   │  ├─ POST /runs/{id}/step-result►│
   │  │◄─ { status, next_step }─────┤
   │  └─ continue or break           │
   │                                 │
   ├─ POST /runs/{id}/complete ─────►│
   │◄─ { status: completed }────────┤
```

### Agent-Driven (Target)
```
Extension                          Backend (Agent Engine)
   │                                 │
   ├─ POST /workflows/{id}/run ─────►│  (mode=agent)
   │◄─ { run_id, execution_mode }───┤
   │                                 │
   ├─ POST /agent/{id}/poll ────────►│  + page context
   │◄─ { command: {type, params} }──┤  agent decides next action
   │                                 │
   ├─ execute command in browser     │
   ├─ POST /agent/{id}/result ──────►│  + page context
   │◄─ { acknowledged }─────────────┤  agent processes, queues next
   │                                 │
   ├─ POST /agent/{id}/poll ────────►│  (repeat until complete)
   │◄─ { command: ... }─────────────┤
   │                                 │
   │  ... loop continues ...         │
   │                                 │
   ├─ POST /agent/{id}/poll ────────►│
   │◄─ { command: {type:"complete"}}┤  agent determines run is done
   ├─ (extension marks run complete) │
```

### Hybrid (During Migration)
Both flows coexist. The `execution_mode` column on `execution_runs` determines which flow a run uses. Default is `linear` — zero risk to existing runs.

---

## 3. API Endpoint Definitions

### 3.1 POST `/v1/agent/{run_id}/poll`

Extension polls for the next command to execute. Includes optional page context so the agent can make informed decisions.

**Request:**
```typescript
interface AgentPollRequest {
  extension_version: string;       // e.g. "1.2.0"
  context?: AgentPageContext;      // Current page state (optional but recommended)
}

interface AgentPageContext {
  url: string;
  title: string;
  dom_summary?: {                  // Structured summary, NOT full DOM
    interactive_elements: number;
    has_form: boolean;
    has_table: boolean;
    form_fields?: string[];
    links?: string[];
  };
  challenges?: ChallengeDetection[];
  screenshot_ref?: string;         // SHA-256 of screenshot data
}
```

**Request Example:**
```json
POST /v1/agent/550e8400-e29b-41d4-a716-446655440000/poll
Headers: X-API-Key: <key>

{
  "extension_version": "1.2.0",
  "context": {
    "url": "https://linkedin.com/jobs",
    "title": "Jobs | LinkedIn",
    "dom_summary": {
      "interactive_elements": 42,
      "has_form": true,
      "has_table": false
    },
    "challenges": []
  }
}
```

**Response (command ready):**
```typescript
interface AgentPollResponse {
  run_id: string;
  run_status: RunStatus;
  command: AgentCommand | null;    // null = no command yet, wait
  wait_ms?: number;                // Suggested poll interval (only when command is null)
  metadata?: {
    step_index: number;
    total_steps: number;
    workflow_name: string;
  };
}

interface AgentCommand {
  id: string;                      // Unique command ID (e.g. "cmd_001")
  type: CommandType;
  params: Record<string, unknown>;
  timeout_ms?: number;             // Max execution time (default 15000)
}
```

**Response Example:**
```json
{
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "run_status": "running",
  "command": {
    "id": "cmd_001",
    "type": "click",
    "params": {
      "selector_chain": [
        { "type": "css", "value": "a.jobs-tab" },
        { "type": "text", "value": "Candidates" }
      ],
      "intent": "Navigate to candidates list"
    },
    "timeout_ms": 15000
  },
  "metadata": {
    "step_index": 1,
    "total_steps": 7,
    "workflow_name": "Candidate Search"
  }
}
```

**Response (wait):**
```json
{
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "run_status": "running",
  "command": null,
  "wait_ms": 500,
  "metadata": {
    "step_index": 1,
    "total_steps": 7
  }
}
```

**Error Responses:**
```json
// Run not found
{ "error": { "code": "NOT_FOUND", "message": "Run not found" } }

// Run in terminal state
{ "error": { "code": "RUN_TERMINAL", "message": "Run is 'completed', cannot poll for commands" } }

// Run not in agent mode
{ "error": { "code": "NOT_AGENT_MODE", "message": "Run is in 'linear' mode, use /runs/{id}/step-result" } }
```

---

### 3.2 POST `/v1/agent/{run_id}/result`

Extension reports the result of executing a command. Always includes page context so the agent can assess the outcome.

**Request:**
```typescript
interface AgentResultRequest {
  command_id: string;
  success: boolean;
  error?: string;                  // Error message if success=false
  page_context: AgentPageContext;  // Page state AFTER execution
  execution_data?: {               // Command-specific execution details
    element_found?: boolean;
    selector_used?: { type: string; value: string };
    execution_time_ms?: number;
    extracted_data?: Record<string, unknown>[];
  };
}
```

**Request Example (success):**
```json
POST /v1/agent/550e8400-e29b-41d4-a716-446655440000/result
Headers: X-API-Key: <key>

{
  "command_id": "cmd_001",
  "success": true,
  "page_context": {
    "url": "https://linkedin.com/jobs/candidates",
    "title": "Candidates | LinkedIn",
    "dom_summary": {
      "interactive_elements": 38,
      "has_form": false,
      "has_table": true
    },
    "challenges": []
  },
  "execution_data": {
    "element_found": true,
    "selector_used": { "type": "css", "value": "a.jobs-tab" },
    "execution_time_ms": 342
  }
}
```

**Request Example (failure):**
```json
{
  "command_id": "cmd_002",
  "success": false,
  "error": "Element not found: .candidate-list",
  "page_context": {
    "url": "https://linkedin.com/jobs/candidates",
    "title": "Candidates | LinkedIn",
    "dom_snippet": "<div class='empty-state'>No results</div>",
    "dom_summary": {
      "interactive_elements": 12,
      "has_form": false,
      "has_table": false
    },
    "challenges": []
  }
}
```

**Response:**
```json
{
  "acknowledged": true,
  "next_poll_ms": 500
}
```

**Error Responses:**
```json
// Command not found
{ "error": { "code": "COMMAND_NOT_FOUND", "message": "Command cmd_999 not found for this run" } }

// Duplicate result (idempotent — returns 200)
{ "acknowledged": true, "next_poll_ms": 500, "note": "duplicate" }
```

---

### 3.3 POST `/v1/agent/{run_id}/context` (Optional)

Lightweight endpoint for periodic page context updates without a command result. Useful for challenge detection between commands.

**Request:**
```json
{
  "url": "https://linkedin.com/jobs",
  "title": "Jobs | LinkedIn",
  "dom_summary": { "interactive_elements": 42, "has_form": true },
  "challenges": [{ "type": "captcha", "confidence": 0.95, "description": "reCAPTCHA detected" }]
}
```

**Response:**
```json
{ "acknowledged": true }
```

---

### 3.4 Command Types

| Type | Params | Description |
|---|---|---|
| `navigate` | `{ url: string }` | Navigate to URL |
| `click` | `{ selector_chain, intent? }` | Click element |
| `type` | `{ selector_chain, text, intent? }` | Type text into field |
| `select` | `{ selector_chain, value, intent? }` | Select dropdown option |
| `extract` | `{ schema?, intent? }` | Extract data from page |
| `wait` | `{ condition: string, timeout_ms?: number }` | Wait for condition |
| `screenshot` | `{}` | Capture screenshot |
| `assert` | `{ condition, expected }` | Verify page state |
| `human_intervention` | `{ reason, instructions }` | Pause for human action |
| `heal` | `{ step_index, dom_snippet, old_selectors, intent? }` | Attempt selector healing |
| `complete` | `{}` | Signal run completion |
| `fail` | `{ reason }` | Signal run failure |

---

## 4. Data Model Changes

### 4.1 Migration: Add `execution_mode` to `execution_runs`

```python
# backend/migrations/versions/012_add_execution_mode.py
"""Add execution_mode column to execution_runs

Revision ID: 012
Revises: 011
Create Date: 2025-05-14
"""
from alembic import op
import sqlalchemy as sa

def upgrade():
    op.add_column(
        "execution_runs",
        sa.Column("execution_mode", sa.String(20), nullable=False, server_default="linear"),
    )

def downgrade():
    op.drop_column("execution_runs", "execution_mode")
```

### 4.2 Migration: Create `agent_commands` table

```python
# backend/migrations/versions/013_create_agent_commands.py
"""Create agent_commands table

Revision ID: 013
Revises: 012
Create Date: 2025-05-14
"""
from alembic import op
import sqlalchemy as sa

def upgrade():
    op.create_table(
        "agent_commands",
        sa.Column("id", sa.dialects.postgresql.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("run_id", sa.dialects.postgresql.UUID(), sa.ForeignKey("execution_runs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("command_id", sa.String(64), nullable=False),
        sa.Column("command_type", sa.String(30), nullable=False),
        sa.Column("command_params", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("status", sa.String(20), nullable=False, server_default="issued"),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("timeout_ms", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("run_id", "command_id", name="uq_agent_commands_run_cmd"),
    )
    op.create_index("ix_agent_commands_run_status", "agent_commands", ["run_id", "status"])

def downgrade():
    op.drop_table("agent_commands")
```

### 4.3 New Event Types

Add to `EventType` enum in `backend/core/models/event.py`:

```python
class EventType(str, Enum):
    # ... existing types ...
    agent_command_issued = "agent_command_issued"
    agent_command_completed = "agent_command_completed"
    agent_command_failed = "agent_command_failed"
    agent_context_updated = "agent_context_updated"
```

### 4.4 SQLAlchemy Model

```python
# backend/core/models/agent_command.py
from datetime import datetime
from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from core.models.base import Base, TimestampMixin, UUIDMixin

class AgentCommand(Base, TimestampMixin, UUIDMixin):
    __tablename__ = "agent_commands"

    run_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("execution_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    command_id: Mapped[str] = mapped_column(String(64), nullable=False)
    command_type: Mapped[str] = mapped_column(String(30), nullable=False)
    command_params: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="issued")
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    timeout_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint("run_id", "command_id", name="uq_agent_commands_run_cmd"),
    )
```

---

## 5. State Machine

### No New States Required

The existing state machine handles agent-driven execution perfectly:

```
queued → running → recovering → running → completed
                  → waiting_for_user → running → completed
                  → failed
                  → canceled
```

### What Changes: Who Drives Transitions

| Transition | Linear (Current) | Agent (New) |
|---|---|---|
| queued → running | `POST /runs/{id}` creates run in queued, extension starts | Same, but `execution_mode=agent` |
| running → recovering | Extension calls `/runs/{id}/recover` | Agent engine detects failure, transitions internally |
| recovering → running | Extension calls `/runs/{id}/heal-result` | Agent processes heal result, issues next command |
| running → waiting_for_user | Extension calls `/runs/{id}/pause` | Agent issues `human_intervention` command |
| waiting_for_user → running | Extension calls `/runs/{id}/resume` | Same |
| running → completed | Extension calls `/runs/{id}/complete` | Agent issues `complete` command, extension acknowledges |
| running → failed | Extension calls `/runs/{id}/fail` | Agent issues `fail` command or timeout |

### Agent Engine State Transitions (Internal)

```python
class AgentEngine:
    """Rule-based agent engine (v1). AI-driven in later phases."""

    async def get_next_command(self, run: ExecutionRun, context: PageContext | None) -> AgentCommand | None:
        """Decide the next command based on run state and page context."""
        steps = run.workflow_snapshot.get("steps", [])
        idx = run.current_step_index

        # Check for challenges
        if context and context.challenges:
            challenge = context.challenges[0]
            return AgentCommand(
                type="human_intervention",
                params={
                    "reason": f"{challenge['type']} detected",
                    "instructions": challenge.get("description", "Handle the challenge and continue"),
                }
            )

        # All steps done
        if idx >= len(steps):
            return AgentCommand(type="complete", params={})

        # Map step to command
        step = steps[idx]
        return AgentCommand(
            type=step["action_type"],
            params={
                "selector_chain": step.get("selector_chain", []),
                "value": step.get("value"),
                "intent": step.get("intent"),
            }
        )

    async def process_result(self, run: ExecutionRun, command: AgentCommand, result: AgentResultRequest) -> RunStatus:
        """Process command result and determine next run status."""
        if command.type == "complete":
            return RunStatus.COMPLETED

        if command.type == "human_intervention":
            return RunStatus.WAITING_FOR_USER

        if result.success:
            run.current_step_index += 1
            if run.current_step_index >= run.total_steps:
                return RunStatus.COMPLETED
            return RunStatus.RUNNING

        # Failure
        if result.page_context.get("dom_snippet"):
            return RunStatus.RECOVERING  # Can attempt healing
        return RunStatus.FAILED
```

---

## 6. Error Handling & Retry Logic

### 6.1 Extension-Side Retry

```typescript
// extension/src/background/agent-poller.ts
class AgentPoller {
  private backoffMs = 1000;
  private maxBackoffMs = 30000;

  async poll(runId: string): Promise<void> {
    while (true) {
      try {
        const response = await apiClient.agentPoll(runId, this.getContext());

        if (response.command) {
          const result = await this.executeCommand(response.command);
          await apiClient.agentResult(runId, result);
          this.backoffMs = 1000; // Reset backoff on success
        } else {
          const wait = response.wait_ms ?? this.backoffMs;
          await this.sleep(wait);
        }
      } catch (err) {
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
        log.error(`Agent poll failed, retrying in ${this.backoffMs}ms:`, err);
        await this.sleep(this.backoffMs);
      }
    }
  }
}
```

### 6.2 Backend Error Responses

| Scenario | HTTP Status | Error Code | Message |
|---|---|---|---|
| Run not found | 404 | `NOT_FOUND` | "Run not found" |
| Run in terminal state | 409 | `RUN_TERMINAL` | "Run is 'completed', cannot poll" |
| Wrong execution mode | 409 | `NOT_AGENT_MODE` | "Run is in 'linear' mode" |
| Command not found | 404 | `COMMAND_NOT_FOUND` | "Command {id} not found" |
| Stale command (already completed) | 409 | `COMMAND_STALE` | "Command {id} already completed" |
| Run timeout (no activity > 5 min) | 409 | `RUN_TIMEOUT` | "Run timed out due to inactivity" |

### 6.3 Idempotency

- `POST /agent/{run_id}/result` is idempotent: duplicate reports return `200 { acknowledged: true, note: "duplicate" }`
- Commands are tracked by `command_id` — only the first result is processed
- Poll is safe to retry: if the same command is still pending, it's re-issued

### 6.4 Timeout Handling

- Each command has `timeout_ms` (default 15000)
- If extension doesn't report result within timeout, backend marks command as `expired`
- After 2 expired commands, run transitions to `failed`
- Extension detects timeout locally and reports `{ success: false, error: "timeout" }`

---

## 7. Migration Plan

### Phase 1: Foundation (This Change)

**Scope:** Add infrastructure, simple rule-based agent, both modes coexist.

**Backend changes:**
1. Migration 012: Add `execution_mode` column to `execution_runs`
2. Migration 013: Create `agent_commands` table
3. Add `AgentCommand` model
4. Add new event types to `EventType` enum
5. Implement `POST /v1/agent/{run_id}/poll` endpoint
6. Implement `POST /v1/agent/{run_id}/result` endpoint
7. Implement `POST /v1/agent/{run_id}/context` endpoint
8. Implement `AgentEngine` (rule-based, linear step mapping)
9. Add `AgentService` for command lifecycle management

**Extension changes:**
1. Add `agentPoller.ts` — polling loop for agent mode
2. Add `agentExecutor.ts` — command execution (maps command types to content script actions)
3. Modify `service-worker.ts` — detect `execution_mode` from run response, route to linear or agent flow
4. Add `AgentPageContext` type to `types.ts`

**Testing:**
- Unit tests for `AgentEngine.get_next_command` and `process_result`
- Integration tests for poll → result cycle
- Backward compatibility test: linear runs still work

**Adoption:**
- New runs created via `POST /workflows/{id}/run?mode=agent` use agent mode
- Default remains `linear` — zero risk to existing runs

### Phase 2: Context-Aware Execution

**Scope:** Agent uses page context to make decisions.

**Changes:**
- Agent engine checks `dom_summary` to detect navigation, form completion, etc.
- Agent can skip steps if page state indicates they're already done
- Agent can retry with alternative selectors before reporting failure
- Extension sends `dom_summary` with every poll and result

### Phase 3: AI-Driven Execution

**Scope:** Agent uses AI to decide next action dynamically.

**Changes:**
- Agent engine calls AI with: workflow intent, current step, page context
- AI returns next action (not necessarily the next step in sequence)
- Commands are generated dynamically, not mapped from predefined steps
- Extension becomes pure executor — no step logic

### Phase 4: Full Agent Autonomy

**Scope:** Multi-path workflows, conditional branching, learning from failures.

**Changes:**
- Agent handles conditional logic (if/else based on page state)
- Agent learns from past run failures to improve selector choices
- Linear execution deprecated (still supported but not recommended)

### Rollback Strategy

| Risk | Mitigation |
|---|---|
| Agent endpoints break | Disable via feature flag, linear runs unaffected |
| Migration fails | Rollback migrations drop added columns/tables |
| Agent engine bugs | `execution_mode` defaults to `linear`, opt-in only |
| Extension compatibility | Extension checks `execution_mode` before using agent endpoints |

---

## 8. Testing Strategy

### 8.1 Unit Tests

```python
# backend/tests/unit/test_agent_engine.py

class TestAgentEngineGetNextCommand:
    async def test_returns_click_command_for_first_step(self):
        """Agent issues click command for first workflow step."""

    async def test_returns_complete_when_all_steps_done(self):
        """Agent returns complete command when step_index >= total_steps."""

    async def test_returns_human_intervention_on_challenge(self):
        """Agent pauses for human when challenge detected."""

    async def test_returns_heal_command_on_failure_with_dom(self):
        """Agent attempts healing when failure includes DOM snippet."""


class TestAgentEngineProcessResult:
    async def test_advances_step_on_success(self):
        """Successful command advances current_step_index."""

    async def test_transitions_to_recovering_on_failure_with_dom(self):
        """Failure with DOM snippet triggers recovery."""

    async def test_transitions_to_failed_on_failure_without_dom(self):
        """Failure without DOM snippet marks run as failed."""

    async def test_completes_run_on_complete_command(self):
        """Complete command transitions run to completed."""
```

### 8.2 Integration Tests

```python
# backend/tests/integration/test_agent_api.py

class TestAgentPollEndpoint:
    async def test_returns_command_for_running_agent_run(self):
        """Poll returns next command for a running agent-mode run."""

    async def test_returns_wait_for_linear_run(self):
        """Poll returns error for linear-mode run."""

    async def test_returns_wait_when_no_command_ready(self):
        """Poll returns null command with wait_ms when processing."""

    async def test_idempotent_poll(self):
        """Repeated polls return same command until result reported."""


class TestAgentResultEndpoint:
    async def test_acknowledges_success(self):
        """Result endpoint acknowledges successful command."""

    async def test_idempotent_duplicate_result(self):
        """Duplicate result returns acknowledged with note."""

    async def test_rejects_unknown_command(self):
        """Result for unknown command returns COMMAND_NOT_FOUND."""

    async def test_triggers_recovery_on_failure(self):
        """Failed result with DOM snippet transitions to recovering."""
```

### 8.3 E2E Tests

```typescript
// extension/e2e/test-agent-execution.spec.ts

test('agent-driven run completes all steps', async ({ page, extensionId }) => {
  // Create workflow, start run in agent mode
  // Verify extension polls for commands
  // Verify each command is executed
  // Verify run completes
});

test('agent handles challenge detection', async ({ page, extensionId }) => {
  // Start agent run
  // Inject CAPTCHA into page
  // Verify run pauses for human intervention
  // Verify resume continues execution
});

test('agent recovers from selector failure', async ({ page, extensionId }) => {
  // Start agent run
  // Modify page DOM to break selector
  // Verify agent attempts healing
  // Verify run completes after recovery
});
```

### 8.4 Property Tests

```python
# backend/tests/unit/test_agent_properties.py

class TestAgentStateMachine:
    """Agent runs follow same state transitions as linear runs."""

    async def test_agent_transitions_match_linear(self):
        """For any sequence of events, agent and linear runs reach same final state."""


class TestCommandOrdering:
    """Commands are always sequential, never duplicated."""

    async def test_no_duplicate_commands(self):
        """Backend never issues two commands with same ID."""

    async def test_commands_sequential(self):
        """Command N+1 only issued after result for command N."""
```

---

## 9. File Change Summary

| File | Change |
|---|---|
| `backend/migrations/versions/012_add_execution_mode.py` | New migration |
| `backend/migrations/versions/013_create_agent_commands.py` | New migration |
| `backend/core/models/run.py` | Add `execution_mode` column |
| `backend/core/models/agent_command.py` | New model |
| `backend/core/models/event.py` | Add 4 new event types |
| `backend/services/agent_service.py` | New service: command lifecycle |
| `backend/services/agent_engine.py` | New service: decision engine |
| `backend/api/v1/agent.py` | New router: 3 endpoints |
| `backend/api/v1/__init__.py` | Register agent router |
| `backend/api/v1/workflows.py` | Add `mode` query param to run endpoint |
| `backend/tests/unit/test_agent_engine.py` | New test file |
| `backend/tests/integration/test_agent_api.py` | New test file |
| `extension/src/shared/types.ts` | Add agent types |
| `extension/src/background/agent-poller.ts` | New file: polling loop |
| `extension/src/background/agent-executor.ts` | New file: command executor |
| `extension/src/background/api.ts` | Add agent API methods |
| `extension/src/background/service-worker.ts` | Route to agent or linear flow |
| `extension/e2e/test-agent-execution.spec.ts` | New E2E test file |

---

## 10. Decision Record

| Decision | Rationale |
|---|---|
| Polling over WebSocket | MV3 service workers can't maintain persistent connections reliably. Polling is resilient to SW restarts. |
| Same state machine | No need for new states. The difference is who drives transitions, not what transitions exist. |
| `execution_mode` defaults to `linear` | Zero risk to existing runs. Agent mode is opt-in. |
| Commands persisted in DB | Survives SW restart, enables debugging, supports idempotency. |
| Rule-based agent first | Simpler to implement, test, and debug. AI-driven agent adds complexity that isn't needed for v1. |
| `dom_summary` not full DOM | Reduces payload size. Full DOM only sent when needed (healing, AI analysis). |
| Idempotent result endpoint | Network failures cause retries. Duplicate results must be safe. |
| Backend returns `wait_ms` | Dynamic poll interval based on run state. Reduces unnecessary requests. |
