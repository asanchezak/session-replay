# System Architecture — Data Flows

> A flow-oriented view of the session-replay system. Components are organized by layer; numbered paths show how data moves between them during each operation mode.

```mermaid
flowchart TB
    %% ─── Styles ───
    classDef ext fill:#1A1D27,stroke:#6C5CE7,color:#E8EAED,stroke-width:2
    classDef be  fill:#1A1D27,stroke:#00B894,color:#E8EAED,stroke-width:2
    classDef fe  fill:#1A1D27,stroke:#74B9FF,color:#E8EAED,stroke-width:2
    classDef extSys fill:#1A1D27,stroke:#FDCB6E,color:#E8EAED,stroke-width:2
    classDef store fill:#1A1D27,stroke:#74B9FF,color:#E8EAED,stroke-width:2

    %% ═══════════════════════════════════════════════
    %% LAYER 1: BROWSER EXTENSION
    %% ═══════════════════════════════════════════════
    subgraph EXT["🌐 BROWSER EXTENSION"]
        CS["Content Script<br/>capture · replay · extraction<br/>challenge detection"]
        SW["Service Worker<br/>poll loop · orchestrator<br/>executor · healer"]
        UI["Popup / Panel<br/>React 19"]
    end

    %% ═══════════════════════════════════════════════
    %% LAYER 2: BACKEND
    %% ═══════════════════════════════════════════════
    subgraph BE["⚙️ BACKEND (FastAPI · port 8081)"]
        API["API Layer<br/>15 route modules"]
        SVC["Services<br/>AgentService · ExecutionService<br/>HealingService · RecoverySupervisor<br/>WebhookTrigger · ApplicantPush<br/>AuditService · LearningService"]
        AI["AI Layer<br/>LLM client · prompt builders<br/>tool-use · PlanUpdate"]
        DB[("PostgreSQL<br/>JSONB · Alembic")]
    end

    %% ═══════════════════════════════════════════════
    %% LAYER 3: FRONTEND
    %% ═══════════════════════════════════════════════
    subgraph FE["🖥️ FRONTEND (React 19)"]
        PAGES["Pages<br/>Dashboard · Workflows · Runs<br/>Audit · Connectors · Settings"]
        COMP["Components<br/>StatusBadge · DataTable · Timeline<br/>InterventionModal · Cards"]
        HOOKS["Hooks<br/>useApi · useApiData · useRuns"]
    end

    %% ═══════════════════════════════════════════════
    %% LAYER 4: EXTERNAL SYSTEMS
    %% ═══════════════════════════════════════════════
    subgraph EXT_SYS["🔗 EXTERNAL"]
        ODOO["Odoo ERP<br/>webhooks · Easy Recruit<br/>hr.applicant"]
        PAGE["Target Page<br/>LinkedIn / jobs<br/>content script injected"]
        DAEMON["Driver Daemon<br/>Node + Playwright<br/>polls 5s · drives Chrome"]
        SEQ["Seq<br/>centralized logging<br/>all layers"]
    end

    %% ═══════════════════════════════════════════════
    %% FLOW ❶ — RECORDING
    %% ═══════════════════════════════════════════════
    L1["❶ RECORDING"]:::store
    PAGE -->|"user actions"| CS
    CS -->|"ActionEvent"| SW
    SW -->|"POST /v1/events"| API
    API -->|"EventLog.append"| DB

    %% ═══════════════════════════════════════════════
    %% FLOW ❷ — REPLAY (AI poll loop)
    %% ═══════════════════════════════════════════════
    L2["❷ REPLAY (AI poll loop ~2-5s/step)"]:::store
    UI -.->|"▶ Run"| SW
    SW -->|"1. capture page context"| CS
    CS -->|"PageContext"| SW
    SW -->|"2. POST /agent/{id}/poll"| API
    API -->|"3. LLM decision"| AI
    AI -->|"4. AgentDecision"| SVC
    SVC -->|"5. return command"| API
    API -->|"6. command"| SW
    SW -->|"execute step"| CS
    CS -.->|"CDP / Playwright"| PAGE
    SW -->|"7. POST /agent/{id}/result"| API
    API -->|"8. advance + log"| DB
    SW -->|"9. loop"| SW

    %% ═══════════════════════════════════════════════
    %% FLOW ❸ — RECRUITMENT AUTOMATION
    %% ═══════════════════════════════════════════════
    L3["❸ RECRUITMENT AUTOMATION (4-18 min)"]:::store
    ODOO -->|"publish job · webhook"| API
    API -->|"create run + origin"| SVC
    DB -->|"poll 5s"| DAEMON
    DAEMON -->|"drive Chrome"| PAGE
    PAGE -->|"scrape profiles"| DAEMON
    DAEMON -->|"POST extraction"| API
    API -->|"store + complete run"| DB
    SVC -.->|"on COMPLETED · origin=new_job_position"| LABEL["push applicants"]
    LABEL -->|"POST /akcr/api/linkedin_applicant"| ODOO
    ODOO -->|"dedup + Easy Recruit"| ODOO

    %% ═══════════════════════════════════════════════
    %% FRONTEND → API
    %% ═══════════════════════════════════════════════
    PAGES -.->|"HTTPS + X-API-Key"| API

    %% ═══════════════════════════════════════════════
    %% LOGGING
    %% ═══════════════════════════════════════════════
    API -.->|"Layer='backend'"| SEQ
    HOOKS -.->|"POST /v1/logs/client"| SEQ
    SW -.->|"POST /v1/debug/log"| API

    %% ═══════════════════════════════════════════════
    %% HEALING (triggered within replay flow)
    %% ═══════════════════════════════════════════════
    SVC -.->|"step fail → heal"| AI
    AI -.->|"new selector"| DB

## Flow Paths Summary

| # | Path | Trigger | Duration | Key Components |
|---|---|---|---|---|---|
| ❶ | **Recording** | User action on page | Real-time | Content Script → Service Worker → API → EventLog → DB |
| ❷ | **Replay** | "Run" clicked | ~2-5s/step | SW → API → AI → Service → SW → CDP/CS → PAGE → API → DB |
| ❸ | **Recruitment Automation** | Odoo publish webhook | 4-18 min | ODOO → API → DB → DAEMON → CHROME → scrape → LAPS → ODOO |
| — | **Healing** (sub-flow of ❷) | Step fails | 3-10s | Service → AI → new selector → DB → re-execute |
| — | **Recovery Supervisor** (sub-flow of ❷) | Run stale >240s | 30s cycle | background task → AI → Service → resume run |
| — | **Logging** (cross-cutting) | Any event | Continuous | All layers → Seq |

## State Machine

```
          ┌────────────────────────────────────────────┐
          │                                            │
          ▼                                            │
     ┌─────────┐     ┌──────────┐     ┌────────┐     │
     │  IDLE   │────▶│RECORDING │────▶│VALIDATED│     │
     └────┬────┘     └──────────┘     └───┬────┘     │
          │                               │          │
          │             ┌─────────────────┘          │
          │             ▼                            │
          │       ┌──────────┐                       │
          └──────▶│  QUEUED  │                       │
                  └────┬─────┘                       │
                       ▼                             │
                  ┌──────────┐                       │
                  │ RUNNING  │───────────────────────┘
                  └────┬─────┘
                       │
          ┌────────────┼─────────────────┐
          ▼            ▼                 ▼
   ┌────────────────┐ ┌──────────┐ ┌──────────┐
   │WAITING_FOR_USER│ │RECOVERING│ │ COMPLETED │
   └───────┬────────┘ └─────┬────┘ │   (✓)    │
           │                │      └──────────┘
           └──────┬─────────┘      ┌──────────┐
                  ▼                │  FAILED  │
             ┌──────────┐         │   (✗)    │
             │ RUNNING  │         └──────────┘
             │ (resume) │         ┌──────────┐
             └──────────┘         │ CANCELED │
                                  │   (⊘)    │
                                  └──────────┘

WAITING_FOR_USER → RUNNING (human clicks Continue)
WAITING_FOR_USER → RECOVERING (AI auto-recovery)
RECOVERING → RUNNING (recovery succeeded)
RECOVERING → WAITING_FOR_USER (recovery needs human)
RECOVERING → FAILED (recovery exhausted)
```

## Autonomy Stack

| Phase | Layer | Mechanism | Triggers |
|---|---|---|---|
| L0 | Deterministic | Fast-path EXECUTE (no AI key) | `AI_API_KEY` not set |
| L1 | AI-First Poll | LLM consulted every poll | `AI_API_KEY` set (default) |
| L2 | Goal-First Cursor | `goal_progress` phases + intents | Run created with analysis |
| L3 | PlanUpdate Ops | INSERT/REMOVE/MODIFY/REORDER/SIMPLIFY steps | AI decides to adapt mid-run |
| L4 | Recovery Supervisor | 30s background poll, 5-cap auto-resume | Run stale >240s |
| L5 | Telemetry + Learning | `AIDecisionOutcome` + EMA stability scores | Per poll (telemetry) / terminal state (learning) |
| L6 | Tool-Use AI | OpenAI tool calling with inner loop | `execution_mode = "agent"` |

## Key Integration Points

| Integration | Direction | Protocol | Notes |
|---|---|---|---|
| Extension → Backend | Poll/Result | HTTPS + JSON + X-API-Key | Poll every 2-5s during replay |
| Frontend → Backend | REST | HTTPS + JSON + X-API-Key | Vite dev proxy → /v1 |
| Odoo → Backend | Webhook | POST JSON | `new_job_position` event kind |
| Backend → Odoo | Push | POST JSON + X-API-Key | 240s timeout (sync scoring) |
| Extension → Seq | Logging | POST /v1/debug/log | No API key needed |
| Extension ↔ Content | Internal | chrome.runtime.sendMessage | Same-origin message passing |
| Extension ↔ Dashboard | Cross-origin | window.postMessage | Origin-checked |
| Driver Daemon ↔ Backend | REST | HTTPS + JSON + X-API-Key | Polls every 5s |
| Driver Daemon → Chrome | CDP/Playwright | DevTools Protocol | Stealth profile with cookies |
