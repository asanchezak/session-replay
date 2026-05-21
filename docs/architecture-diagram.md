# Architecture Diagram

```mermaid
graph TB
    subgraph Browser["🌐 Browser"]
        subgraph Extension["Chrome Extension (MV3)"]
            direction TB
            Popup["Popup (React 19)"]
            Panel["Side Panel (React 19)"]
            Content["Content Script<br/>capture.ts · replay.ts · dom.ts<br/>selectors.ts · extraction.ts"]
            SW["Service Worker<br/>service-worker.ts · orchestrator.ts<br/>executor.ts · command-executor.ts<br/>healer.ts · detector.ts"]
            Shared["Shared Types<br/>types.ts · messaging.ts · logger.ts"]
        end
        
        WebPage["Target Web Page<br/>(LinkedIn, etc.)"]
    end

    subgraph Backend["Backend (Python 3.12 · FastAPI)"]
        direction TB
        API["API Layer (FastAPI)<br/>api/v1/<br/>agent.py · runs.py · workflows.py<br/>events.py · audit.py · connectors.py"]
        
        subgraph Services["Services"]
            AgentService["AgentService<br/>poll · report_result<br/>recovery cycles · AI orchestration"]
            ExecutionService["ExecutionService<br/>create_run · transition<br/>advance_step · goal_progress"]
            HealingService["HealingService<br/>suggest_heal · apply_plan_update<br/>recover"]
            RecoverySupervisor["RecoverySupervisor<br/>30s poll · auto-resume<br/>capped at 5 attempts"]
            LearningService["LearningService<br/>EMA selector stability<br/>cross-run learning"]
            AIOutcomeService["AIOutcomeService<br/>decision telemetry<br/>run_summary"]
            AuditService["AuditService<br/>SHA-256 hash chain<br/>nonce · tamper evidence"]
            WorkflowService["WorkflowService<br/>CRUD · steps management"]
        end
        
        subgraph AI["AI Layer"]
            AIClient["AI Client<br/>OpenAIProvider / MockProvider<br/>tool-use support"]
            Prompts["Prompt Builders<br/>agent decision · heal<br/>classify · extract"]
            AgentTools["Tool Definitions<br/>execute · wait · skip<br/>restart · rollback · update_plan"]
        end
        
        subgraph Models["ORM Models (SQLAlchemy async)"]
            Run["ExecutionRun<br/>workflow_snapshot · goal_progress<br/>ai_conversation · status"]
            Workflow["Workflow / WorkflowStep<br/>selector_stability_score<br/>heal_count"]
            EventLog["EventLog<br/>SHA-256 chain with nonce"]
            AIDecision["AIDecisionOutcome<br/>confidence · outcome<br/>latency · reasoning"]
            Artifact["Artifact<br/>screenshots · DOM snapshots"]
            Connector["ConnectorConfig"]
        end
        
        Adapters["Adapters<br/>Odoo · Registry<br/>(future: Salesforce, HubSpot)"]
        Database[("PostgreSQL<br/>(SQLite in tests)")]
        Storage[("Object Storage<br/>fsspec · S3/MinIO")]
    end

    subgraph Frontend["Frontend (React 19 · Vite 6)"]
        direction TB
        Router["React Router 7<br/>Dashboard · Workflows · Runs<br/>Audit · Connectors · Settings"]
        
        subgraph Pages["Pages"]
            Dashboard["DashboardPage<br/>KPIs · alerts · recent runs"]
            Workflows["WorkflowsPage / WorkflowDetailPage"]
            Runs["RunsPage / RunDetailPage / TracePage"]
            Audit["AuditPage"]
            ConnectorsPg["ConnectorsPage"]
        end
        
        subgraph Components["Components"] 
            StatusBadge["StatusBadge<br/>10 run states · 3 workflow states"]
            InterventionModal["InterventionModal"]
            PhaseTimeline["PhaseTimeline"]
            DataTable["DataTable"]
            Card["Card"]
            Banner["Banner"]
            EmptyState["EmptyState"]
        end
        
        Hooks["Hooks<br/>useApi · useApiData<br/>useWorkflows · useRuns"]
        AppShell["AppShell<br/>sidebar + top bar<br/>5s poll for interventions"]
    end

    subgraph Observability["Observability"]
        Seq["Seq (Docker)<br/>http://localhost:8082<br/>all layers log here"]
        Debug["/v1/debug/logs<br/>extension log viewer"]
    end

    %% Data flows
    Content <-->|"RECORD_EVENT /<br/>EXECUTE_COMMAND /<br/>CAPTURE_PAGE_CONTEXT"| SW
    Popup <-->|"chrome.storage.session<br/>onChanged"| SW
    Panel --- Popup
    Content --- WebPage
    
    SW <-->|"HTTPS / JSON"| API
    Frontend <-->|"HTTPS / JSON<br/>X-API-Key auth"| API
    
    API --> AgentService
    API --> WorkflowService
    API --> ExecutionService
    API --> HealingService
    
    AgentService --> AIClient
    AgentService --> Prompts
    AgentService --> AgentTools
    AgentService --> ExecutionService
    AgentService --> HealingService
    AgentService --> AuditService
    AgentService --> AIOutcomeService
    
    ExecutionService --> LearningService
    ExecutionService --> AIOutcomeService
    ExecutionService --> AuditService
    
    RecoverySupervisor --> ExecutionService
    RecoverySupervisor --> AgentService
    
    Services --> Models
    Models --> Database
    Services --> Adapters
    Services --> Storage

    Router --> Pages
    Pages --> Components
    Pages --> Hooks
    Hooks --> API
    AppShell --> Router
    
    SW --> Seq
    API --> Seq
    Frontend --> Seq
    API --> Debug
    Debug --> Seq
```

## Layer Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        USER (Operator)                              │
├─────────────────────┬───────────────────────┬───────────────────────┤
│   Extension Popup   │   Frontend Dashboard   │   Side Panel          │
│   (compact control) │   (mission control)    │   (expanded view)     │
├─────────────────────┴───────────────────────┴───────────────────────┤
│                        HTTPS / JSON + X-API-Key                      │
├─────────────────────────────────────────────────────────────────────┤
│                          BACKEND (FastAPI)                           │
│                                                                     │
│   ┌──────────────┐  ┌──────────────┐  ┌─────────────────────────┐  │
│   │  API Routes  │  │   Services   │  │   AI Layer (OpenAI)     │  │
│   │  (15 modules)│──│  (24 modules)│──│  client · prompts ·     │  │
│   │              │  │              │  │  tools · tool-use loop   │  │
│   └──────────────┘  └──────────────┘  └─────────────────────────┘  │
│                           │                                         │
│   ┌──────────────────────┴──────────────────────────────────────┐  │
│   │  ORM Models (17) · SQLAlchemy async · PostgreSQL/SQLite    │  │
│   │  Adapters (Odoo + Registry) · fsspec Storage               │  │
│   └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## State Machine

```
idle → recording → validated → queued → running ──→ waiting_for_user
                                                  ├──→ recovering
                                                  ├──→ completed
                                                  ├──→ failed
                                                  └──→ canceled
```

## Autonomy Stack (Phases 0–6)

| Phase | Layer | Mechanism |
|-------|-------|-----------|
| L0 | Deterministic | Fast-path EXECUTE (no AI key) |
| L1 | AI-first poll | AI consulted on every agent poll |
| L2 | Goal-first cursor | goal_progress · PageDiff |
| L3 | PlanUpdate ops | INSERT/REMOVE/MODIFY/REORDER steps mid-run |
| L4 | Recovery supervisor | 30s poll, 5 attempt cap |
| L5 | Telemetry + Learning | AIDecisionOutcome · EMA stability scores |
| L6 | Tool-use AI | OpenAI tool calling with inner loop |
