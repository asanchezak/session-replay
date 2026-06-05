# Application Feature, State, and Permutation Inventory

Generated: 2026-06-05

This inventory is derived from the repository source, documentation, tests, and scripts. It is not a live acceptance report. Browser-facing behavior still needs the live/E2E proof called out in `docs/testing-operator-guide.md`.

## Scope

Scanned surfaces:

- Backend: `backend/api`, `backend/core`, `backend/services`, `backend/ai`, `backend/adapters`, migrations, tests, and scenario tests.
- Extension: Manifest V3 config, background service worker, content scripts, shared modules, popup/panel UI, driver daemon, shared behavior modules, and E2E tests.
- Frontend: React routes, pages, hooks, components, tests, and Vite/Tailwind configuration.
- Operations and docs: `README.md`, `AGENTS.md` instructions supplied in the task, `CLAUDE.md`, `docs/recruitment-automation-flow.md`, `docs/next-iteration-plan.md`, `docs/testing-operator-guide.md`, Makefile targets, deploy/service scripts, and harness scripts.

Excluded from semantic inspection:

- Generated/build/cache folders such as `node_modules`, `dist`, `coverage`, `.venv`, `__pycache__`, Playwright reports, and pytest caches.
- Local debug captures in `extension/.debug/`.
- Secret-bearing deployment values were not inventoried beyond identifying that deployment/runtime configuration files exist.

## System Overview

The application is a browser-workflow recording, replay, recovery, and synchronization system. Its main runtime surfaces are:

- FastAPI backend on port `8081`, exposing `/v1/*` APIs for workflows, runs, agent polling, audit, connectors, artifacts, settings, webhooks, debug logs, AI helpers, and integrations.
- React dashboard/frontend on port `5173`, used to inspect workflows/runs, trigger execution, configure connectors, view audit trails, handle human interventions, and observe daemon/log status.
- Chrome Manifest V3 extension, used to record browser events, analyze pages, replay browser workflows, collect context/screenshots, and bridge dashboard commands into browser tabs.
- Node driver daemon, used for unattended LinkedIn/generic browser automation through Playwright and backend polling.
- Odoo/Easy Recruit integration, used to ingest published jobs, drive LinkedIn sourcing, push extracted applicants/leads, and trigger synchronous Easy Recruit scoring.
- Seq centralized logging at `http://localhost:8082` for backend, frontend, and extension logs.

## Global States and Permutations

### Run State Machine

Defined run statuses:

- `idle`
- `recording`
- `validated`
- `queued`
- `running`
- `waiting_for_user`
- `recovering`
- `failed`
- `completed`
- `canceled`

Allowed transitions:

- `idle -> recording`
- `idle -> queued`
- `idle -> canceled`
- `recording -> validated`
- `recording -> canceled`
- `validated -> queued`
- `validated -> idle`
- `queued -> running`
- `queued -> canceled`
- `queued -> failed`
- `running -> waiting_for_user`
- `running -> recovering`
- `running -> failed`
- `running -> completed`
- `running -> canceled`
- `waiting_for_user -> running`
- `waiting_for_user -> recovering`
- `waiting_for_user -> canceled`
- `waiting_for_user -> failed`
- `recovering -> running`
- `recovering -> waiting_for_user`
- `recovering -> failed`
- `recovering -> canceled`

Terminal states:

- `failed`
- `completed`
- `canceled`

Important run-state permutations:

- A queued run can be claimed by backend/browser execution or daemon execution.
- A queued daemon run can remain queued while waiting for a matching operator, work-hour window, budget, cooldown, or circuit breaker reset.
- A running run can advance step-by-step, complete when the cursor reaches the snapshot length, pause for human action, recover through AI/healing, fail on terminal errors, or be canceled.
- A waiting run can be resumed manually, resumed with AI, canceled, failed, or auto-resumed by `RecoverySupervisor` unless the pause reason is `tab_closed`.
- A recovering run can return to running, pause again, fail, or be canceled.
- `tab_closed` is idempotent for active states and rejected as a resume target until explicitly handled.
- Terminal runs are not resumed by normal start/resume flows.

### Workflow States

Backend workflow statuses:

- `active`
- `archived`

Compatibility/permutation notes:

- Backend update accepts legacy `draft` as `active`.
- Frontend/shared extension types still include `draft`.
- Archived workflows cannot be run or promoted.
- User workflows can be promoted to system workflows unless archived.
- Workflow type is `system` or `user`.
- Workflow execution mode defaults to `generic` in source config, while older migration backfill may use server default `hardcoded`.

### Event Actors and Event Types

Audit/event actors:

- `system`
- `human`
- `ai`
- `extension`

Enum-backed event types:

- `click`
- `type`
- `select`
- `submit`
- `scroll`
- `navigate`
- `hover`
- `copy`
- `paste`
- `tab_change`
- `run_started`
- `run_paused`
- `run_resumed`
- `run_completed`
- `run_failed`
- `run_canceled`
- `checkpoint`
- `workflow_status_changed`
- `recovery_attempt`
- `recovery_success`
- `recovery_failure`
- `intervention`
- `ai_invocation`
- `screenshot`
- `dom_snapshot`

Additional string event types used in services/routes:

- `extraction`
- `step_executed`
- `debug`
- `agent_decision`
- `script_executed`
- `recovery_cycle`
- `run_auto_resumed`
- `run_tab_closed`
- `for_each_expanded`

Audit integrity permutations:

- Events are chained per run by sequence number.
- Each event includes a SHA-256 hash and nonce.
- Unique constraints enforce `(run_id, sequence_number)` and `(run_id, nonce)`.
- Hash verification can return valid or compromised states in audit UI.
- SQLite timestamp precision requires explicit microsecond timestamps for ordered chains.

### Action Types

Core workflow/extension action types:

- `click`
- `type`
- `select`
- `submit`
- `scroll`
- `navigate`
- `hover`
- `copy`
- `paste`
- `tab_change`
- `extract`

Additional backend workflow-step action types:

- `for_each`
- `linkedin_people_search`
- `linkedin_paginate_next`
- `noise_break`
- `open_message_drafts`
- `run_script`
- `noop`

### Selector Types

Selector chain candidates:

- `css`
- `text`
- `accessibility`
- `xpath`
- `anchor`
- `shadow_css`

Selector-resolution permutations:

- Extension capture builds multiple selector types per event.
- Selectors are ordered by stability score during replay.
- Shadow DOM selectors receive the highest score.
- `data-testid` and equivalent stable attributes are preferred over generated IDs/classes.
- Dangerous XPath expressions are rejected.
- Replay can fall back to alternate selectors or fallback methods.
- Selector failure can trigger healing, AI plan update, pause, or fail depending on runtime path.

### Agent Decisions

Backend AI decision types:

- `EXECUTE`
- `SKIP`
- `RETRY`
- `HEAL`
- `ADAPT`
- `WAIT`
- `RESTART`
- `ROLLBACK`
- `PAUSE`
- `COMPLETED`

Agent command action types:

- `navigate`
- `click`
- `type`
- `select`
- `scroll`
- `extract`
- `run_script`

Challenge types:

- `captcha`
- `login_form`
- `two_factor`
- `unexpected_modal`
- `consent_banner`

Precondition types:

- `element_visible`
- `url_matches`
- `text_present`
- `page_loaded`

Plan update operations:

- `INSERT`
- `ADD`
- `REMOVE`
- `MODIFY`
- `REORDER`
- `SIMPLIFY`
- `SKIP`

Safety-limit permutations:

- Retry count, heal count, adapt count, plan updates, wait cycles, run-script count, and no-target repeats are capped.
- `run_script` has explicit timeout and count limits.
- Deterministic-only mode prevents AI consultation and uses fallback behavior.
- Missing AI key routes to mock/fallback provider behavior.
- AI can be consulted with text-only context or vision context depending on screenshot availability and settings.

## Backend Inventory

### Backend Application Shell

Features:

- FastAPI lifecycle initializes database metadata and starts background supervisors.
- Background supervisors include recovery, retention, and Odoo reconciliation.
- Graceful shutdown cancels supervisor tasks.
- CORS is configured from settings and supports comma-string or list input.
- Request ID middleware tags responses and log records.
- API logging middleware records `/v1/*` calls except health checks.
- CSRF origin check applies to unsafe methods when an Origin header is present.
- API key middleware protects all `/v1/*` routes except `/v1/health` and `OPTIONS`.
- In-memory rate limiting is keyed by client IP.
- Normalized exception handlers return top-level `{error: {code, message, details}}`.
- `/v1/health` reports service status and whether AI is configured.

State/permutation coverage:

- Auth success, missing key, invalid key, and health bypass.
- Safe methods vs unsafe methods with/without Origin.
- CORS allowed origins from local dashboard/extension contexts.
- Rate-limit success and limit-exceeded behavior.
- Validation errors, HTTP exceptions, and unexpected exceptions through the normalized error contract.
- Startup with supervisors enabled, disabled by env, or failed/canceled on shutdown.

### Backend Configuration

Runtime settings include:

- Database URL and test database URL.
- Redis URL.
- AI provider, API key, model, base URL, confidence threshold, deterministic-only mode, recovery window, and vision options.
- Backend API key and secret key with insecure-dev warnings.
- CORS origins.
- Rate-limit requests per minute.
- Seq URL.
- Default LinkedIn operator.
- Artifact storage backend, base path, and public base URL.
- Vision maximum image size and baseline/high-detail controls.

Configuration permutations:

- Development defaults vs production overrides.
- AI enabled by `AI_API_KEY`.
- Mock/fallback AI when key is absent.
- Deterministic-only mode overriding AI consultation.
- File artifact storage vs future fsspec backends.
- Localhost backend base URL in extension and frontend proxy must stay aligned.

### Data Models

Workflow model features:

- Workflow metadata: name, description, prompt, target URL, creator, status, type, version, config, execution mode.
- Ordered workflow steps with action, intent, selector chain, value, methods, accessibility metadata, text anchors, DOM context, success/failure conditions, AI hint, checkpoint flag, selector stability score, and heal count.
- Semantic workflow analysis, phases, actions, parameters, output specification, templates, and connector bindings.
- Connector binding uniqueness by workflow and parameter key.

Run model features:

- Workflow snapshot frozen at run creation.
- Current step index and total steps.
- Pause reason, error summary, start/end timestamps.
- Goal progress for phase/intent tracking.
- Extracted data, AI conversation, origin metadata.
- LinkedIn applicant and lead snapshots.

Other persisted models:

- Connector configuration and health status.
- Event log with hash chain.
- Artifact metadata.
- Human intervention.
- Audit outbox.
- Page state snapshot.
- Recovery attempt trace.
- Run summary.
- Application setting.
- Webhook trigger.
- AI decision outcome.
- AI reasoning chain.

Model permutations:

- UUID storage differs between SQLite tests and PostgreSQL migrations.
- JSON is used for SQLite compatibility while migrations target PostgreSQL JSONB.
- Workflow snapshots can contain original steps, substituted steps, analysis data, connector-resolution metadata, confirmation flags, and generated loop expansions.
- Run origin can identify browser, daemon, Odoo webhook, LinkedIn applicant search, LinkedIn lead search, operator routing, and idempotency keys.

### Workflow APIs

Workflow route features:

- Record a workflow from captured events.
- Create/list/get/update/delete workflows.
- Add a workflow step.
- Replace workflow steps.
- Update workflow status.
- Promote a user workflow to system.
- Generate prompt.
- Update selectors.
- Run workflow directly.
- Run workflow with parameters.
- Analyze workflow blueprint.
- Analyze page suggestions and step-level page snapshots.
- Read/update semantic analysis parameters.
- Read output template.
- Create/list/delete/preview connector bindings.

Recording permutations:

- Idempotency key can create a new recording, return a hit, or return a conflict.
- Consecutive duplicate type events on the same primary selector are deduped.
- Navigate value can be backfilled from event URL or target URL.
- Scroll value can be backfilled from scroll position.
- Target text fallback is used when present.
- Action methods are normalized while non-action methods such as extraction shapes are preserved.
- Type steps receive `input_value_contains` success conditions.
- Send-like click steps can receive `visible_text_contains` success conditions from preceding typed value.
- Causal metadata records time since previous event, prior URL, and URL-change causality.
- Semantic analysis runs after recording.
- AI title generation can produce a short workflow title when AI is configured.
- Workflow simplification is implemented but skipped in the current record path.

Workflow status permutations:

- `active` and `archived` are valid backend states.
- Legacy `draft` update maps to `active`.
- Invalid status returns validation error.
- Invalid transition returns conflict.
- Archived workflows cannot be run/promoted.

Run-with-parameters permutations:

- Parameter resolution can run literal, parameterized, semantic, connector-backed, goal-driven, or confirmation-required flows.
- Ambiguous plan resolution can return `409 GOAL_REQUIRED` with questions.
- Browser execution target transitions the run toward active browser replay.
- Daemon execution target leaves a queued run with daemon/operator metadata.
- `load_browser_session` can request session-cookie artifact upload.
- Execution options can target a specific operator or default to configured LinkedIn operator.

### Run APIs

Run route features:

- Create/list/get/delete runs.
- Delete all runs.
- Start, pause, resume, cancel, fail, complete, and rerun.
- Mark tab closed.
- Advance step.
- Return next step.
- Post step result.
- Trigger recover/heal step/heal result.
- Expand `for_each`.
- Read run events.
- Read run message targets.
- Refresh or repush LinkedIn applicants.
- Create/read interventions.
- Store extraction results.
- Store debug events.
- Inject and clear heal overrides for tests.

Run API permutations:

- `start` atomically claims queued runs.
- `pause` and `resume` operate on active/waiting states.
- `tab-closed` is no-op for terminal/queued states and pause-producing for active states.
- `cancel` can be applied to running, queued, waiting, or recovering states from UI.
- `rerun` clones original/substituted snapshot into a new run.
- `step-result` requires running/recovering status and exact current step index.
- Successful step result advances cursor or completes terminally.
- Failed step result fails the run.
- Screenshot payload in step result can create an artifact.
- Interventions dedupe same run/reason inside a five-minute window.
- Extraction appends an extraction event and merges payload into `run.extracted_data`.
- Run event listing supports event-type filtering, limit, and offset.

### Execution Service

Features:

- Creates queued runs from workflow snapshots.
- Stores workflow metadata and original steps.
- Loads semantic analysis into snapshot.
- Seeds goal progress.
- Emits audit event `run_started`.
- Applies execution plans from templates/connector bindings.
- Expands `for_each` loops from extraction events.
- Applies parameter substitutions.
- Adds optional anti-bot noise steps.
- Transitions run statuses through the state machine.
- Records learning and AI outcome summaries on terminal states.
- Triggers post-completion LinkedIn applicant/lead push for matching origins.

`for_each` permutations:

- Data sources can be explicit extraction paths or fallback extraction payloads.
- Items can be URLs, records, or scalar values.
- Candidate count can come from params, origin metadata, or default.
- Items are deduped by URL/canonical identity.
- Inner steps are materialized with `$item` substitution.
- Inner failure policy can continue or propagate depending on config.
- Iteration delay, jitter, cooldown, and random seed can alter timing.
- Noise navigations can be inserted between iterations.
- Expansion is idempotent once a loop step is marked expanded.

Goal-progress permutations:

- Phases can be `pending`, `active`, or `done`.
- Intents can be `pending`, `active`, `satisfied`, or `skipped`.
- Step advancement updates goal progress as execution proceeds.

### Agent and AI Runtime

Features:

- Poll-based agent loop used by extension and daemon.
- AI-first decision path when configured.
- Deterministic fallback path when AI is disabled or skipped.
- Last-chance recovery.
- Vision-aware prompts with screenshots.
- Page-state diff ingestion.
- Tool/function call support.
- Agent decision and outcome persistence.
- Reasoning chain storage.
- Recovery trace storage.

Agent decision permutations:

- `EXECUTE` returns an action command.
- `SKIP` advances without executing current step.
- `WAIT` pauses briefly and polls again.
- `RESTART` moves execution back to a restart point.
- `ROLLBACK` moves execution back to a prior step/checkpoint.
- `PAUSE` creates a human intervention path.
- `COMPLETED` completes the run.
- `ADAPT` applies plan updates.
- `HEAL` attempts selector/plan healing.
- `RETRY` repeats a step within retry limits.

AI provider permutations:

- OpenAI provider with model/base URL from settings.
- Mock provider for missing/local AI configuration.
- Fallback provider behavior on failures.
- Text-only prompt path.
- Vision prompt path with screenshot blocks.
- Tool-call path for execute/wait/skip/restart/rollback/pause/complete/update-plan.

Safety permutations:

- AI recovery window timeout can fail long-running recovery.
- Excess retries/heals/adapts/plan updates can fail or pause a run.
- Fatal `run_script` errors fail.
- Non-fatal wait/no-target repeats can lead to fallback execution or pause.
- Deterministic failure can pause instead of continuing blindly.

### Healing and Recovery

Healing features:

- Redacts sensitive data before AI heal prompts.
- Normalizes selector chains.
- Suggests heal actions using AI.
- Creates human intervention on low-confidence heal.
- Applies plan updates to workflow snapshots.
- Supports modify, simplify, insert, add, remove, skip, and reorder operations.

Recovery supervisor features:

- Periodically scans stale running/recovering/waiting runs.
- Skips terminal and tab-closed runs.
- Auto-completes empty-snapshot runs.
- Caps auto-resume attempts per run.
- Applies AI-assisted remove/modify/navigate/selector healing.
- Transitions recoverable runs back to running.
- Emits recovery-cycle/debug/audit signals.

Recovery permutations:

- Human pause vs AI recovery vs deterministic retry.
- Selector heal success, low confidence, or failure.
- Plan update success or conflict.
- Recovery cap reached.
- Stuck threshold not reached.
- Run older than supervisor window ignored.
- Tab-closed pause ignored by auto-resume.

### Semantic Analysis and Templates

Semantic analysis features:

- AI or heuristic workflow analysis.
- Phase/action extraction.
- Parameter detection.
- Output specification generation.
- Fallback strategies: literal, parameterized, semantic.
- Confidence/ambiguity metadata.

Template features:

- Validates required parameters.
- Substitutes `{parameter}` tokens into values, intents, selectors, DOM context, and success conditions.
- Supports connector-bound parameter resolution.
- Supports `__execution_goal__`.
- Builds literal, parameterized, semantic goal-driven, confirmation-required, validation-failed, and default execution plans.
- Compacts semantic bare scrolls.
- Backfills DOM context.

Template permutations:

- Missing required parameter.
- Connector binding success/failure.
- Connector failure can fail-soft depending on plan path.
- Goal missing for ambiguous workflow.
- Confirmation required with questions.
- Semantic fallback when selectors are weak.
- Literal replay when no parameters are required.

### Connectors and Integrations

Connector API features:

- Create/list/get/update/delete connectors.
- Test connector health.
- Redact sensitive config keys in responses.
- Preserve redacted secret values during update.
- Track healthy/last-error state.

Connector types surfaced in frontend:

- `odoo`
- `salesforce`
- `hubspot`
- `custom`

Implemented backend adapter emphasis:

- Odoo is the primary implemented/tested adapter.

Odoo adapter features:

- JSON-RPC login and `execute_kw`.
- API-key mode.
- Reauthenticate once on access error.
- Resource alias mapping for job, candidate, applicant, department, and employee models.
- List/get/create/update/upsert operations.
- Domain filter tuples.
- Health checks.

Connector binding source:

- `odoo_latest_job`

Supported Odoo-bound fields:

- `job_id`
- `job_title`
- `job_description`
- `job_description_short`
- `job_url`
- `department`
- `company`
- `job_location`
- `seniority_level`
- `employment_model`
- `internal_area`
- `candidate_count`

Connector permutations:

- Healthy vs unhealthy connector.
- Missing required Odoo config.
- Redacted password retained vs replaced.
- Latest job found vs no job found.
- Runtime connector resolution success vs fail-soft fallback.
- Manual sync vs webhook/reconciler-triggered sync.

### Webhooks and Odoo Recruitment Flow

Webhook features:

- Incoming Odoo webhook endpoint by connector ID.
- Workflow trigger creation/list/update/delete.
- Trigger replay.
- Trigger-now manual firing.
- Connector trigger listing.
- Supported event listing.

Supported event kinds:

- `new_job_position`
- `linkedin_lead_search`

Webhook execution permutations:

- Active trigger vs disabled trigger.
- Duplicate idempotency key returns prior/non-terminal behavior.
- Candidate count defaults to 2.
- Candidate count is clamped to valid bounds.
- Odoo URL can be supplied directly or fetched/resolved.
- Missing job description can be fetched from Odoo.
- Run origin stores connector, event kind, trigger, payload, execution mode, execution options, target operator, and idempotency key.
- Auto-created LinkedIn flows are pinned to configured LinkedIn operator unless overridden.
- Trigger fire creates queued daemon run.
- Non-terminal run statuses are considered active for duplicate protection.

Recruitment automation flow:

- Odoo publishes job.
- Backend receives Odoo webhook.
- Backend resolves job fields and creates queued daemon run.
- Driver daemon claims matching run.
- Daemon drives LinkedIn search/profile extraction.
- Backend completes run.
- Applicant push service posts extracted applicants to Odoo.
- Odoo creates `hr.applicant`.
- Easy Recruit scoring runs synchronously in Odoo.

LinkedIn applicant push permutations:

- Only `origin.event_kind == "new_job_position"` triggers applicant push.
- Push skipped when `push_to_odoo` is false.
- Push skipped when connector/job/profile data is missing.
- Profiles are grouped by canonical LinkedIn profile URL.
- First non-empty field wins when merging extraction events.
- Default candidate limit is 2 and configurable up to 25.
- Odoo dedup is by `(job_id, profile_url)`.
- Duplicate push can return an existing-applicant response without overwriting the first row.
- Odoo scoring timeout is intentionally long because scoring is synchronous.
- Push result snapshots are stored on the run.

LinkedIn lead push permutations:

- `origin.event_kind == "linkedin_lead_search"` triggers lead push.
- People arrays are grouped and deduped by canonical profile URL.
- Lead flow does not require profile visits.
- Default max is 50, clamped to 50.
- Explicit candidate count can increase within limits.
- Push result snapshots are stored on the run.

### Artifacts, Logging, Settings, Retention

Artifact features:

- Store screenshots, DOM snapshots, accessibility trees, page captures, flow manifests, session cookies, debug captures, and generic files.
- File-backed storage through fsspec.
- MIME extension mapping for png, jpg, webp, html, json, txt, and xml.
- Artifact metadata list/get/delete.
- Frontend object URL fetching with API key.

Logging features:

- Backend request/service logs.
- Frontend client logs.
- Extension debug logs to `/v1/debug/log`.
- Debug log query by source and time.
- Seq centralization by layer.

Settings features:

- Application settings API for AI threshold, deterministic mode, retention, retry limits, and operator-related values.
- Frontend localStorage operator ID.
- Masked static API-key UI.

Retention features:

- Deletes old events older than configured retention days.
- Deletes terminal runs ended before cutoff.
- Supervisor interval controlled by settings/env.

### Backend Test Coverage Features

Tested backend categories include:

- Full lifecycle E2E.
- Human intervention.
- Error recovery.
- State machine boundaries.
- Concurrent runs.
- Extension event ingestion.
- Checkpoint/recovery.
- Connectors.
- Health/auth.
- Audit tamper detection.
- Large audit chains.
- Duplicate nonce protection.
- Concurrent event appenders.
- Pause/cancel races.
- Deleted workflow queued runs.
- Long pause/resume.
- Odoo pagination/upsert/reauth/health.
- LinkedIn/Odoo invite flow.
- Rerun behavior.
- Rate limits.
- Pagination bounds.
- CORS extension whitelist.
- Migration round-trips.

## Extension Inventory

### Manifest and Build

Features:

- Chrome Manifest V3.
- React 19 popup.
- Panel page.
- Background service worker.
- Content script on all URLs/all frames at `document_idle`.
- Permissions: storage, activeTab, tabs, scripting, sidePanel, alarms, debugger, cookies.
- Host permissions for all URLs.
- Vite build uses `base: "./"`.
- HTML entry files live at extension root.
- Manifest points to `dist/popup.html` and `dist/panel.html`.
- Icons are required at `extension/icons`.

Build/runtime permutations:

- Chrome extension context breaks if Vite emits absolute `/popup.js` paths.
- Root HTML entries are required because Chrome resolves relative to extension root.
- Recent Chrome builds can reject unpacked extension loading; Playwright Chromium channel is preferred for E2E.

### Shared Types and API Client

Shared type features:

- Workflow/run/action/selector/agent payload typing.
- Popup states for idle, goal setting, recording, running, parameterized running, recovering, waiting, failed, and error.
- Agent command typing for navigate/click/type/select/scroll/extract/run_script.
- Page diff typing.
- Artifact typing.

Type mismatches/permutations:

- Extension `WorkflowStatus` includes `draft` while backend is active/archived.
- Extension agent decision union omits some backend decisions such as `RETRY`/`HEAL`.

API client features:

- Session storage for API base URL, API key, and AI API key.
- Development defaults point to local backend.
- Workflow/run/event/agent/artifact/settings methods.
- Run-with-params supports browser or daemon execution target and operator options.
- AI extraction helper.
- Artifact upload.
- Agent poll/result/action/decision APIs.

API permutations:

- Config loaded from session storage vs defaults.
- API key missing vs configured.
- Raw/text/blob responses vs JSON responses.
- Backend error contract vs unexpected network failures.

### Background Orchestrator

Features:

- Records browser events into an in-memory queue.
- Persists queue and recording state to `chrome.storage.session`.
- Sets session storage access level for content scripts.
- Restores active recordings and pending saves after service-worker sleep.
- Caps event queue at 1000.
- Captures screenshots for click, navigate, and select events.
- Stores pending workflow saves before upload.
- Notifies popup state changes.
- Returns null for empty recordings.

Recording permutations:

- Start recording with direct goal or later goal setting.
- Stop recording with queued events.
- Stop recording with no events.
- Service-worker suspension during recording.
- Pending workflow save resumes after restart.
- Screenshot capture succeeds, fails, or is skipped by event type.
- Event buffer overflow truncates older events.

### Background Message Router

Supported message paths:

- Protocol version check.
- Debug log.
- Fetch workflows.
- Run workflow.
- Get run status.
- Run on daemon.
- Analyze page step.
- Analyze live page.
- Record event.
- Start recording.
- Set recording goal.
- Stop recording.
- Add extract step.
- Selection intent.
- Resume run.
- Cancel run.
- Get state.
- Execute step.
- Unknown message fallback.
- External `RUN_WORKFLOW`.

Tab/event features:

- Keepalive alarm every four minutes probes backend/dashboard.
- Tab completion emits navigate events while recording.
- Chrome/internal URLs are ignored.
- Duplicate URL navigation events are ignored.
- Removed tab reports `tab-closed`.
- Extension action opens side panel.

Message permutations:

- Valid protocol vs incompatible protocol.
- Known command success vs command error.
- Missing active tab.
- Browser execution vs daemon execution.
- Dashboard-triggered run vs external-triggered run.
- Tab removed while run active vs inactive.

### Content Capture

Capture features:

- Click target resolution through `elementFromPoint` and composed path.
- Shadow DOM metadata.
- Position anchors.
- Interactive target detection.
- Data attribute, landmark, z-index, shadow, and iframe metadata.
- Click/type/select/scroll/page context event capture.
- Sensitive input redaction.
- File input filename capture.
- Scroll payload with viewport/document/element positions.
- Sanitized/redacted DOM capture.
- Accessibility tree capture.
- Visible text and visible element summaries.
- Blocking captcha/login/modal detection.

Sensitive-data permutations:

- Password fields redacted.
- `autocomplete=current-password`, `new-password`, `cc-number`, and `cc-csc` redacted.
- File inputs record filenames rather than file contents.
- Text inputs preserve non-sensitive typed values for replay.

Event-capture permutations:

- Click, input, change, scroll, dropdown, selection, and navigation events.
- Capture phase with pending input debounce.
- Early events buffered before recording state is loaded.
- Storage-change listener updates recording state without relying only on messages.
- Polling fallback checks storage state.
- Top-frame-only command handling for execution/context messages.

### Selector Generation and Replay

Selector generation features:

- Stable attribute detection.
- Generated ID detection.
- Class filtering.
- CSS selector priority.
- Text selector generation.
- Accessibility selector generation.
- XPath selector generation.
- Anchor selector generation.
- Shadow CSS selector generation.
- Selector stability scoring.

Replay features:

- Selector resolution by score.
- Deep shadow search.
- CSS/text/accessibility/xpath/anchor/shadow CSS support.
- Visibility, enabled, stability, and overlay checks.
- Click, type, select, scroll, hover, and navigate simulation.
- Type retry after delayed input rendering.
- Odoo many2one/autocomplete first-option selection.
- Success-condition evaluation.
- Fallback methods for element failures.

Replay error codes:

- `ELEMENT_NOT_FOUND`
- `NOT_VISIBLE`
- `NOT_ENABLED`
- `NOT_EDITABLE`
- `BLOCKED`
- `UNSTABLE`
- `NAVIGATION_FAILURE`
- `PERMISSION_DENIED`
- `TAB_CLOSED`
- `NETWORK_ERROR`
- `EXECUTION_ERROR`

Replay permutations:

- Primary selector succeeds.
- Primary selector fails and alternate selector succeeds.
- Selector exists but is hidden, blocked, disabled, unstable, or not editable.
- Navigate succeeds, times out, or hits restricted URL.
- Type target appears late and succeeds after retry.
- Odoo autocomplete appears and first option is selected.
- Success condition matches, fails, or is absent.
- Fallback method succeeds or fails.
- Error is retryable or non-retryable.

### Content UI and Extraction

Content UI features:

- Closed Shadow DOM replay panel.
- Non-blocking full-page overlay.
- Selection extraction button.
- Dashboard window-message bridge.
- Autorun through `sr_autorun`.
- Scroll suppression during capture preparation.
- Prepare-for-capture scrolls page to bottom.

Extraction features:

- Schema-less text extraction.
- Empty schema returns page text.
- Candidate extraction from articles/cards/listings/rows/tables.
- Missing field list.
- Page title and URL fallback.
- Selected paragraph extraction.
- Selected text fallback.
- Declarative DOM anchors for LinkedIn profile URLs.
- Shape-aware AI extraction.
- Heuristic legacy comma-list extraction.
- AI fill for missing fields.

Extraction permutations:

- User selects text vs no selection.
- Extract step has no fields vs explicit fields.
- Extract shapes are scalar, string list, record list, or unknown.
- AI configured vs AI missing.
- DOM anchors find data vs AI fallback needed.
- Extraction always reports step success even with partial data.

### Background Service Worker Runtime

Shared runtime features:

- Tracks canceled runs.
- Tracks active overlays.
- Detects challenge pages.
- Blocks restricted URL schemes and internal pages.
- Captures page context and screenshots.
- Supports anti-bot options.
- Sends step results to backend.
- Uploads artifacts.

Analyze Page features:

- Waits for active tab load.
- Captures expanded page data.
- Handles LinkedIn profile same-tab details snapshots.
- Uses iframe/fetch fallback.
- Sends page snapshot suggestions to backend.
- Error codes include `NO_TAB`, `EMPTY_PAGE`, and `TIMEOUT`.

LinkedIn detail capture permutations:

- Profile URL detected vs non-profile page.
- Show-all links clicked by CDP/anchor or direct navigation fallback.
- Section inclusion is probabilistic.
- Maximum section count is capped.
- Human dwell and micro-scroll occur when anti-bot mode is active.

Deterministic workflow execution:

- Creates/runs workflow through backend.
- Pins browser tab to run.
- Navigates to target URL when present.
- Iterates snapshot steps.
- Pauses on challenge.
- Detects navigation mismatch.
- Treats click-caused navigation as success.
- Invokes healing on failure.
- Posts step results.
- Performs final extraction if workflow has no explicit extract step.
- Completes run and returns idle state.

AI agent execution:

- Creates run through run-with-params.
- Maintains mutable local step snapshot.
- Pins tab to run.
- Clears page-diff cache.
- Polls backend agent.
- Supports vision triggers on first poll, post-recovery, post-failure, URL change, blocking modal, and baseline cadence.
- Handles `COMPLETED`, `WAIT`, `RESTART`, `ROLLBACK`, `PAUSE`, `ADAPT`, `SKIP`, `EXECUTE`, and default failure decisions.
- Mirrors plan updates locally so current step index stays aligned.
- Re-polls paused decisions up to configured count.
- Pauses run on crash.
- Performs final extraction if no explicit extract steps exist.

AI execution permutations:

- Noise break step executes synthetic dwell/scroll.
- `open_message_drafts` step opens/render outreach draft behavior.
- `for_each` navigate can fast-path.
- Extract step can use shape-aware strategies.
- `for_each` can ask backend to expand materialized steps.
- Plan update insert/remove/modify/reorder changes local snapshot.
- Backend decision and local cursor can diverge unless mirrored.
- User cancellation stops active loop.

Daemon enqueue features:

- Reads current browser cookies for target URL when session load is requested.
- Maps Chrome cookie `sameSite` values.
- Creates queued daemon run.
- Uploads `session_cookies` artifact.

Daemon enqueue permutations:

- Load session on vs off.
- Cookies found vs none.
- Cookie upload succeeds vs fails.
- Target operator explicit vs local default.

### Extension Healing and Retry

Healing features:

- Captures DOM snippet for failed step.
- Sends recovery request to backend.
- Applies high-confidence AI heal.
- Reports low-confidence heal.
- Falls back to alternate methods.
- Shows recovering notification.

Retry/circuit features:

- Retryable errors include element not found/visible/unstable/blocked/network.
- Non-retryable errors include navigation failure, permission denied, and tab closed.
- Circuit opens after consecutive or budgeted failures.

Healing permutations:

- AI heal confidence above threshold.
- AI heal low confidence requiring human attention.
- AI heal unavailable.
- Fallback method success.
- Retry budget exhausted.
- Circuit breaker open.

### Popup and Panel UI

Extension UI states:

- Idle.
- Setting goal.
- Recording.
- Running.
- Running parameterized.
- Recovering.
- Waiting for user.
- Failed.
- Error.

UI permutations:

- API config present or missing.
- Active recording restored from storage.
- Workflow save pending.
- Current run active in tab.
- Run canceled/resumed from popup.
- Panel opened from toolbar action.
- Dashboard message triggers extension run.

### Extension and Daemon Test Coverage

Covered extension scenarios include:

- Recording.
- Popup/messaging/storage/service-worker lifecycle.
- Reload and SPA navigation.
- Run execution/progress.
- Parameterized flow.
- Concurrent runs.
- Local cross-site harness.
- Selection extraction.
- Analyze-and-run.
- LinkedIn/Odoo flows.
- Selector resolution.
- Blocker detection.
- Stealth behavior.
- Section navigation.
- Healing scenarios.
- Password redaction.
- File upload.
- Keyboard behavior.
- Iframes.
- Shadow DOM.
- Slow networks.
- New tabs.
- Captcha/login/2FA/modal blockers.
- Chaos and vision scenarios.
- `run_script` and tool-use scenarios.

## Driver Daemon Inventory

### Daemon Polling and Routing

Features:

- Polls backend for queued/running/recovering runs.
- Sends heartbeat with worker, polling, driving, circuit, reason, cooldown, and operator data.
- Filters runs by origin event kind or daemon execution target.
- Routes only runs matching `OPERATOR_ID`/target operator.
- Skips runs already containing extracted data.
- Claims queued runs via `/runs/{id}/start`.
- Processes runs FIFO.

Run eligibility permutations:

- `new_job_position` run.
- `linkedin_lead_search` run.
- Generic daemon-targeted run.
- Target operator matches current daemon.
- Target operator does not match.
- Run already extracted.
- Run is queued at step 0.
- Run is running/recovering and resumable.

### Daemon Gates, Budgets, and Circuit Breaker

Features:

- Work-hour and work-day gating.
- Daily and hourly action budgets.
- Inter-run cooldown.
- Hard and soft cooldown ladder.
- Circuit breaker for blockers.
- Watchdog timeout.
- Optional cooldown disable env.

Gate permutations:

- Inside work hours vs outside.
- Budget available vs exhausted.
- Inter-run cooldown active vs bypassed.
- Soft cooldown due to recoverable signal.
- Hard cooldown due to serious blocker.
- Circuit closed vs open.
- Watchdog timeout triggers capture/pause.

### Browser Contexts and Session Handling

Features:

- Persistent Chrome profile for LinkedIn.
- Clean ephemeral browser context for user generic runs.
- Optional injected cookies from `session_cookies` artifacts.
- Session-cookie artifact consumed/deleted after use.
- Viewport controlled by env.

Context permutations:

- LinkedIn persistent profile.
- Generic clean context.
- Generic context with injected session cookies.
- Cookie artifact missing, malformed, or successfully consumed.
- Browser launch failure.
- Page crash/close during run.

### Hardcoded LinkedIn Recruitment Flow

Features:

- Generic preamble can be disabled/enabled.
- LinkedIn feed warm-up.
- Idle noise.
- People search page 1.
- Extract page 1 URLs/people.
- Paginate to page 2.
- Extract page 2.
- Lead flow completes after search extraction.
- Applicant flow expands profile visits with `for_each`.

Hardcoded flow permutations:

- `linkedin_lead_search` completes without profile visits.
- `new_job_position` visits profile details for applicant extraction.
- Preamble skipped for generic/user flows.
- Search returns enough candidates.
- Search returns fewer candidates than requested.
- Pagination succeeds or fails.
- Profile details sections are present, missing, or blocked.

### Generic Step Interpreter

Supported daemon actions:

- `navigate`
- `extract`
- `linkedin_people_search`
- `linkedin_paginate_next`
- `for_each`
- `noise_break`
- `open_message_drafts`
- `click`
- `type`
- `noop`/unknown advance

Generic permutations:

- Selector resolves and trusted click/type succeeds.
- Selector soft-misses and daemon advances.
- Success condition mismatches but daemon logs and advances.
- `for_each` inner failure policy continues.
- Blocker detection interrupts and pauses.
- Unknown action logs and advances.

### Daemon Extraction Strategies

Strategies:

- `linkedin_profile`
- `linkedin_search_people`
- `linkedin_search_urls`
- `generic_schema`
- Shape-driven extraction from `extract_shapes`
- AI-assisted per-shape extraction.

LinkedIn extraction fields:

- Name.
- Headline.
- Location.
- About.
- Experience.
- Education.
- Skills.
- Certifications.
- Projects.
- Courses.
- Languages/simple list sections.
- Profile URL.
- Search-result person cards.

Extraction permutations:

- DOM parser succeeds.
- DOM parser returns partial profile.
- Details page visit needed.
- Details page unavailable or blocked.
- AI fills missing shape fields.
- Generic schema prompt used.
- Empty/default shape returned.

### Daemon Debug and Artifacts

Features:

- Local debug capture under `.debug/<runId>`.
- Screenshot, HTML, and JSON debug payloads.
- Backend debug event.
- Page capture screenshot artifact.
- Flow manifest JSON artifact.

Debug permutations:

- Watchdog capture success.
- Capture upload success/failure.
- Local debug artifact exists but is intentionally not committed.
- Run paused after watchdog.

## Frontend Inventory

### Frontend Shell and Routing

Routes:

- `/` redirects to `/dashboard`.
- `/dashboard`.
- `/workflows`.
- `/workflows/:workflowId`.
- `/runs`.
- `/runs/:runId`.
- `/audit`.
- `/connectors`.
- `/settings`.
- `/runs/:id/trace`.
- `/interventions`.
- `*` not found.

Shell features:

- Sidebar navigation.
- Active-runs badge polling.
- Topbar search across workflows/runs.
- Backend status indicator.
- Daemon status pill.
- Seq Logs link.
- Global human-intervention modal.
- Waiting-run polling.

Shell permutations:

- Backend reachable vs unreachable.
- Daemon up/down/driving/cooldown.
- Active runs exist vs none.
- Search query empty, loading, results, no results, error.
- Intervention modal suppressed on run page or dismissed.
- Mobile/desktop layout.

### Frontend API Hooks

Features:

- API base from `VITE_API_URL`, `VITE_API_BASE_URL`, or `/v1`.
- API key from env.
- JSON, raw, and blob response handling.
- Error-contract parsing.
- Keepalive POST.
- Data hook with abort and timeout.

API permutations:

- Missing API key in production.
- Backend timeout after 15 seconds.
- Abort previous request on refetch.
- Error contract present vs plain network error.
- Object URL cleanup for artifacts.

### Dashboard Page

Features:

- Summary cards for active workflows, success rate, waiting runs, failed runs, and connectors.
- Recent runs.
- Attention list for failed/waiting runs.
- Delete all runs.
- Template shortcuts.
- Error and empty states.

Dashboard permutations:

- Metrics loaded.
- Loading skeleton.
- API error.
- No workflows/runs.
- Failed/waiting runs require attention.
- Delete all confirmed/canceled.

### Workflows Page

Features:

- Lists workflows.
- System/user tabs.
- User workflow delete.
- Delete all user workflows.
- Empty states.
- Execution-mode badges.
- New workflow entry point.

Workflow-list permutations:

- System tab active.
- User tab active.
- No workflows in tab.
- Delete one workflow.
- Delete all user workflows.
- API loading/error states.

### Workflow Detail Page

Core features:

- View/edit workflow name.
- Promote user workflow to system.
- Run workflow.
- Re-analyze workflow.
- Show workflow type, status, version, target URL, and execution mode.
- Literal and semantic views.
- Phase timeline.
- Parameter list with confidence.
- Output schema preview.
- Connector binding management.
- Automation trigger management.
- Anti-bot switch.
- Message template editor for outreach workflows.
- Extraction field editor modal.

Run features:

- Run always delegates through extension window message.
- Daemon execution target is used from the detail page.
- Pending route `/runs/pending` is shown while waiting for extension response.
- Operator ID comes from localStorage.
- Run can include parameters, execution goal, and load-browser-session option.

Workflow-detail permutations:

- Workflow active vs archived.
- Run disabled for archived workflow.
- User workflow promotable vs system workflow already promoted.
- Re-analysis success/failure.
- Literal view vs semantic view.
- Parameter has text input vs connector binding.
- Connector preview success/error/loading.
- Trigger enabled/disabled.
- Replay last trigger.
- Manual trigger with supplied Odoo URL vs connector latest job.
- Anti-bot enabled/disabled.
- Message template pristine/dirty/saved/error.
- Message template over 300 chars warning.
- Extraction fields legacy labels vs shape schema.
- Re-suggest fields from stored page snapshot.
- Dashboard-to-extension message success, failure, or timeout.

### Run Parameter Modal

Features:

- Parameter form.
- Connector binding previews.
- Optional execution goal.
- Load browser session switch.
- Skip/run-as-recorded option.

Permutations:

- Required params filled vs missing.
- Connector-bound params previewed vs failed.
- Goal supplied vs omitted.
- Load session on/off.
- User runs with substitutions vs run-as-recorded.
- Backend returns `GOAL_REQUIRED`.

### Runs Page

Features:

- List runs.
- Cancel individual active runs.
- Cancel all active runs.
- Delete all runs.
- Empty/loading/error states.

Run-list permutations:

- Running/queued/waiting/recovering run cancelable.
- Terminal run not cancelable.
- Cancel all active confirmed/canceled.
- Delete all confirmed/canceled.

### Run Detail Page

Core features:

- Pending run placeholder.
- Run/events/outcomes polling.
- Status, cursor, pause reason, error, started/ended metadata.
- Waiting-for-user modal.
- Resume, Resume with AI, cancel, retry failed, rerun, and skip-step actions.
- Pagehide keepalive tab-closed report for active daemon runs.
- Tabs for timeline, events, extraction, and screenshots.
- Goal progress ribbon.
- Connector resolution panel.
- LinkedIn applicants table.
- Outreach draft cards.
- Flow manifest artifact view.
- Vision chips in timeline.
- Expandable events.
- Recursive extraction renderer.
- Copy JSON.
- Screenshot gallery and zoom.
- Recovery attempt collapsibles.

Polling permutations:

- Running/recovering poll at faster cadence.
- Non-terminal non-active poll at slower cadence.
- Terminal state stops active polling.
- Backend error while polling.
- Pending run ID before extension reports actual run.

Action permutations:

- Resume waiting run.
- Resume with AI.
- Cancel active run.
- Recover failed run.
- Rerun completed/failed run.
- Skip current step.
- `tab_closed` pause suppresses normal resume path.

Data-display permutations:

- No extraction.
- Scalar extraction.
- List extraction.
- Record/object extraction.
- LinkedIn applicants empty/loading/refreshed.
- Score present vs absent.
- Outreach template missing.
- Outreach drafts empty vs rendered.
- Screenshot artifacts none/loaded/error.
- Flow manifest artifact absent/present.
- Recovery attempts absent/present.

### Connectors Page

Features:

- List connectors.
- Add connector.
- Edit existing connector.
- Test connector health.
- Save connector config.
- Delete connector.
- Show triggers per connector.
- Show last sync and health.

Connector UI types:

- Odoo.
- Salesforce.
- HubSpot.
- Custom.

Permutations:

- Odoo required fields valid/missing.
- Password redacted and preserved on save.
- Password replaced.
- Test connection success/failure.
- Existing connector healthy/unhealthy.
- Connector has triggers vs none.
- Non-Odoo type selected but limited config/test implementation.

### Settings Page

Features:

- Operator ID localStorage setting.
- AI confidence threshold slider.
- Auto-retry select.
- Deterministic mode switch.
- Retention period select.
- Masked static API key show/hide.
- Disabled revoke control.
- Team/admin and notification environment notes.
- Load/save/saved/error states.

Permutations:

- Settings loaded vs API error.
- Save success vs failure.
- Deterministic mode enabled/disabled.
- Threshold low/medium/high.
- Retention 7/14/30/60/90/180/365 days.
- API key masked vs visible.

### Audit, Interventions, Trace

Audit page features:

- Select run.
- Load audit events.
- Chain validity banner.
- Event-type filter.
- Event table.
- Expand hash/payload/page URL.
- Empty states.

Audit permutations:

- No run selected.
- Audit chain valid.
- Audit chain compromised.
- Filter returns matches/no matches.
- Payload expansion on/off.

Human intervention page features:

- List interventions.
- Priority badge.
- Empty state.

Intervention permutations:

- Priority >= 3 shown as error.
- Lower priority shown as warning.
- No interventions.

Trace page features:

- Lightweight audit list for a run.
- Loading/error/empty states.

### Frontend Components

Component features:

- `DataTable` with visible-row cap of 100.
- Keyboard row activation.
- `StatusBadge` for run/workflow/step aliases.
- `InterventionModal` with resume/cancel and confirmation state.
- `StepScreenshots` artifact fetching and zoom.
- `FlowManifest` latest artifact fetch.
- Shared cards, banners, empty states, and layout components.

Component permutations:

- Data table empty/loading/error.
- More than 100 rows reports truncated display.
- Status alias recognized/unrecognized.
- Intervention cancel confirmation open/closed.
- Screenshot fetch success/error/none.
- Flow manifest present/absent.

### Frontend Test Coverage

Covered frontend categories include:

- Dashboard.
- Workflows.
- Workflow detail.
- Run detail.
- Audit.
- Settings.
- Connectors.
- Intervention page/modal.
- Trace page.
- App shell.
- API hook behavior.

## Cross-Layer Feature Flows

### Record to Workflow

Flow:

- User starts recording in extension.
- Content script captures events and page context.
- Background orchestrator queues events and screenshots.
- User stops recording.
- Backend records workflow with idempotency.
- Backend dedupes/normalizes events.
- Semantic analysis runs.
- Workflow appears in frontend.

Permutations:

- Empty recording returns no workflow.
- Service worker sleeps mid-recording and restores.
- Screenshot capture missing but event still saved.
- AI title generation succeeds or falls back.
- Semantic analysis succeeds or heuristic fallback is used.

### Browser Replay

Flow:

- Frontend asks extension to run workflow.
- Extension creates/starts run.
- Content script executes steps in browser tab.
- Step results and artifacts return to backend.
- Backend advances or completes run.
- Frontend polls run detail.

Permutations:

- Deterministic selector replay succeeds.
- Selector fallback succeeds.
- Healing path succeeds.
- Human intervention is required.
- Tab closes.
- User cancels.
- Final extraction needed because no extract step exists.

### AI Agent Replay

Flow:

- Extension creates parameterized or agent-enabled run.
- Extension captures page state/screenshots.
- Backend agent decides next action.
- Extension executes command and posts result.
- Backend advances, adapts, recovers, pauses, or completes.

Permutations:

- AI returns execute/skip/wait/adapt/restart/rollback/pause/complete.
- Vision context included or omitted.
- Plan update changes step list.
- Local and backend cursors stay aligned or require mirror updates.
- Crash pauses run for recovery.

### Daemon Execution

Flow:

- Backend creates queued daemon run.
- Daemon heartbeat/poll sees eligible run.
- Daemon claims queued run.
- Playwright drives page.
- Daemon posts step results/extractions/artifacts.
- Backend completes and triggers downstream push if origin matches.

Permutations:

- Operator matches or does not match.
- Work-hours/budget/cooldown allow or defer run.
- LinkedIn persistent context or generic clean context.
- Session cookies injected or absent.
- Blocker pauses run.
- Watchdog pauses run with debug capture.

### Odoo New Job to Applicant

Flow:

- Odoo publishes job.
- Webhook or reconciler triggers backend.
- Backend resolves job payload and creates LinkedIn applicant run.
- Daemon searches people and visits profiles.
- Extraction events accumulate profile data.
- Run completes.
- Applicant push posts to Odoo.
- Easy Recruit scores applicant.

Permutations:

- Webhook direct vs reconciler-discovered job.
- Trigger enabled/disabled.
- Duplicate idempotency key.
- Job description supplied vs fetched.
- Candidate count default/clamped.
- Profile extraction partial/full.
- Odoo push creates new applicant or returns existing duplicate.
- Odoo scoring succeeds, times out, or fails.

### LinkedIn Lead Search

Flow:

- Odoo/manual trigger creates `linkedin_lead_search`.
- Daemon searches LinkedIn people results.
- Daemon extracts people cards.
- Run completes without profile visits.
- Lead push posts records to Odoo.

Permutations:

- Search page 1 only vs pagination.
- People cards found vs empty.
- Candidate count up to 50.
- Duplicate profile URLs deduped.
- Lead push success/failure.

### Human Intervention

Flow:

- Runtime detects blocker, low-confidence heal, challenge, tab close, or deterministic failure.
- Backend creates/records intervention.
- Frontend AppShell/RunDetail shows modal.
- User resumes, resumes with AI, cancels, or leaves waiting.

Permutations:

- Captcha/login/2FA/modal challenge.
- Low-confidence selector heal.
- Tab closed.
- Recovery supervisor eligible vs skipped.
- Manual resume vs AI resume.
- Cancel from modal/page.

### Artifact and Audit Flow

Flow:

- Extension/daemon/backend creates artifacts and event logs.
- Artifact metadata is stored.
- Audit event hash chain records state changes.
- Frontend retrieves artifacts and audit history.

Permutations:

- Screenshot/DOM/a11y/flow manifest/session cookie/debug artifact.
- Artifact fetch authorized vs unauthorized.
- Artifact deleted or absent.
- Audit chain valid vs tampered.
- Event payload expanded/collapsed in UI.

## Operations, Scripts, and Deployment

Make targets:

- `make setup`
- `make lint`
- `make typecheck`
- `make test`
- `make test-e2e`
- `make autonomy-e2e`
- `make coverage`
- `make coverage-e2e`
- `make check`
- `make build`
- `make dev`
- `make dev-backend`
- `make dev-frontend`
- `make dev-logs`
- `make logs`
- `make docker`
- `make all-services-install`
- `make all-services-uninstall`
- `make all-services-restart`
- `make services-status`
- `make services-logs`
- `make daemon-restart`

Script surfaces:

- Autonomy verification/report scripts.
- Local LinkedIn/Odoo harness scripts.
- Workflow seeding scripts.
- Connector/forum harnesses.
- Service install/uninstall scripts.
- Deployment scripts and Caddy/Docker configuration.
- Launchd templates.

Operational permutations:

- Backend/frontend under screen vs installed services.
- Daemon under launchd.
- Port 8000 conflict with `easy-recruit-workflow`.
- Backend code change requires service restart in installed-services mode.
- Daemon code change requires daemon restart.
- Browser-facing changes require live browser/E2E proof.
- Seq container started or absent.
- Frontend missing `VITE_API_KEY` causes UI auth failures.

## Known Inconsistencies and Gotchas

- Backend workflow status supports `active` and `archived`; frontend/extension types still include `draft`.
- Extension agent decision typing omits backend decisions such as `RETRY` and `HEAL`.
- Workflow simplification service exists, but the recording route currently skips simplification.
- `SemanticAnalysisService` contains a misspelled `ambiguty_notes` key path, which may prevent an intended ambiguity-note update from taking effect.
- Frontend connector UI exposes Salesforce, HubSpot, and custom options, but Odoo is the primary implemented/tested connector path.
- Data-table sorting props appear presentational unless backed by page-level sorting.
- Driver daemon treats some selector soft misses and success-condition mismatches as logged-and-advance behavior, which is intentionally tolerant but can hide weak workflows.
- LinkedIn scraping depends on current DOM layout and locale-dependent labels; details pages may be required for complete sections.
- Odoo-side OpenAI configuration is independent from backend AI configuration.
- Long Odoo applicant-push timeouts are intentional because Easy Recruit scoring runs synchronously.
- Debug artifacts under `extension/.debug/` are local captures and should not be committed without explicit review.

## Verification Status

This document is a static source inventory. No test suite was run for this document-only change. Recommended verification if this document becomes release material:

- `make lint`
- `make test`
- `make test-e2e`
- Live dashboard/extension proof for browser-facing claims.
- Live Odoo/LinkedIn proof for recruitment-flow claims.
