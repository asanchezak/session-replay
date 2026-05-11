# PRD — AI Browser Workflow Runtime

## 1. Product summary

Build a reusable, generic browser-automation platform that records human browser actions, converts them into durable workflows, replays them against web applications, self-heals when page structure changes, and synchronizes all relevant data with a backend system of record (initially Odoo, but designed to support other systems later).

The product must work as a **browser extension + backend service** running in Docker, with Python as the primary backend language. The browser extension should use the authenticated user’s existing session in the browser. The system must support human-in-the-loop intervention when a login challenge, CAPTCHA, unexpected modal, or other blocking condition appears.

The core value is not scraping alone. The core value is **workflow intelligence**: recording, understanding, replaying, auditing, and adapting browser-based workflows.

## 2. Product goals

* Record browser workflows with rich context, not just selectors.
* Replay workflows reliably across UI changes.
* Use AI only where deterministic logic fails or is ambiguous.
* Keep a full, append-only audit trail of everything the system does.
* Integrate with Odoo through a generic adapter layer.
* Support a reusable architecture so the same runtime can later work with other systems besides Odoo.
* Provide human intervention and resumption when the workflow cannot continue automatically.
* Be deployable with Docker.
* Use Python for backend orchestration, AI services, and integrations.

## 3. Non-goals

* Do not build a product tied only to one website or one use case.
* Do not make the system dependent on brittle CSS selectors only.
* Do not require the backend to control the browser directly for every action.
* Do not assume full autonomy in all situations; the system must pause safely when human input is required.
* Do not optimize for stealth, concealment, or bypassing platform protections.

## 4. Primary user stories

1. As a recruiter or operations user, I can record a browser workflow once and replay it later.
2. As a user, I can add a prompt describing the intent of the workflow after recording it.
3. As a system, I can infer the meaning of each recorded step and store it for future recovery.
4. As a user, I can sync jobs, tasks, or records from Odoo into the browser workflow engine.
5. As a user, I can run a search workflow that extracts candidate or record data from a web app and syncs it back to Odoo.
6. As a user, I can see an audit trail of every action, decision, failure, and recovery attempt.
7. As a user, I can pause the workflow when the system encounters a CAPTCHA, login challenge, or ambiguous state, then resume after I intervene.
8. As a platform owner, I can add new connectors and capabilities without rewriting the core runtime.

## 5. System overview

The product has four major layers:

### 5.1 Browser extension

The extension runs in the user’s browser and is responsible for:

* capturing user actions,
* collecting page context,
* replaying recorded steps,
* detecting failures and challenges,
* pausing and resuming workflows,
* communicating with the backend.

### 5.2 Backend orchestrator

A Python service running in Docker that is responsible for:

* workflow persistence,
* event ingestion,
* orchestration and retries,
* audit logging,
* AI-assisted recovery,
* integrations with Odoo and future systems,
* API exposure to the extension.

### 5.3 AI services

AI is used only for:

* intent interpretation,
* workflow summarization,
* selector recovery,
* page-change diagnosis,
* extraction assistance,
* candidate/record ranking when relevant.

### 5.4 Data and observability layer

Stores:

* event logs,
* workflow definitions,
* screenshots,
* DOM snapshots,
* accessibility trees,
* recovered selectors,
* execution traces,
* structured outputs,
* human interventions.

## 6. Key product principles

1. **Deterministic first, AI second.** Use deterministic execution and fallback logic before invoking AI.
2. **Intention over selector.** Every recorded action should include the purpose of the action.
3. **Audit everything.** Nothing important should happen without being logged.
4. **Human control always exists.** The user can interrupt and resume at any point.
5. **Reusable by design.** Odoo is only the first adapter.
6. **Composable capabilities.** The core runtime works via capabilities such as search, open, extract, paginate, fill_form, submit, wait, and resume.

## 7. Functional requirements

### 7.1 Recording

The extension must record:

* click, type, select, submit, scroll, navigation, hover, copy, paste, tab change,
* target element metadata,
* visible text around the element,
* accessibility role/label/name,
* DOM ancestry and siblings,
* URL and page title,
* screenshot before and after the action,
* timestamp,
* user-added note if available,
* inferred intent if possible.

The recorder must allow the user to append a high-level prompt after a recording session. That prompt becomes part of the workflow metadata and should be used for AI interpretation later.

### 7.2 Replay

The system must replay recorded workflows using a priority chain:

1. accessibility-based target matching,
2. stable attributes,
3. text anchors,
4. semantic matching,
5. DOM proximity,
6. visual fallback.

### 7.3 Self-healing

If a selector fails, the system must:

* capture current page state,
* compare with the last known good state,
* attempt deterministic recovery,
* attempt semantic recovery,
* attempt AI-assisted recovery,
* validate the recovered target,
* retry safely,
* log every attempt.

### 7.4 Human intervention

The system must detect when it cannot safely continue, including:

* CAPTCHA,
* login prompt,
* 2FA challenge,
* unexpected modal,
* missing element after retries,
* page layout changed too much,
* ambiguous result set.

When this happens, the system must:

* pause the workflow,
* send a visible alert to the user,
* bring the browser window to the foreground if possible,
* show the reason for the pause,
* wait for user confirmation or correction,
* resume from a checkpoint.

### 7.5 Odoo integration

The backend must expose a generic adapter interface that can connect to Odoo first, but also later to other systems.

Minimum adapter actions:

* list_open_jobs
* get_job_details
* list_candidates
* upsert_candidate
* update_candidate_status
* create_workflow_request
* append_audit_event
* attach_artifact
* get_search_criteria
* create_review_task

The adapter should be implemented as a separate module so the core runtime is not coupled to Odoo-specific logic.

### 7.6 Audit trail

Every execution must generate an append-only log with:

* workflow id,
* user id,
* browser session id,
* action id,
* page url,
* page title,
* action intent,
* target details,
* execution result,
* AI calls and outputs,
* recovery attempts,
* user interventions,
* timestamps,
* artifacts references.

### 7.7 Search and extraction

The system must support extraction of structured data from search results and detail pages.

The extractor should produce both:

* raw structured output,
* normalized records for backend sync.

### 7.8 Workflow templates

The system must allow reusable workflow templates such as:

* search and extract,
* open and inspect,
* fill and submit,
* list and rank,
* recover and resume.

### 7.9 Promptable workflows

A workflow should be describable from:

* recorded steps,
* a human prompt,
* page context,
* expected outcomes.

The system should be able to turn that into a runnable workflow definition.

## 8. Non-functional requirements

* Must run in Docker.
* Must use Python backend services.
* Must support structured logs and traceability.
* Must persist workflow history long-term.
* Must be modular enough to support other target systems later.
* Must be secure by default.
* Must support rate limiting and safe retries.
* Must be testable with repeatable browser automation tests.
* Must be observable and debuggable.

## 9. Suggested architecture

### 9.1 Browser extension

Recommended stack:

* TypeScript
* Manifest V3
* React for the popup/panel UI
* content scripts for DOM capture and interaction
* background service worker for orchestration

Responsibilities:

* record events,
* inject workflow controls,
* display status,
* pause/resume,
* communicate with backend,
* capture screenshots and metadata,
* detect likely challenge states.

### 9.2 Python backend

Recommended stack:

* FastAPI for API services,
* Pydantic for schemas,
* PostgreSQL for durable storage,
* Redis for queueing and locks,
* Celery or RQ for background tasks,
* object storage for screenshots and snapshots,
* vector database or pgvector for semantic memory.

### 9.3 AI services

Split into separate logical modules:

* planner,
* summarizer,
* selector healer,
* extractor,
* classifier,
* policy advisor.

### 9.4 Core runtime services

* Workflow service
* Recorder service
* Replay service
* Audit service
* Adapter service
* Human-in-the-loop service
* Artifact service
* Test service

## 10. Data model

### 10.1 Workflow

* id
* name
* description
* prompt
* source_system
* target_system
* created_by
* created_at
* status
* version

### 10.2 WorkflowStep

* id
* workflow_id
* step_index
* action_type
* intent
* selector_primary
* selector_fallbacks
* accessibility_metadata
* text_anchors
* dom_context
* visual_context
* success_condition
* failure_condition
* ai_hint

### 10.3 ExecutionRun

* id
* workflow_id
* user_id
* browser_session_id
* status
* started_at
* ended_at
* current_step
* pause_reason
* error_summary

### 10.4 EventLog

* id
* run_id
* step_id
* event_type
* payload_json
* created_at
* hash
* previous_hash

### 10.5 Artifact

* id
* run_id
* type
* uri
* checksum
* metadata_json
* created_at

### 10.6 CandidateOrRecord

* id
* source_system_id
* name
* profile_url
* title
* company
* location
* skills
* summary
* ranking_score
* status
* raw_payload_json

### 10.7 HumanIntervention

* id
* run_id
* reason
* user_action
* resolution_notes
* resumed_at

## 11. API contract between extension and backend

The extension and backend should communicate through a versioned API.

### Required endpoints

* POST /v1/events/record
* POST /v1/workflows
* GET /v1/workflows/{id}
* POST /v1/workflows/{id}/run
* POST /v1/runs/{id}/pause
* POST /v1/runs/{id}/resume
* POST /v1/runs/{id}/checkpoint
* POST /v1/recovery/suggest
* POST /v1/extract
* POST /v1/integrations/odoo/sync
* GET /v1/audit/{run_id}

### Event payload must include

* browser session id,
* workflow id,
* step id if available,
* url,
* action type,
* target metadata,
* screenshots references,
* timing,
* result,
* error if any.

## 12. Workflow execution model

Use a state machine.

States:

* idle
* recording
* validated
* queued
* running
* waiting_for_user
* recovering
* failed
* completed
* canceled

Transitions must be explicit and logged.

## 13. AI recovery requirements

The AI recovery engine must receive:

* current DOM,
* accessibility tree,
* screenshot,
* last successful known state,
* workflow step intent,
* fallback selector set,
* previous recovery attempts.

It must return:

* best matching candidate target,
* confidence score,
* explanation,
* recommended next action,
* whether human confirmation is required.

The system should never silently execute a low-confidence recovery without logging it.

## 14. Testing requirements

### 14.1 Unit tests

* schema validation,
* adapter mapping,
* workflow state transitions,
* audit log generation,
* selector ranking logic,
* recovery heuristics,
* pause/resume logic.

### 14.2 Integration tests

* extension ↔ backend communication,
* Odoo adapter calls,
* event persistence,
* artifact upload,
* resume after pause,
* AI recovery pipeline.

### 14.3 Browser automation tests

Use Playwright as the primary browser testing framework.

Recommended approach:

* run the browser in Docker,
* mount test fixtures,
* mock or stub backend endpoints when needed,
* execute recorded workflows against controlled test pages,
* verify screenshots, DOM state, and network calls,
* validate that recovery works when the DOM changes.

### 14.4 “MIP-style” replay tests

If the implementation uses a structured action protocol, every workflow step should be replayable from a machine-readable action record.

Each test should verify:

* the action record is sufficient to replay,
* the replay succeeds on the same page,
* the replay can recover from at least one synthetic DOM change,
* the audit trail is complete,
* human pause/resume is triggered correctly when required.

### 14.5 Regression tests for page changes

For every supported page template, maintain:

* baseline snapshot,
* changed snapshot,
* expected recovered target,
* expected output.

### 14.6 End-to-end tests

The full E2E path should cover:

1. record a workflow,
2. add a prompt,
3. store it in backend,
4. replay it,
5. trigger a page change,
6. recover with fallback/AI,
7. pause for user intervention,
8. resume successfully,
9. sync result to Odoo,
10. verify audit trail completeness.

## 15. Security and privacy requirements

* Do not store raw credentials unless explicitly designed and encrypted.
* Use session-based browser interaction, not credential harvesting.
* Encrypt sensitive data at rest.
* Redact secrets from logs.
* Keep audit logs tamper-evident.
* Provide role-based access control.
* Support retention policies for artifacts and logs.
* Ensure user confirmation for any sensitive final action.

## 16. Observability requirements

Provide dashboards for:

* workflow success rate,
* failure reasons,
* recovery success rate,
* human intervention rate,
* execution latency,
* AI token usage,
* per-site reliability,
* selector health,
* change detection frequency.

## 17. Deployment requirements

Use Docker Compose for local development and an extendable container setup for production.

Suggested containers:

* extension test harness / local web app
* backend API
* worker
* PostgreSQL
* Redis
* object storage
* vector store
* Playwright test runner

The system should be able to run locally with a developer onboarding script and a single `docker compose up` command.

## 18. Reusability requirements

The product must be generic enough that the same workflow runtime can support:

* Odoo,
* recruitment systems,
* CRM tools,
* email tools,
* admin portals,
* data-entry systems,
* any authenticated web app with a stable UI.

To achieve this, the product must separate:

* browser execution,
* workflow logic,
* system adapters,
* AI recovery,
* audit logging.

## 19. Success criteria

The product is successful if it can:

* record a real workflow once and replay it reliably,
* recover from page structure changes,
* pause for human input when needed,
* maintain a complete audit trail,
* synchronize with Odoo or another source system,
* remain reusable across multiple web applications,
* be testable end-to-end with Playwright,
* run in Docker with a Python backend.

## 20. Build prompt for an AI coding agent

Use the following prompt to generate the product:

> Build a generic browser workflow runtime with a Chrome extension and a Python backend in Docker. The extension must record actions with rich context, replay workflows, pause for human intervention, and send structured events to the backend. The backend must store workflows, execution logs, artifacts, and recovery state; expose a versioned API; support Odoo through a generic adapter layer; and use AI only for planning, summarization, extraction, and self-healing. Implement strong audit logging, tamper-evident event streams, a state machine for runs, and a deterministic-first execution model. Use Playwright for automated end-to-end tests and include regression tests for DOM changes. The product must be reusable for multiple web apps, not tied to one site. Prioritize reliability, observability, and maintainability over stealth or mass automation.

## 21. Definition of done

* The extension can record and replay a workflow.
* The backend stores all actions, screenshots, and state changes.
* The system can pause and resume after human intervention.
* The workflow can recover from a changed page structure.
* The Odoo adapter can sync jobs and candidates.
* The test suite can run end-to-end in Docker with Playwright.
* The architecture supports future connectors without major refactoring.
