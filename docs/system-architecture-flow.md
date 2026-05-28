# System Architecture — Data Flows

> A flow-oriented view of the session-replay system. Components are organized by layer; numbered paths show how data moves between them during each operation mode.

## 1. System Layers

```mermaid
flowchart TB
    subgraph EXT["BROWSER EXTENSION"]
        CS["Content Script<br/>capture · replay · extraction"]
        SW["Service Worker<br/>poll loop · orchestrator · executor"]
        UI["Popup / Panel (React 19)"]
    end
    subgraph BE["BACKEND (FastAPI)"]
        API["API Layer"]
        SVC["Services<br/>Agent · Execution · Healing<br/>ApplicantPush · Audit"]
        AI["AI Layer<br/>LLM client · PlanUpdate"]
        DB[("PostgreSQL")]
    end
    subgraph FE["FRONTEND (React 19)"]
        PAGES["Pages<br/>Dashboard · Workflows · Runs"]
    end
    subgraph EXT_SYS["EXTERNAL"]
        ODOO["Odoo ERP"]
        PAGE["Target Page<br/>LinkedIn / jobs"]
        DAEMON["Driver Daemon"]
        SEQ["Seq (logging)"]
    end
```

## 2. Recording

```mermaid
flowchart LR
    PAGE["Target Page"] -->|"user clicks / inputs"| CS["Content Script"]
    CS -->|"ActionEvent"| SW["Service Worker"]
    SW -->|"POST /v1/events"| API["API Layer"]
    API -->|"EventLog.append"| DB[("PostgreSQL")]
```

## 3. Replay (AI Poll Loop)

```mermaid
flowchart TD
    subgraph loop["Replay Cycle (~2-5s per step)"]
        direction TB
        SW0["Service Worker"] -->|"1. capture page state"| CS0["Content Script"]
        CS0 -->|"PageContext"| SW0
        SW0 -->|"2. POST /agent/{id}/poll"| API0["API Layer"]
        API0 -->|"3. LLM decision"| AI0["AI Layer"]
        AI0 -->|"4. AgentDecision"| SVC0["Services"]
        SVC0 -->|"5. return command"| API0
        API0 -->|"6. execute step"| SW0
        SW0 -->|"7. POST /agent/{id}/result"| API0
        API0 -->|"8. advance + log"| DB0[("PostgreSQL")]
        SW0 -.->|"9. loop"| SW0
    end
    SVC0 -.->|"on step fail → heal"| AI0
    AI0 -.->|"new selector"| DB0
```

## 4. Recruitment Automation

```mermaid
flowchart LR
    ODOO["Odoo ERP"] -->|"publish job · webhook"| API["API Layer"]
    API --> SVC["Services<br/>create run with origin"]
    SVC --> DB[("PostgreSQL")]
    DAEMON["Driver Daemon"] -->|"poll 5s"| API
    DAEMON -->|"drive Chrome"| PAGE["Target Page"]
    PAGE -->|"scrape profiles"| DAEMON
    DAEMON -->|"POST extraction"| API
    API -->|"complete run"| DB
    SVC ==>|"on COMPLETED + origin=new_job_position"| LAPS["ApplicantPush<br/>Service"]
    LAPS -->|"POST /akcr/api/linkedin_applicant"| ODOO
    ODOO -->|"Easy Recruit scoring"| ODOO
```

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
