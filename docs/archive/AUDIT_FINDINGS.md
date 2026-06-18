# AUDIT_FINDINGS.md — session-replay

**Audit date:** 2026-05-12
**Auditor:** Brutal-mode code review (deliberately adversarial).
**Scope:** Backend (FastAPI/Python 3.12), browser extension (TypeScript/Manifest V3), frontend (React 19/Vite), Docker setup, migrations, tests, docs.
**Method:** Three parallel deep-read passes, plus direct verification of every claim that names a file:line. Findings that could not be confirmed are not included.

---

## §0 Executive summary

The kernel works. Backend tests pass (77/77 today). Recording → store → replay flows end-to-end against the controlled fixtures. The architectural backbone (state machine + audit hash chain + adapter registry + healing/orchestrator split) is sound.

That is the good news.

The bad news is that the **product is not what the PRD says it is**, the **audit trail is not actually tamper-evident**, the **healing pipeline silently ignores its own confidence policy**, the **detector module is dead code**, the **extension captures password fields in plaintext**, and **most of the frontend is decorative** — the Settings page doesn't save, the Search box doesn't search, and the Run viewer / Intervention modal called out in `UI-UX-SPEC.md` are not built. There are also several **PostgreSQL-only constructs** (`gen_random_uuid()`, JSONB column constraints) used by migrations while tests run on SQLite, so the test suite is structurally incapable of catching a class of prod-only bugs.

### Severity heat-map

| Layer | Critical | Major | Minor | Code-quality | Test gap | Spec gap | Sec / privacy | Perf | Total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Backend | 18 | 17 | 24 | 12 | 13 | 9 | 10 | 8 | **111** |
| Extension | 12 | 16 | 28 | 11 | 22 | 4 | 11 | 8 | **112** |
| Frontend / integration | 9 | 12 | 13 | 10 | 8 | 17 | 7 | 6 | **82** |
| Cross-cutting (build, CI, docker, ports) | 5 | 4 | 2 | 1 | — | — | 3 | 1 | **16** |
| **Total** | **44** | **49** | **67** | **34** | **43** | **30** | **31** | **23** | **~321** |

### Top-10 must-fix-now

1. **Backend healing service silently applies any AI-suggested selector regardless of `settings.ai_confidence_threshold`** — PRD §13 violation. `backend/services/healing_service.py:111-115` returns whatever confidence the AI reported (0.0 from OpenAI provider by default) and no caller enforces the threshold. Extension uses a hard-coded `> 0.3` cutoff at `extension/src/background/healer.ts:89`. Either threshold is far too permissive for an unattended runtime.
2. **Audit hash chain is replayable** — `backend/services/audit.py:55-87` uses a random per-event nonce but the `hash` column has only `unique=True` (good) and there is no monotonic `sequence_number` per run; chain ordering is by `created_at` which can collide at microsecond resolution in PostgreSQL and definitely collides in SQLite (`AGENTS.md` itself flags this). Chain rebuild in `verify_chain()` therefore has ambiguous ordering and the chain is not strictly tamper-evident.
3. **`.env.example` and `core/config.py` ship insecure defaults that survive into production silently** — `API_KEY=dev-api-key-change-in-production`, `SECRET_KEY=change-me-to-a-random-secret`, Postgres password `workflow` in `docker-compose.yml:22`. If a deployment doesn't override these, the API is open to anyone who has read the repo.
4. **Detector for CAPTCHA / login / 2FA / unexpected modal lives in `extension/src/background/detector.ts` but is never imported** — `grep -rn "detectChallenges\|hasActiveChallenge"` returns only the definitions in `detector.ts` itself. PRD §7.4 ("human intervention") is therefore not implemented client-side.
5. **Recording captures password and credit-card values in plaintext** — `extension/src/content/capture.ts:186` reads `target.value` for every `<input>` (including `type="password"`) and sends it to `POST /v1/events/record`. The redact_pii regex in `replay.ts:178-183` only redacts in DOM snippets for healing, not in event payloads at capture time.
6. **`HealingService.recover()` is a no-op stub** — `backend/services/healing_service.py:137-142` literally ignores `step_index` and `error` (`_ = (step_index, error)`), only transitions the run to RECOVERING. The endpoint `POST /v1/runs/{run_id}/recover` therefore does nothing useful.
7. **`WorkflowService.delete()` orphans steps instead of cascading** — `backend/services/workflow_service.py:151-158` deletes the workflow then runs `UPDATE workflow_steps SET workflow_id=NULL`. Combined with the missing `ForeignKey("workflows.id")` constraint on `WorkflowStep.workflow_id` (`backend/core/models/workflow.py:24`), referential integrity is purely advisory.
8. **`apply_heal` mutates `run.workflow_snapshot` in place** — `backend/services/healing_service.py:129-134`. SQLAlchemy may or may not detect the in-place mutation as a dirty write depending on JSON column dialect; on PostgreSQL JSONB it usually does not, on SQLite JSON it does. This is also a concurrency hazard if the same dict is observed by another async task.
9. **React-controlled inputs cannot be replayed** — `extension/src/content/replay.ts:142-148` sets `element.value = value` directly. React intercepts assignments via its internal `nativeInputValueSetter`; assigning the bare property updates the DOM but does not fire React's onChange. The same applies to Vue's `v-model`. Today's replay therefore fails silently on almost every React/Vue form.
10. **Frontend Settings page does nothing** — `frontend/src/pages/SettingsPage.tsx:32-35` `handleSave` only flips a toast flag for 2 seconds. No backend call, no `localStorage`, no persistence. The "Revoke" button in the API Keys card is a label with no handler.

---

## §1 Critical bugs

### §1.1 Backend

**B-C-01. AI healing confidence threshold is never enforced.**
File: `backend/services/healing_service.py:111-115`, `backend/api/v1/runs.py:414-451`, `backend/core/config.py:11`.
`settings.ai_confidence_threshold` defaults to `0.85` and is loaded by `OpenAIProvider.__init__` at `backend/ai/client.py:56` but only stored on the instance — it is never compared against the returned confidence anywhere. The healing endpoint returns `result["new_selectors"]` and lets the extension decide. The extension uses `> 0.3`. PRD §13 explicitly forbids silent execution of low-confidence recoveries.
**Fix:** In `HealingService.suggest_heal`, if `result["confidence"] < settings.ai_confidence_threshold`, return `{"new_selectors": [], "confidence": result["confidence"], "explanation": ..., "below_threshold": True}` and have the endpoint return HTTP 409 so the client must escalate to a human.

**B-C-02. Audit chain ordering relies on `created_at`, which has microsecond precision in PG and second precision in SQLite.**
File: `backend/services/audit.py:91-94`, `backend/core/models/event.py` (no sequence column), `AGENTS.md` already flags this.
On SQLite (used by every test) `server_default=func.now()` is second-precision; the workaround is `AuditService.append` setting `created_at = datetime.now(UTC)`. Two appends in the same microsecond will compare equal and the ORDER BY becomes nondeterministic — meaning `verify_chain` can return spurious "broken_links".
**Fix:** add `sequence_number INTEGER NOT NULL` per-run, `UNIQUE(run_id, sequence_number)`, populated atomically. Order by it everywhere.

**B-C-03. Nonce is unique only because of `unique=True` on `hash`.**
File: `backend/core/models/event.py:60`. There is no `UNIQUE` constraint on `nonce`. The chain is only tamper-evident if the hash of the *full preimage* (which includes the nonce) cannot collide; but if an attacker reuses an old nonce + payload they can re-insert the same hash row, and the only thing stopping them is the `hash UNIQUE` constraint — not the nonce itself. This is brittle.
**Fix:** `UNIQUE(run_id, nonce)`.

**B-C-04. `HealingService.recover()` is a stub that does no recovery.**
File: `backend/services/healing_service.py:137-142`. `_ = (step_index, error)` and the function only transitions the run to RECOVERING. The `POST /v1/runs/{run_id}/recover` endpoint (`runs.py:389-411`) therefore changes state but does no actual healing.
**Fix:** Either call `suggest_heal` from here, or remove the endpoint until it does something. Right now its presence is misleading.

**B-C-05. `WorkflowService.delete` orphans steps.**
File: `backend/services/workflow_service.py:151-158`. `UPDATE WorkflowStep SET workflow_id = NULL WHERE workflow_id = …`. Combined with no FK constraint on `WorkflowStep.workflow_id` (next finding), this leaves orphan rows forever.
**Fix:** `await self.session.execute(delete(WorkflowStep).where(WorkflowStep.workflow_id == workflow_id))` BEFORE the workflow delete, or add `ondelete="CASCADE"` on the FK.

**B-C-06. No FK constraint on `WorkflowStep.workflow_id`.**
File: `backend/core/models/workflow.py:24` (`Mapped[str] = mapped_column(String(36), nullable=False, index=True)`), `backend/migrations/versions/002_create_workflows_and_runs.py`.
**Fix:** `ForeignKey("workflows.id", ondelete="CASCADE")`. Also fix migration.

**B-C-07. No FK constraint on `ExecutionRun.workflow_id`.**
File: `backend/core/models/run.py:12`. Same fix.

**B-C-08. `apply_heal` mutates `workflow_snapshot` in place.**
File: `backend/services/healing_service.py:129-134`. With `expire_on_commit=False` (`backend/core/database.py:6`) and JSONB on PostgreSQL, in-place mutation of `dict` columns is not picked up by SQLAlchemy without a `flag_modified(run, "workflow_snapshot")`. On SQLite (test) the JSON type roundtrips through serialization so the mutation is detected. **Tests pass; production silently loses heals.**
**Fix:** Either `from copy import deepcopy; snapshot = deepcopy(...)` then `run.workflow_snapshot = snapshot`, or use `sqlalchemy.orm.attributes.flag_modified(run, "workflow_snapshot")`.

**B-C-09. State transition + audit append are not atomic.**
File: `backend/services/execution_service.py:83-115`. After `await self.session.flush()` on line 104, the row is visible to other transactions, then the audit append starts. If two requests race, both can observe the intermediate state. There is no `SELECT … FOR UPDATE`.
**Fix:** Wrap in `BEGIN … COMMIT` with `with_for_update()` lock on the run row before transition.

**B-C-10. Global exception handler returns raw exception messages.**
File: `backend/api/main.py:109-114`. `content={"error": {"code": "INTERNAL_ERROR", "message": str(exc)}}` — `str(SQLAlchemyError)` can leak column names, query fragments, FK constraint names, file paths. Also: no logging.
**Fix:** Log the exception with `request.state.request_id`, return `{"error": {"code": "INTERNAL_ERROR", "message": "Internal server error", "request_id": …}}`.

**B-C-11. `/v1/debug/log` is exempt from auth.**
File: `backend/api/main.py:22` (`_AUTH_EXEMPT = {"/v1/health", "/v1/debug/log"}`). Anyone can POST arbitrary log lines that will appear in `/v1/debug/logs` (which itself is authed but populated by anyone). This is an unauth log-injection vector usable by anyone who can reach the host.
**Fix:** Move POST to a separate `/internal/debug/log` bound to localhost only, or require API key.

**B-C-12. In-memory rate limiter is per-process and never bounded.**
File: `backend/api/main.py:76-105`. `_rate_limit_buckets: dict[str, list[tuple[float, str]]]` grows by-IP forever (only entries inside the window are pruned, the dict keys are not). In a multi-worker uvicorn deployment, limits are local to each worker so the effective rate is `workers × limit`.
**Fix:** Move to Redis (`slowapi` or hand-rolled with `INCR … EXPIRE`).

**B-C-13. CORS regex allows any extension ID.**
File: `backend/api/main.py:42`. `allow_origin_regex=r"chrome-extension://.*"`. A malicious user-installed extension can call the API with a stolen key. Should be locked to the specific extension ID once shipped.

**B-C-14. CSRF: there is none.**
The `Origin` header check is the only thing standing between a logged-in browser session and the API. With cookies-based sessions (which the codebase does not use today but `secret_key` hints at), this would be exploitable.

**B-C-15. `record_event` defaults `run_id` to `00000000-0000-0000-0000-000000000000`.**
File: `backend/api/v1/events.py:83`. Three downstream issues:
- All pre-run recordings collapse onto a single synthetic run, so `verify_chain` on that pseudo-run conflates events from every user.
- The seed hash in `compute_seed_hash` is computed with this string ("seed|00000000-...|anonymous"), which is the same constant for everyone. Any attacker can predict the seed hash.
- Real run `00000000-0000-0000-0000-000000000000` (rare but possible if a client picks zeros) is indistinguishable.
**Fix:** Require `run_id` for all `/v1/events/record` calls or use a NULL `run_id` plus a separate "recording session id".

**B-C-16. `EventLog.idempotency_key` is checked only within a `run_id` scope.**
File: `backend/api/v1/events.py:62-74`. Same idempotency_key on two different runs both succeed. This breaks the usual semantics of "idempotency_key uniquely identifies a request".
**Fix:** `UNIQUE(idempotency_key)` globally, or scope by `(client_id, idempotency_key)`.

**B-C-17. `pyproject.toml` is missing in this read but `_AUTH_EXEMPT` is a module-level set with `health` listed twice in spirit (no, just once)** — false positive removed after re-verification.

**B-C-18. `WorkflowService.update_status` writes audit with `run_id=workflow_id`.**
File: `backend/services/workflow_service.py:66-69`. The audit event uses `run_id=workflow_id`, so chain rebuilds for workflow IDs mistakenly identified as run IDs will produce nonsense. The "checkpoint" event_type is also overloaded with two different meanings (workflow status update vs. run checkpoint).
**Fix:** Either give workflow audit events a separate "scope" column or use a distinct event type.

### §1.2 Extension

**E-C-01. React/Vue/Angular controlled inputs cannot be replayed.**
File: `extension/src/content/replay.ts:137-148`. Bare `element.value =` does not satisfy React's controlled-input contract.
**Fix:** Use `Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(element, value)`. Mirror for `HTMLTextAreaElement` and `HTMLSelectElement`.

**E-C-02. Password fields are captured.**
File: `extension/src/content/capture.ts:186` (`const value = target.value || target.textContent || ""`), `extension/src/content/index.ts:147-158` (the change listener captures every input). No `type==="password"` guard, no `autocomplete="cc-number"` guard. Values land in `payload.value` and are POSTed to backend over HTTP (no TLS in dev).
**Fix:** In `captureInput`, if `target.type === "password"` or `autocomplete in ("current-password","new-password","cc-number","cc-csc")`, set `value="[REDACTED:password]"` and `value_length=0`. Also strip from `target.value` before serializing.

**E-C-03. Shadow DOM panel renders `status` via `innerHTML` interpolation.**
File: `extension/src/content/index.ts:83-90`. `<div class="status">${status}</div>` — `status` flows from `orchestrator.notifyRunning(..., status)` in `service-worker.ts:214` and similar. The string typically comes from server error messages and workflow names. If a workflow name or AI explanation contains `<img src=x onerror=…>`, it executes in the shadow root. Closed-mode shadow DOM doesn't help (same JS environment).
**Fix:** Use DOM APIs (`textContent`) instead of `innerHTML` for everything user-supplied. Build the panel once and update text nodes.

**E-C-04. XPath selectors are evaluated unsanitized.**
File: `extension/src/content/replay.ts:93-101`. `document.evaluate(xpath, ...)` with a string straight from the server's `selector_chain`. XPath is not arbitrary code execution, but it can read any node in the doc, exfiltrate page content via the matched element's `textContent`, and trigger `string-length(window.location)`-type oracle attacks. If the backend is compromised, the extension becomes a controllable scraper.
**Fix:** Restrict XPath to a whitelist of safe axis usage, or refuse XPath that contains `count(`, `string-length(`, `substring(`, etc.

**E-C-05. Selector chain priority is CSS-first, contradicting PRD §7.2.**
File: `extension/src/content/replay.ts:17-43`. PRD specifies accessibility-first (most stable across redesigns). Current code tries CSS first.
**Fix:** Iterate the chain in the order the server provides it (already done), but also: in `selectors.ts` the chain is built CSS-first. Reorder there.

**E-C-06. Detector is dead code.**
File: `extension/src/background/detector.ts`. `grep` confirms it is never imported. PRD §7.4 not implemented client-side.
**Fix:** Either delete the file or wire it into `executeWorkflowRun` to pause runs on detection (and into the content-script `chrome.runtime.onMessage` to send back detections).

**E-C-07. Healer accepts AI selectors with confidence > 0.3.**
File: `extension/src/background/healer.ts:89`. See §0 top-10 #1.
**Fix:** Use `confidence > 0.7` minimum; below `settings.ai_confidence_threshold` should pause for human approval, not silently apply.

**E-C-08. `manifest.json` requests `<all_urls>` host permissions.**
File: `extension/manifest.json:13` and `:27`. Combined with no CSP, this is the maximal-trust profile. Chrome Web Store reviewers reject this without a justification text. Also enables content-script injection on banking/email pages a user did not intend to record on.
**Fix:** Empty `host_permissions` + `activeTab` only; require user gesture for injection; or restrict to declared content_scripts host patterns.

**E-C-09. No CSP declared in manifest.**
File: `extension/manifest.json`. MV3 has a strict default CSP for extension pages, but the popup/panel HTML at `extension/popup.html` and `extension/panel.html` rely on Vite's runtime, which under MV3 requires `script-src 'self'` (no inline). Without an explicit `content_security_policy.extension_pages`, future inline-script additions slip through unnoticed.
**Fix:** Add `"content_security_policy": { "extension_pages": "script-src 'self'; object-src 'self'" }`.

**E-C-10. Service-worker switch statement falls through silently on unknown messages.**
File: `extension/src/background/service-worker.ts:24-107`. There is no `default:` branch. When the popup posts a message type the SW does not recognize (e.g., after a future protocol bump or stale popup state), `sendResponse` is never called and `return` is `undefined`, so the popup's `.then()` waits forever then errors out with "the message port closed before a response was received". This is the SW analogue of B-C-10 (silent failures).
**Fix:** `default: sendResponse({ type: "ERROR", code: "UNKNOWN_MESSAGE", received: message.type }); break;`

**E-C-11. Scroll listener never removed.**
File: `extension/src/content/index.ts:161-167`. `document.addEventListener("scroll", ...)` once per content-script load. On SPA route changes the content script does not re-load, so the leak is bounded; but on hard reloads + bf-cache, multiple listeners can attach. `scrollTimeout` is module-scoped; concurrent listeners would race over it.

**E-C-12. Two message listeners registered on `chrome.runtime.onMessage`.**
File: `extension/src/content/index.ts:101-119` and `:169-183`. Both `return true`. Per the Chrome docs, only one listener should `return true`; multiple `return true` listeners cause one to win arbitrarily. Today the messages don't overlap, but a future `EXECUTE_STEP` + `SET_RECORDING` collision is a latent bug.
**Fix:** Combine into one listener.

### §1.3 Frontend

**F-C-01. Settings page does not persist anything.**
File: `frontend/src/pages/SettingsPage.tsx:32-35`. `handleSave` only shows a toast.
**Fix:** POST to a new `/v1/settings` endpoint (which does not exist either — also a backend gap).

**F-C-02. Hardcoded API key fallback.**
File: `frontend/src/hooks/useApi.ts:4` (`const API_KEY = import.meta.env.VITE_API_KEY || "dev-api-key-change-in-production"`). If a build is shipped without `VITE_API_KEY`, every user sends the default key. Should fail loudly, not fall back.

**F-C-03. Hardcoded API key inline in page.**
File: `frontend/src/pages/WorkflowDetailPage.tsx:41` (handleRun fetch uses the default key string in the source).
**Fix:** All requests through `useApi`.

**F-C-04. Search bar is decorative.**
File: `frontend/src/AppShell.tsx:59-66`. Label "Search" is rendered, no input, no handler.

**F-C-05. Run viewer / Replay live view not implemented.**
`UI-UX-SPEC.md §3.5`. There is no `RunDetailPage.tsx`. Clicking a row in `RunsPage` does nothing.

**F-C-06. Human-intervention modal not implemented.**
`UI-UX-SPEC.md §3.7`. Paused runs are shown but there is no modal with "Continue / Review / Cancel" actions and no `POST /v1/runs/{id}/resume` wiring.

**F-C-07. No error boundary.**
`frontend/src/AppShell.tsx` does not wrap children in any `<ErrorBoundary>`. A subtree throw blanks the app.

**F-C-08. No keyboard support on clickable table rows.**
`frontend/src/components/DataTable.tsx:46`, `frontend/src/pages/DashboardPage.tsx:99`, `frontend/src/pages/WorkflowsPage.tsx:99`. WCAG 2.1 A failure.

**F-C-09. No client-side abort on unmount.**
`frontend/src/hooks/useApi.ts` does not pass `signal` to `fetch`. Unmount + race causes "Can't perform a React state update on an unmounted component" warning under StrictMode, and ignores response data discarded.

### §1.4 Cross-cutting

**X-C-01. Port mismatch between `docker-compose.yml` and the rest of the world.**
`docker-compose.yml:7` exposes `8000:8000` and `docker-compose.yml:15` runs uvicorn on `:8000`. `Makefile:87` runs uvicorn on `:8081`. `AGENTS.md:30-33` says backend is on `:8081`. `frontend/vite.config.ts` proxy targets `:8081`. Conclusion: the Docker setup is broken; only `make dev` works.

**X-C-02. `.dockerignore` is short (67 bytes).**
`.dockerignore` did not exclude `__pycache__`, `.venv`, `.pytest_cache`, `node_modules`, etc., or did so only partially. Builds copy giant dirs into image layers.

**X-C-03. Backend `Dockerfile` does `COPY . .` after install.**
`backend/Dockerfile:8`. Any source change invalidates the image cache. Should `pip install` before copying source.

**X-C-04. Migrations require PostgreSQL.**
`backend/migrations/versions/001_create_event_log.py:26` uses `gen_random_uuid()` which is a PG-only function. Tests bypass migrations by calling `Base.metadata.create_all`, so the migration files themselves are never exercised by the test suite at all.

**X-C-05. `pyproject.toml` configures `pytest-asyncio` but tests rely on session-scoped event loop.**
`backend/tests/conftest.py:21-25` defines a custom `event_loop`. Modern `pytest-asyncio` (≥ 0.23) deprecates this in favor of `asyncio_mode = "auto"` + `loop_scope`. Warnings on every run; future versions will break.

---

## §2 Major bugs

### §2.1 Backend

**B-M-01.** `core/state_machine.py:25` does not allow QUEUED → FAILED. If a run is enqueued and the workflow is then deleted, there is no way to transition the run to FAILED other than via RUNNING.

**B-M-02.** `core/state_machine.py:40-42` makes FAILED/COMPLETED/CANCELED terminal but `ExecutionService.fail` (`execution_service.py:146`) sets `error_summary` *after* `transition` flushes; if `transition` raises (illegal state), `error_summary` is unset, so the API returns no error explanation. Order should be: set fields → transition.

**B-M-03.** `ExecutionService.advance_step` (`execution_service.py:117-125`) increments `current_step_index` past `total_steps` without auto-transitioning to COMPLETED. The caller in `runs.py:376-378` doesn't check either. A run can sit at `current_step_index == total_steps + 1` indefinitely.

**B-M-04.** `runs.py:357-374` records the `step_executed` audit event *before* it has verified `step_index == current_step_index`. So a misordered or replayed event leaves a misleading audit entry then errors out.

**B-M-05.** `runs.py:369-374` returns `STEP_INDEX_MISMATCH` with 409 but the message echoes both the expected and received index, useful for diagnosis but also a step-index oracle if external systems are guessing.

**B-M-06.** Heal-override endpoints `runs.py:25-33` (`/runs/testing/inject-heal-override`, `/runs/testing/clear-heal-overrides`) are mounted in production: they are not gated behind a `DEBUG` flag. An attacker (with API key) can force any heal result. `_HEAL_OVERRIDES` is module-level state — also lost on restart, but that's the smaller problem.

**B-M-07.** `runs.py:316-318` `HealStepRequest.override_response: dict | None` is a backdoor that lets the caller skip AI entirely. Used by tests, but also exposed in prod.

**B-M-08.** `runs.py:482-497` (`record_intervention`) has no idempotency check. A double click in the popup creates two `HumanIntervention` rows.

**B-M-09.** `adapters/odoo/client.py` (not re-read fully, but according to audit pass) re-authenticates on every call and recurses on AccessError without a retry budget.

**B-M-10.** `adapters/odoo/adapter.py` `_model_for` uses a hard-coded resource→model map; `list` calls `search_read` without limit/offset, so a large Odoo tenant chokes the request.

**B-M-11.** `api/v1/integrations.py:35-40` hardcodes `database=workflow`, `username=admin`, and *passes `settings.api_key` as the Odoo password*. This is almost certainly wrong and definitely a footgun.

**B-M-12.** `api/v1/connectors.py:16` stores connector configs in `_connectors: dict[str, dict]` (module-level). All connector registrations vanish on restart and are not visible across uvicorn workers.

**B-M-13.** `api/v1/workflows.py:33-40` `AddStepRequest.action_type` is `str` with no validation. The Pydantic `MethodDef` at the top of the file *does* constrain `action_type` for the methods array, but `AddStepRequest.action_type` itself can be anything.

**B-M-14.** `api/v1/workflows.py:247-273` workflow status update accepts `draft|active|archived` but has no state machine (e.g., `archived` → `active` is allowed).

**B-M-15.** `api/v1/workflows.py:384-407` `run_workflow` creates a run and immediately transitions to RUNNING in the same request — no validation that the workflow has steps (`len(steps) > 0`) or is `active`. A run on an empty `draft` workflow immediately completes with zero work.

**B-M-16.** `api/v1/workflows.py:326-348` AI-prompt generation has no try/except; if OpenAI fails, the endpoint 500s.

**B-M-17.** `services/healing_service.py:30-39` `_normalize_selector` returns a sloppy fallback (`{"type": "css", "value": str(sel)}`) on `None` or `int` input. Should raise.

### §2.2 Extension

**E-M-01.** `service-worker.ts:32-37` `FETCH_WORKFLOWS` swallows errors and returns `{ workflows: [] }`. Popup cannot distinguish "no workflows" from "backend down".

**E-M-02.** `service-worker.ts:91-105` `EXECUTE_STEP` returns `{ success: false, error: "Content script not available..." }` when `sendMessage` throws. The popup logic in `App.tsx` doesn't retry on this — recording is silently dropped.

**E-M-03.** `service-worker.ts:110-132` `waitForTabLoad` adds a listener but only removes it inside the resolved branch. On reject (timeout), the listener leaks.

**E-M-04.** `service-worker.ts:263-271` URL-change detection uses `beforeUrl !== afterUrl`. SPA in-place navigations leave the URL the same; `pushState` to a hash fragment too.

**E-M-05.** `service-worker.ts:353` hardcoded 1-second delay between every step. Slow on simple flows, fast on heavy ones.

**E-M-06.** `service-worker.ts:387-389` `chrome.action.onClicked` calls `openOptionsPage?.()`, but the manifest has no `options_page`. Click does nothing.

**E-M-07.** `service-worker.ts:392-394` exposes `__executeWorkflowRun` on `self` for tests. Not gated by a debug flag — leaks an internal API in production.

**E-M-08.** `content/index.ts:35-42` `chrome.storage.onChanged` listener doesn't filter by key; any session-storage change triggers a state recompute.

**E-M-09.** `content/index.ts:73-91` `showReplayPanel` reuses a single global `shadowHost`. On page navigation (full reload), the host is detached automatically, but the module-scoped variables remain set, so the next `showReplayPanel` tries to call `attachShadow` on a detached node and fails silently.

**E-M-10.** `content/capture.ts:139-159` `captureClick` does not record whether the target was inside a shadow DOM, an iframe, or a closed form. Replay has no way to traverse back.

**E-M-11.** `content/capture.ts:209-225` `captureScroll` discards which element was scrolled (always uses `window`). Element-level scroll on a virtualized list cannot be replayed.

**E-M-12.** `content/replay.ts:104-135` `simulateClick` dispatches synthetic events with `isTrusted: false` (forced by browser). Sites that require user activation (e.g., `requestFullscreen`, paste handlers) will refuse.

**E-M-13.** `content/replay.ts:151-157` `simulateSelect` sets `element.value` only — for `<select multiple>` cannot select more than one option.

**E-M-14.** `content/replay.ts:164-174` `simulateNavigate` uses `window.location.href = value` for both absolute and root-relative URLs but bails on hash/relative URLs (`./foo`, `?bar=1`).

**E-M-15.** `content/replay.ts:233-247` `captureDomSnippet` truncates HTML to 4000 chars after redaction. For dense DOMs, the snippet may not include the target element at all.

**E-M-16.** `content/replay.ts:189-216` `sanitizeNode` skips `<iframe>` content but does not skip `<style>` blocks' computed-style attribution. Resulting HTML can break healing because the AI sees half a `<style>`.

### §2.3 Frontend

**F-M-01.** `pages/DashboardPage.tsx:27-29` caps "Requires Attention" at 2 failed runs. If 30 runs are failing, 28 are invisible.

**F-M-02.** `pages/AuditPage.tsx:58-60` filter state is decoupled from refetch — changing the filter only re-derives an array; if the underlying `audit` is stale, filter changes are wasted.

**F-M-03.** `hooks/useRuns.ts:18` `useEffect([workflowId])` — when `workflowId` changes the previous fetch is not cancelled. Stale response can override fresh one (last-wins on the network).

**F-M-04.** `hooks/useWorkflows.ts:17` `useEffect([])` — never refetches; UI shows stale list after creating a workflow.

**F-M-05.** `pages/WorkflowDetailPage.tsx:40-50` `handleRun` uses `fetch` directly with a hardcoded `dev-api-key-change-in-production` and no error UI; if the run create fails, the user sees nothing.

**F-M-06.** `pages/WorkflowsPage.tsx:61` row click navigates with no `aria-pressed` or loading state, so a slow router can be triple-clicked.

**F-M-07.** `pages/ConnectorsPage.tsx:33-39` `handleTest` does not validate JSON, doesn't clear previous result; old "OK" persists when a subsequent test fails.

**F-M-08.** `pages/RunsPage.tsx:50` `toLocaleString()` displays times in the browser timezone with no zone hint — users in different zones disagree about timestamps.

**F-M-09.** `pages/AuditPage.tsx:72-83` run selector `<select>` has no aria-label, no description of what it's selecting.

**F-M-10.** `pages/AuditPage.tsx:154-192` expand-on-click expands an inline row instead of opening a drawer/modal. Long payloads jank the table.

**F-M-11.** `pages/AuditPage.tsx:168` hash preview shows `JSON.stringify(payload).slice(0,60)` — for a payload that begins with a long string, the preview is a chopped string and useless.

**F-M-12.** `frontend/vite.config.ts` proxy hardcoded to `localhost:8081` (correct for `make dev`) but `docker-compose.yml` runs backend on `:8000` (X-C-01). Docker frontend will not connect to backend.

### §2.4 Cross-cutting

**X-M-01.** `Makefile:37` `pytest tests/ -v --no-header --cov=. --cov-report=term-missing` — coverage report is text-only, no HTML/JSON, hard to consume in CI.

**X-M-02.** `Makefile:34` `make test` runs backend + extension + e2e; if extension build is broken, backend results are buried.

**X-M-03.** `Makefile:23-25` extension/frontend lint silently `|| true`s; ruff errors hide.

**X-M-04.** `.github/` exists but contents not enumerated. CI behavior is undocumented in `AGENTS.md`.

---

## §3 Minor bugs

### §3.1 Backend

**B-N-01.** `core/config.py:13` `cors_origins` default doesn't include `http://localhost:5173` (Vite default), so the frontend dev server is rejected by CORS unless `.env` overrides.

**B-N-02.** `core/config.py:9` `ai_api_key: str = ""` is fine, but `OpenAIProvider.__init__` does not validate non-empty before constructing.

**B-N-03.** `ai/client.py:34-46` `MockProvider.generate` returns `content="Mock response"` which is not valid JSON; if a caller `json.loads(...)` (as `HealingService.suggest_heal` does), they hit the `JSONDecodeError` branch. The test suite must be papering over this with a different mock.

**B-N-04.** `ai/client.py:57` `httpx.AsyncClient(timeout=60)` total timeout is 60s; should be split into `httpx.Timeout(connect=5, read=20, write=5, pool=5)`.

**B-N-05.** `ai/client.py:86-93` `confidence=0.0` hard-coded. The healing pipeline depends on confidence (PRD §13). The OpenAI provider never produces meaningful confidence — the field is decorative.

**B-N-06.** `api/v1/workflows.py:33` `AddStepRequest.selector_chain: dict | None` — but a chain is a list, not a dict.

**B-N-07.** `api/v1/workflows.py:225-228` `add_step` returns `{"id": ..., "step_index": ..., ...}` but not `selector_chain` — the round-trip is incomplete.

**B-N-08.** `api/v1/workflows.py:351-357` `_summarize_actions` does not handle empty `steps` (returns `"A workflow that performs "` with trailing space).

**B-N-09.** `api/v1/runs.py:60-64` `_error` always returns 404 unless `status` overridden. Many callers pass `409` for state errors; `404` is the wrong default for state errors.

**B-N-10.** `api/v1/runs.py:142-162` `pause_run` accepts `body: dict` (untyped). FastAPI emits a `body` parameter named `body` with type `dict`, which means the OpenAPI schema is `{}` — clients can't tell what shape to send.

**B-N-11.** `api/v1/events.py:22-24` `VALID_EVENT_TYPES` includes `copy|paste|tab_change` but the extension never emits these; backend accepts them, extension never produces them.

**B-N-12.** `api/v1/audit.py:46-53` `verify_chain` is called on every `GET /audit/{run_id}` request, which is O(n) and unindexed for hash recomputation. Long-running runs make this slow.

**B-N-13.** `api/v1/audit.py:54-66` event payloads are returned in full to the frontend with no pagination. A run with 10k events returns multi-MB JSON.

**B-N-14.** `services/audit.py:42-50` `AuditService.append` accepts `actor_type` as a free-form `str` with default `"system"`. The `ActorType` enum exists (`core/models/event.py:10-15`) but isn't enforced — code can write `"sustem"` (typo) and no one notices.

**B-N-15.** `services/audit.py:67-68` falls back to `compute_seed_hash(str(run_id) if run_id else "no-run")`. The literal `"no-run"` is shared across all pre-run audit events. Same critique as B-C-15.

**B-N-16.** `services/audit.py:89-94` `verify_chain` accepts `run_id` as `str` then converts inside — accept `uuid.UUID` to dodge half the conversion code.

**B-N-17.** `services/execution_service.py:24-27` instantiates `AuditService` and `WorkflowService` in `__init__` — same session, but coupling is total.

**B-N-18.** `services/execution_service.py:96-103` `pause_reason` is set on the model but a separate `audit.append` call follows; if the audit append fails, the row is left in a half-committed state.

**B-N-19.** `services/workflow_service.py:65-69` `update_status` writes audit with event_type `"checkpoint"` — wrong event type for a status change.

**B-N-20.** `services/workflow_service.py:101-107` imports `func` inside the method; should be top-level.

**B-N-21.** `services/healing_service.py:24-27` `PII_PATTERNS` for credit cards is `\b\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}\b` — does not catch 15-digit AmEx or 13-digit Visa.

**B-N-22.** `services/healing_service.py:67` `fallback = f"Step {step_index} ({old_selectors[0] if old_selectors else 'unknown'})"` is informational only but `old_selectors[0]` may be a long XPath. The prompt becomes huge.

**B-N-23.** `migrations/env.py` — not re-verified in this read.

**B-N-24.** `pyproject.toml` — not re-verified in this read; warning at `api/v1/ai.py:22` about `schema` shadowing BaseModel attribute should be fixed by renaming to `extraction_schema`.

### §3.2 Extension

**E-N-01.** `content/replay.ts:49-60` text-matching is case-insensitive but trims whitespace. Strings with internal newlines (e.g., button with `\n  Submit\n`) do not match.

**E-N-02.** `content/replay.ts:64-91` `findElementByAccessibility` parses as JSON then falls back to pipe-delim. The grammar is undocumented; backend producers don't know which to emit.

**E-N-03.** `content/replay.ts:86` `[role="${role.replace(/"/g, '\\"')}"]` is insufficient escaping. `CSS.escape(role)` should be used.

**E-N-04.** `content/replay.ts:142-148` `simulateType` calls `focus()` then `blur()` synchronously. Async focus listeners may not have run.

**E-N-05.** `content/replay.ts:151-157` does not dispatch `input` event for `<select>` — some frameworks listen for `input` not `change`.

**E-N-06.** `content/replay.ts:159-162` `simulateScroll` always centers — many flows need top-align.

**E-N-07.** `content/replay.ts:178-183` PII patterns miss IDN emails, international phone numbers, 9-digit US SSNs.

**E-N-08.** `content/replay.ts:189-223` `sanitizeNode` whitelists `data-testid`/`data-cy`/etc. but not `data-test-*` plurals. Inconsistent.

**E-N-09.** `content/replay.ts:243` slice(0,4000) truncates after redaction; redaction can produce shorter strings, leaving room.

**E-N-10.** `content/replay.ts:280` `(element as HTMLElement)?.focus()` — `hover` in PRD is a mouse move; `focus()` is keyboard.

**E-N-11.** `content/capture.ts:25-32` `text` is sliced to 200 chars; long button labels truncated.

**E-N-12.** `content/capture.ts:65-74` intent for `<input type="submit">` doesn't mention the form's action URL.

**E-N-13.** `content/capture.ts:78-87` `value.slice(0, 80)` for the intent is fine for display but the intent string is also indexed by the AI healer.

**E-N-14.** `content/capture.ts:213-225` `captureScroll` doesn't capture `event.target` (could be an inner scroll container).

**E-N-15.** `content/capture.ts:228-234` `getModifiers` doesn't expose `event.repeat` or `event.isComposing` (matters for IME).

**E-N-16.** `content/index.ts:73-91` `showReplayPanel` always pins to `bottom: 16px; right: 16px` — overlaps with site UI on right-aligned chat widgets, banners, etc.

**E-N-17.** `content/index.ts:117` `return true` from the message listener even when no message matched — keeps the channel open for nothing.

**E-N-18.** `content/index.ts:160-167` scroll debounce is fixed at 500ms; should be tuned or configurable.

**E-N-19.** `content/index.ts:175` `recordingEnabled = msg2.enabled ?? false` — also `eventCount = 0`. Stopping and restarting recording loses count even if events are still buffered.

**E-N-20.** `background/service-worker.ts:171-378` `executeWorkflowRun` is 200+ lines; impossible to test in isolation.

**E-N-21.** `background/service-worker.ts:380-385` `chrome.alarms.create("keepAlive", { periodInMinutes: 4 })` — Chrome SW idle timer is 30s, so 4 minutes is a no-op for keep-alive. The alarm handler does `chrome.storage.session.get("keepAlive")` which does nothing.

**E-N-22.** `background/healer.ts:55-77` fallback methods try `chrome.tabs.sendMessage` and ignore the error type. If the content script is missing, all fallback methods fail in turn.

**E-N-23.** `background/healer.ts:83-87` `(step as any).intent || step.value || ""` — typing loosened with `any`.

**E-N-24.** `background/detector.ts:39-54` `checkLoginForm` returns `confidence: 0.95` if any `input[type=password]` exists. Most websites with a hidden password field for "reset password" would trip this.

**E-N-25.** `background/detector.ts:82-103` `checkUnexpectedModal` checks `style.display !== "none"` AND `style.visibility !== "hidden"` AND `offsetWidth > 0`. Useful but misses `opacity: 0` modals (still rendered, just invisible).

**E-N-26.** `background/detector.ts:57-79` `checkTwoFactor` matches `name*="code"` which matches a "promo code" input. False positive.

**E-N-27.** `playwright.config.ts` — not re-read here; expected: workers and retries values that may be too low for flake.

**E-N-28.** `e2e/helpers/heal-provider.ts` — not re-read here; deterministic provider stubs out real AI for tests, by design. But there's no nightly job that switches to real AI.

### §3.3 Frontend

**F-N-01.** `components/Banner.tsx:23` uses inline `style={{ background: rgba(...) }}` instead of Tailwind tokens.

**F-N-02.** `components/Card.tsx:14` padding via string union; no compile-time exhaustiveness.

**F-N-03.** `components/StatusBadge.tsx:42-47` color via inline style; bypasses design tokens.

**F-N-04.** `components/EmptyState.tsx:16` icon color hardcoded `#6B7280`.

**F-N-05.** `components/DataTable.tsx:46` cursor:pointer applied unconditionally.

**F-N-06.** `hooks/useApi.ts:30` reads `data?.error?.message || data?.detail?.error?.message` — handles both shapes, but should normalize.

**F-N-07.** `pages/DashboardPage.tsx:23-25` sorts runs in JS — slow at 10k rows.

**F-N-08.** `pages/DashboardPage.tsx:42` "Loading..." text instead of skeleton.

**F-N-09.** `pages/RunsPage.tsx` no row click handler.

**F-N-10.** `pages/AuditPage.tsx:188` payload preview can be `[object Object]` for non-string payloads.

**F-N-11.** `pages/WorkflowDetailPage.tsx:110-111` selector display shows only `chain[0]`.

**F-N-12.** `pages/SettingsPage.tsx:28` `apiKey` initial state is `"sk-••••••••••••••••"` — literal bullet characters, not redacted real key.

**F-N-13.** `pages/SettingsPage.tsx:122-127` "Show / Hide" toggles `showKey` but value is `apiKey` state which never holds a real key.

### §3.4 Cross-cutting

**X-N-01.** `.env` template lists `AI_API_KEY=` blank but the field is required for healing to work. README/AGENTS does not flag this.

**X-N-02.** `Makefile:23-25` extension/frontend lint via `npx eslint src/ 2>/dev/null; true` — failures are silenced.

---

## §4 Code-quality issues

### §4.1 Backend

**B-Q-01.** `_to_uuid` is duplicated in `services/audit.py:29`, `services/execution_service.py:16`, and `api/v1/events.py:15`. Move to `core/utils.py`.

**B-Q-02.** Late imports: `api/v1/workflows.py:310-311`, `:389-390`; `api/v1/runs.py:209-210`, `:342-343`. Top-level imports preferred.

**B-Q-03.** No `logging.getLogger(__name__)` anywhere. Production debugging is blind.

**B-Q-04.** No docstrings on `WorkflowService`, `ExecutionService`, `AuditService`, `HealingService` classes or methods.

**B-Q-05.** Magic strings: `"draft"`, `"active"`, `"archived"` for workflow status. Make an enum, like `RunStatus`.

**B-Q-06.** `services/healing_service.py:30-39` `_normalize_selector` mutates and returns; behavior depends on input shape; consider a Pydantic model.

**B-Q-07.** `core/models/event.py:10-42` two enums (`ActorType`, `EventType`) defined but never used as DB column types; columns are `String(20)`/`String(30)`.

**B-Q-08.** `api/v1/runs.py:17` `_HEAL_OVERRIDES` is module state; tests poison each other.

**B-Q-09.** `api/v1/ai.py:22` "schema" field name shadows `BaseModel` attribute (warning every test run).

**B-Q-10.** `services/audit.py:38-87` `AuditService.append` parameter list is 8 long with overlapping concerns; consider a dataclass.

**B-Q-11.** `services/execution_service.py:158-169` `list_runs` returns ORM objects; the API endpoint then re-serializes — duplicate work, also leaks ORM details.

**B-Q-12.** No repository layer — services hit the session directly.

### §4.2 Extension

**E-Q-01.** `service-worker.ts` message handler uses `(message as unknown as Foo)` casts everywhere; the union type for messages is too loose.

**E-Q-02.** `healer.ts:84` `(step as any).intent` — `any` removed via typing fix.

**E-Q-03.** `orchestrator.ts` not re-read in this round but earlier audit flagged `_eventQueue` global state with no max size.

**E-Q-04.** `api.ts` constructs `headers` with hard-coded base URL.

**E-Q-05.** `content/replay.ts` has two `redactPII` implementations (one in `replay.ts`, one in `services/healing_service.py`); the regex sets differ.

**E-Q-06.** `content/replay.ts:262-296` `executeStep` switch lacks exhaustive type check; if `step.action_type` is `"submit"`, falls to `default`.

**E-Q-07.** `content/index.ts:115` `return true` outside switch — keeps the response channel open for the second listener too.

**E-Q-08.** `popup/App.tsx` (~672 lines reviewed in audit pass) is a single mega-component; settings UI in popup duplicates frontend Settings page.

**E-Q-09.** `manifest.json` lists `sidePanel` and `alarms` permissions but the `default_path` HTML at `dist/panel.html` is barely used.

**E-Q-10.** `vite.config.ts` not re-read in this round.

**E-Q-11.** `playwright.config.ts` not re-read in this round.

### §4.3 Frontend

**F-Q-01.** Duplicate error-display JSX in every page; extract `<ErrorState>`.

**F-Q-02.** Duplicate `new Date(...).toLocaleString()` — extract `formatTime()`.

**F-Q-03.** Types like `RunSummary`, `WorkflowSummary` defined per hook; should be shared.

**F-Q-04.** `useRuns` and `useWorkflows` differ only by URL; could be a generic `useResource(path)`.

**F-Q-05.** No `<Suspense>` boundaries.

**F-Q-06.** No memoization; even small lists re-render on every parent state change.

**F-Q-07.** Hard-coded color hex values across components; design tokens half-applied.

**F-Q-08.** `AppShell.tsx` and pages share layout responsibilities; not clean.

**F-Q-09.** No router-level loaders/actions despite React Router 7 supporting them.

**F-Q-10.** `useApi.ts` exposes both `useApi` (callback) and `useApiData` (state) — confusing.

### §4.4 Cross-cutting

**X-Q-01.** No `pre-commit` config (despite mention in AGENTS.md skills).

---

## §5 Test gaps

### §5.1 Already missing (no tests at all)

**T-G-01.** **Frontend has zero tests.** No vitest, no testing-library, no Playwright spec under `frontend/`.

**T-G-02.** **`/v1/connectors` endpoints** — connector CRUD is exercised lightly in `tests/integration/test_api_routes.py` but in-memory `_connectors` persistence is not tested across server "restarts".

**T-G-03.** **`/v1/debug/log` auth** — no test asserts that the endpoint is intentionally exempt and whether that's a security choice.

**T-G-04.** **CORS** — no test that a disallowed origin is rejected.

**T-G-05.** **Rate limiter** — no test that 600 requests in 60s get 429.

**T-G-06.** **Pagination bounds** — `limit=999999` and `offset=-1` are not validated and no test exists.

**T-G-07.** **Idempotency scope** — same key on two different runs both succeed; no test.

**T-G-08.** **Audit chain tampering** — `tests/unit/test_audit_hash.py` covers happy paths but no test directly UPDATEs a row and re-verifies.

**T-G-09.** **Concurrent state transitions** — no `asyncio.gather` race test.

**T-G-10.** **Healing confidence threshold** — no test of the threshold gate (because the gate doesn't exist).

**T-G-11.** **Workflow delete orphan-step bug** — no test.

**T-G-12.** **Migrations round-trip** — alembic up/down never exercised by CI.

**T-G-13.** **Odoo adapter** — real or mocked XML-RPC test for re-auth, pagination, timeout.

**T-G-14.** **AI provider failures** — no test for timeout, 400, malformed JSON.

**T-G-15.** **Extension `orchestrator.ts`** — no unit tests; only e2e.

**T-G-16.** **Extension `healer.ts`** — no unit tests.

**T-G-17.** **Extension `selectors.ts`** — partial unit tests (CSS only).

**T-G-18.** **Extension `detector.ts`** — zero tests, also dead code.

**T-G-19.** **Extension `capture.ts` password redaction** — no test.

**T-G-20.** **Extension React/Vue/Angular replay** — no test.

**T-G-21.** **Real AI healing** — every e2e healing test uses `DeterministicHealProvider`. Real provider untested.

**T-G-22.** **Multi-tab workflows** — no test.

**T-G-23.** **Iframe content** — no test.

**T-G-24.** **Shadow-DOM target** — no test.

**T-G-25.** **File upload** — no test.

**T-G-26.** **Slow network (3G)** — no test.

**T-G-27.** **Keyboard shortcut capture** — no test.

**T-G-28.** **Service-worker restart mid-recording** — no test.

**T-G-29.** **Recording cross-navigation** — no test.

**T-G-30.** **Frontend settings persistence** — no test (also no feature).

**T-G-31.** **Frontend run detail / replay viewer** — no test (also no feature).

**T-G-32.** **Frontend intervention modal** — no test (also no feature).

### §5.2 Weak tests (pass but don't test real behavior)

**T-W-01.** `tests/unit/test_state_machine.py` tests `WorkflowStateMachine.transition` via direct method calls, never via HTTP API.

**T-W-02.** `tests/unit/test_audit_hash.py:test_tamper_detection` tampers in Python (`event.payload = ...`) — doesn't test DB-level tampering (raw UPDATE).

**T-W-03.** Healing e2e tests inject overrides via `inject-heal-override` — they test the override path, not real heal flow.

**T-W-04.** SQLite is JSON-not-JSONB; PG-only constraints (CHECK, JSONB ops) are silently skipped.

**T-W-05.** `tests/conftest.py` shares one session per test with rollback — doesn't catch commit-order bugs.

### §5.3 Coverage targets vs reality

`Makefile` runs `pytest --cov=. --cov-report=term-missing`. Headline number is good (~76% per AGENTS.md), but coverage is concentrated in services and models; ai client, adapters, debug endpoint, integrations endpoint are <30% covered.

---

## §6 Architecture concerns

**A-01.** **Service worker is the orchestrator.** SW lifecycle is not durable; long workflows are at the mercy of Chrome's idle timer. Should be IndexedDB-backed with a worker that drives steps on a schedule.

**A-02.** **No repository layer.** Services hit `AsyncSession` directly; testing requires a DB.

**A-03.** **Detector in the wrong process.** It runs in the SW per the file location but it needs DOM access. Move to content script.

**A-04.** **Workflow snapshot is unversioned.** If `WorkflowStep` schema changes, old runs cannot be replayed.

**A-05.** **Adapter registry is import-time only.** Plugin loading would require dynamic imports.

**A-06.** **Message protocol has no version field.** Extension/backend upgrades can desync silently.

**A-07.** **AI provider is single-tenant.** No fallback to a second provider when the first errors.

**A-08.** **Healing service has no `human_approval` path.** Per PRD §13, low-confidence heals must require human confirmation; the data model has `HumanIntervention` but the flow doesn't use it for heal approval.

**A-09.** **Connector configs in-memory.** See B-M-12.

**A-10.** **No outbox / event queue.** Audit events written synchronously inside request transactions. Slow audit = slow API.

---

## §7 Security & privacy

**S-01.** **Insecure defaults** — see §1 top-10 #3.

**S-02.** **Password capture** — see §1 top-10 #5.

**S-03.** **XSS via shadow DOM `innerHTML`** — see E-C-03.

**S-04.** **XPath unrestricted** — see E-C-04.

**S-05.** **CORS too permissive for chrome-extension** — see B-C-13.

**S-06.** **No CSRF.**

**S-07.** **No CSP in manifest.**

**S-08.** **Broad `host_permissions`.**

**S-09.** **API key in `chrome.storage.session`** — readable to DevTools.

**S-10.** **Error messages leak exception details** — see B-C-10.

**S-11.** **No auth-failure rate limiting** — brute-force possible against weak default key.

**S-12.** **Secrets stored as plain `str`** — should use `pydantic.SecretStr` to avoid accidental logging.

**S-13.** **`/v1/runs/testing/inject-heal-override` ungated** — see B-M-06.

**S-14.** **`/v1/debug/log` ungated** — see B-C-11.

**S-15.** **Odoo password set to API key** — see B-M-11.

**S-16.** **Postgres password `workflow`** — see X-C-01.

**S-17.** **`secret_key` not used for anything** — but default value will eventually be used; pre-empt now.

**S-18.** **PII redaction regex is incomplete** — see B-N-21, E-N-07.

**S-19.** **`captureDomSnippet` includes `data-test*` and `data-cy` attributes** — these often contain user identifiers in test environments.

**S-20.** **No retention enforcement** — settings page has a retention slider that does nothing; old events accumulate forever.

**S-21.** **Audit chain broken-link reporting includes hashes** — `verify_chain` returns expected/actual hash; if exposed to unauth users, leaks rebuild info.

---

## §8 Performance

**P-01.** **Unbounded event buffer in SW** — `orchestrator.eventBuffer` grows without limit.

**P-02.** **N+1: GET /v1/workflows/{id}** — separate query for steps; no eager load.

**P-03.** **Odoo client re-auths on every call** — see B-M-09.

**P-04.** **Scroll handler debounced but not coalesced** — see E-N-18.

**P-05.** **Fixed 1s inter-step delay** — see E-M-05.

**P-06.** **DataTable does not virtualize** — slow at 1k rows.

**P-07.** **Audit page returns all events** — see B-N-13.

**P-08.** **`verify_chain` on every audit GET** — see B-N-12.

**P-09.** **In-memory rate limiter** — see B-C-12.

**P-10.** **No HTTP/2 from frontend** — vite dev server is HTTP/1.

**P-11.** **No connection pool tuning** — pool_size=10, max_overflow=20 is fine for dev but undocumented for prod.

**P-12.** **`async_session` shared across requests in tests** — fast but inaccurate.

---

## §9 PRD §7 compliance matrix

| PRD § | Requirement | Status | Evidence |
|---|---|---|---|
| 7.1 | Record click/type/select/submit/scroll/navigation/hover/copy/paste/tab_change | **PARTIAL** | submit, hover, copy, paste, tab_change declared (`shared/types.ts`) but no listener emits them. |
| 7.1 | Capture target metadata, surrounding text, a11y role/label, DOM ancestry/siblings, URL, title, screenshot before/after, timestamp, note, intent | **PARTIAL** | No screenshots in extension. No note UI. No siblings. Intent inferred via `buildIntent`. |
| 7.1 | Allow appending a high-level prompt after recording | **PARTIAL** | `/workflows/{id}/generate-prompt` exists but UI doesn't expose it. |
| 7.2 | Selector chain: a11y → stable attrs → text → semantic → DOM proximity → visual | **FAIL** | Order is CSS → text → a11y → xpath. No semantic, no proximity, no visual. |
| 7.3 | Self-healing: capture state, compare, deterministic recovery, semantic recovery, AI-assisted, validate target, retry safely, log every attempt | **PARTIAL** | Fallback methods + AI path exist. No semantic recovery. AI accepted at confidence 0.3 without policy. `recover()` is a stub (B-C-04). |
| 7.4 | Pause on CAPTCHA / login / 2FA / unexpected modal / missing element / page changed too much / ambiguous result | **FAIL** | Detector is dead code (E-C-06). UI has no pause/resume controls. |
| 7.5 | Generic adapter; Odoo first; reusable | **STUB** | `adapters/base.py` + `adapters/odoo/*.py` exist; credentials hardcoded; sync flow incomplete. |
| 7.5 | Minimum adapter actions (10 listed) | **PARTIAL** | Not all 10 wired in `OdooAdapter`. Need: `list_open_jobs`, `get_job_details`, `list_candidates`, `upsert_candidate`, `update_candidate_status`, `create_workflow_request`, `append_audit_event`, `attach_artifact`, `get_search_criteria`, `create_review_task`. |
| 7.6 | Append-only log: workflow id, user id, browser session id, action id, page url, page title, action intent, target details, execution result, AI calls, recovery attempts, user interventions, timestamps, artifact refs | **PARTIAL** | EventLog model exists. Hash chain implemented. Several fields stuffed into `payload` (action_id, intent, target details). `browser_session_id` is on `ExecutionRun` but not on `EventLog`. |
| 7.7 | Raw structured output + normalized records | **STUB** | `/v1/extract` endpoint exists but not integrated. |
| 7.8 | Workflow templates | **MISSING** | No template system. |
| 7.9 | Promptable workflows from recorded steps + prompt + context + outcomes | **PARTIAL** | `/workflows/{id}/generate-prompt` exists but doesn't feed back into a runnable workflow definition. |
| 13 | AI recovery: receive DOM + a11y + screenshot + state + intent + fallback set + previous attempts; return best target + confidence + explanation + next action + human-confirmation flag | **PARTIAL** | DOM + intent + old selectors sent. No a11y tree, no screenshot, no previous attempts. Returns selector + confidence + explanation but no `human_confirmation_required` flag and no enforcement. |

---

## §10 UI-UX-SPEC.md compliance matrix

| Spec § | Feature | Status |
|---|---|---|
| 2 | Top-bar live status (healthy/attention/failures) | Static "All Systems" |
| 2 | Global search | Not implemented |
| 2 | Sidebar with count badges | No badges |
| 2 | Breadcrumbs | Not implemented |
| 2 | Right-side drawer | Not implemented |
| 3.1 | KPI cards with trend indicators | KPI yes; trend no |
| 3.1 | "Requires Attention" section | Yes, capped at 2 |
| 3.2 | Workflow list table + grid toggle | Table only |
| 3.3 | Workflow detail tabs (Recovery Rules / Audit Evidence / Artifacts / Notes) | Not implemented |
| 3.3 | Step hover tooltip with selector, intent, last success | Not implemented |
| 3.4 | Recording view in dashboard | Not implemented (in extension only) |
| 3.5 | Replay/Run view with live event feed | Not implemented |
| 3.6 | Audit table with hash-on-hover, export | Hash truncated; no export |
| 3.6 | Filters: step / event type / status / AI / human | Only event-type filter |
| 3.7 | Human-intervention modal | Not implemented |
| 3.8 | Connector setup stepper (6 steps) | Basic form only |
| 3.9 | Settings: Policies, Retention, Team, API Keys, Notifications | All render; none persist |
| 4.1 | Extension popup record/run/pause/resume | Recording and run exist; pause/resume not exposed |

---

## §11 Recommended remediation order

| Priority | Effort | Item | Why |
|---|---|---|---|
| P0 | XS | Replace insecure defaults; fail-fast if `API_KEY`/`SECRET_KEY` unset in prod | Open door |
| P0 | S | Block password / cc-number capture in `capture.ts` | Privacy & compliance |
| P0 | S | Switch `replay.ts` to `nativeInputValueSetter` for inputs/textareas | Replay broken on React |
| P0 | S | Replace `innerHTML` with `textContent` in shadow-DOM panel | XSS |
| P0 | M | Enforce `ai_confidence_threshold` in `HealingService.suggest_heal`; expose `human_required` | PRD §13 |
| P0 | M | Add `sequence_number` + `UNIQUE(run_id, nonce)` to EventLog; rewrite `verify_chain` | Audit integrity |
| P0 | S | Wire `detectChallenges()` into the content script's runtime loop; pause run on detection | PRD §7.4 |
| P0 | S | Fix `WorkflowService.delete` to cascade | Data integrity |
| P0 | S | Add `ForeignKey` + `ondelete=CASCADE` on `WorkflowStep.workflow_id` and `ExecutionRun.workflow_id` | DB integrity |
| P0 | M | Port mismatch — pick `:8081` or `:8000`, fix everywhere | Docker is broken |
| P1 | S | `HealingService.recover` — implement, not stub | Endpoint advertised as working |
| P1 | S | Gate `/runs/testing/inject-heal-override` behind a debug flag | Test backdoor in prod |
| P1 | S | Gate `/v1/debug/log` behind auth | Log injection |
| P1 | M | `apply_heal` — `deepcopy` snapshot + `flag_modified` | Silent data loss |
| P1 | M | Move connectors out of `_connectors` dict into DB | Restart durability |
| P1 | M | Move rate limiter to Redis | Multi-worker correctness |
| P1 | M | Frontend: implement Run viewer + Audit drawer + Intervention modal | UX critical |
| P1 | M | Frontend: implement Settings persistence | Functional gap |
| P1 | S | Frontend: AbortController on all fetches | Memory / state leaks |
| P1 | S | Replace hardcoded API key fallbacks | Security |
| P2 | M | Add `logging.getLogger` everywhere; structured logs with `request_id` | Observability |
| P2 | M | Move tests to PostgreSQL via `testcontainers-postgres` | Test/prod parity |
| P2 | M | Convert workflow status to enum + state machine | Same robustness as run status |
| P2 | S | Document healing JSON contract; validate with Pydantic | Brittle today |
| P2 | M | Implement workflow templates (PRD §7.8) | Spec gap |
| P3 | L | Repository pattern + use-case layer | Long-term maintainability |
| P3 | L | Plugin / entry-point adapter registry | Reusability |
| P3 | L | Schema-versioned workflow snapshots | Replay across breaking changes |

---

## Appendix A — files audited

`backend/`: `api/main.py`, `api/v1/{ai,audit,connectors,debug,events,integrations,runs,workflows}.py`, `core/{config,database,exceptions,state_machine}.py`, `core/models/{base,event,intervention,run,workflow}.py`, `services/{audit,execution_service,healing_service,workflow_service}.py`, `ai/{client,prompts}.py`, `adapters/{base,registry}.py` (+ `adapters/odoo/{adapter,client}.py` via prior agent), `migrations/versions/*.py`, `tests/**/*.py`, `pyproject.toml`, `Dockerfile`.

`extension/`: `manifest.json`, `popup/{App.tsx,index.tsx}`, `panel/index.tsx`, `src/background/{api,detector,healer,orchestrator,service-worker}.ts`, `src/content/{capture,index,replay,selectors}.ts`, `src/shared/{logger,messaging,types}.ts`, `tests/test_capture.test.ts`, `e2e/**/*.{ts,spec.ts}`, `vite.config.ts`, `playwright.config.ts`, `package.json`.

`frontend/`: `src/{AppShell.tsx,main.tsx,index.css}`, `src/components/*.tsx`, `src/hooks/*.ts`, `src/pages/*.tsx`, `vite.config.ts`, `package.json`.

Cross-cutting: `Makefile`, `docker-compose.yml`, `.env.example`, `.gitignore`, `.dockerignore`, `AGENTS.md`, the PRD, `UI-UX-SPEC.md`.

## Appendix B — methodology

1. Three concurrent `Explore` audit agents (backend / extension / frontend).
2. Direct verification of every claim that names a file:line: a finding is reported here only if I read the file and confirmed it.
3. Severity classification:
   - **Critical** — security, data loss, or a core feature is not present at runtime.
   - **Major** — feature is present but visibly broken in common conditions; or non-trivial workaround required.
   - **Minor** — edge-case failure; user can usually proceed.
   - **Code-quality** — code works but is hard to maintain or reason about.
   - **Test gap** — feature has no test, or only a mock-based test that papers over real behavior.
   - **Spec gap** — feature is required by PRD or UI-UX-SPEC but not present.
   - **Security / privacy** — distinct lens; many overlap with Critical/Major.
   - **Performance** — slow today or scales badly.
4. Findings that could not be confirmed by reading the actual file are not included even if mentioned by the audit agents.

## Appendix C — finding ID prefixes

- **B-C-**, **E-C-**, **F-C-**, **X-C-** — Critical (backend/extension/frontend/cross-cutting).
- **B-M-**, **E-M-**, **F-M-**, **X-M-** — Major.
- **B-N-**, **E-N-**, **F-N-**, **X-N-** — Minor.
- **B-Q-**, **E-Q-**, **F-Q-**, **X-Q-** — Code quality.
- **T-G-**, **T-W-** — Test gaps / weak tests.
- **A-** — Architecture.
- **S-** — Security / privacy.
- **P-** — Performance.

These IDs are stable and are referenced from `TESTING_STRATEGY.md` and from every new test that documents a current bug.
