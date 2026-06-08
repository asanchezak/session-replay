# Recruiter (/talent) ↔ Odoo integration — DESIGN

Status: **DESIGNED 2026-06-08, NOT wired** (Odoo deliberately disconnected for now).
This is the design for closing the loop between Odoo job positions and the promoted
Recruiter sub-workflows. Build it later; this doc is the contract.

## The loop

```
Odoo hr.job published (linkedin_sync=True, is_published=True)
   │   reconcile_supervisor / new_job_position webhook  (ALREADY polls hr.job, dedups by job_id)
   ▼
[1] CREATE-PROJECT run            name = "-EZ " + <position>   (runtime param)
   │   → Recruiter project created; run captures /talent/hire/<id> URL (extract step)
   │   → push  POST /akcr/api/job_project_link {job_id, recruiter_project_url}
   ▼   → Odoo sets hr.job.recruiter_project_url                      ── requirement C (NEW)
[2] SEARCH run                    (advanced/param search → candidate cards)
   │   → extract {name, headline, profile_url(/talent/profile/…)}
   │   → push  POST /akcr/api/linkedin_lead {job_id, source_run_id, leads:[…]}
   ▼   → Odoo creates linkedin.lead (outreach_status=not_contacted)  ── requirement A (EXISTS)
[3] SAVE-TO-PROJECT run(s)        (add chosen candidates into the -EZ project)
   ▼
[4] BULK-MESSAGE-SEND run         (to project candidates NOT yet messaged)
   │   → push  POST /akcr/api/lead_outreach_update {job_id, messaged:[profile_url…]}
   ▼   → Odoo sets matching linkedin.lead.outreach_status=sent, sent_at  ── requirement B
```

The four workflows already exist + are promoted to system (search `5bdc4d51`, save-to-project
`4da44557`, archive `77f6095c`, bulk-message-send `276a125b`, create-project `dd8fe22d`).

## Requirement mapping

| Req | What | State |
|---|---|---|
| **A** | candidate name → Odoo | ✅ EXISTS (`linkedin_lead_push_service` → `/akcr/api/linkedin_lead` → `linkedin.lead`: name, headline, profile_url, job_id, source_run_id) |
| **B** | track "already messaged?" | ⚠️ field exists (`linkedin.lead.outreach_status`, returned by the controller) — GAP: nothing **sets it to sent**. Need a push-back after a message-send run + (bonus) skip already-sent in the message flow. |
| **C** | project link → job position | 🆕 NEW: capture the created project URL (workflow extract step) + push it to a new `hr.job.recruiter_project_url`. |

## Pieces to build (when wiring)

### 1. Param substitution — the unlock (backend, this repo)
- `run-with-params` already accepts `runtime_params`, but the daemon reads **raw** `workflow_snapshot.steps`.
- Fix: at **run creation**, apply `template_service.substitute_parameters` over each step's `value`
  using `runtime_params`, and store the **substituted** steps in the run snapshot. Daemon reads them as-is.
- Workflow step values become templates, e.g. create-project name = `-EZ {{position_name}}`;
  `runtime_params = {position_name: "Full Stack Developer"}` → `-EZ Full Stack Developer`.
- **Backend-only change (run creation)** → redeploy backend, daemon untouched → **warm /talent seat preserved.**

### 2. Workflow tweaks (this repo)
- **create-project**: (a) name step uses `-EZ {{position_name}}` placeholder; (b) add an **extract step
  after Create** to capture the new project URL (`recruiter_search_people` returns `url`, or a tiny
  `capture_url` strategy) into `extracted_data`.
- **search**: build the **advanced/parameterized** version (keyword/skills/years/lang as params) so it
  searches per-position; results carry `/talent/profile/` urls.
- **bulk-message-send**: stamp `origin.event_kind=bulk_message_send`; (future) filter to leads with
  `outreach_status != sent`.

### 3. Push services + terminal hooks (backend, this repo)
On run completion (`ExecutionService.transition` terminal hook, keyed by `origin.event_kind`):
- `create_recruiter_project` → **job_project_link_push_service**: POST `{job_id, recruiter_project_url}` → `/akcr/api/job_project_link`.
- `linkedin_lead_search` → `linkedin_lead_push_service` (**EXISTS**).
- `bulk_message_send` → **lead_outreach_update_push_service**: POST `{job_id, messaged:[profile_url…]}` → `/akcr/api/lead_outreach_update`.
- ⚠️ Follow the **commit-before-await** rule (CLAUDE.md): commit the outer session before the slow
  HTTP push, or use a separate `async_session_factory()` session — never `await` an HTTP call while
  holding the `SELECT … FOR UPDATE` on the run row (causes the idle-in-transaction chain).

### 4. Trigger (backend, this repo)
- Extend `new_job_position` handling (`WebhookTriggerService` / `reconcile_supervisor`): on a new
  position, enqueue a **create-project run** (`event_kind=create_recruiter_project`,
  `runtime_params={position_name}`, `origin.job_id`).
- **Dedup**: skip if `hr.job.recruiter_project_url` is already set (or a create-project run already
  exists for that `job_id`) — reuse the existing `_find_run_by_job_id` pattern.
- Whether the same position also auto-fires search/message, or those stay manual, is an open decision.

### 5. Odoo / akodoo side (separate repo — deferred, Odoo not connected)
- `linkedin.lead`: confirm `outreach_status` (not_contacted | sent | replied); add `sent_at` (Datetime).
- `hr.job`: add **`recruiter_project_url`** (Char) [+ optional `recruiter_project_id`].
- akcr controllers (siblings of `/akcr/api/linkedin_lead`, same `akcr.linkedin_ingest_api_key`):
  - `POST /akcr/api/job_project_link` → set `hr.job.recruiter_project_url`.
  - `POST /akcr/api/lead_outreach_update` → set matching leads' `outreach_status=sent`, `sent_at`.

## Keying / matching (the subtle part)

- `linkedin.lead` is keyed by **(job_id, profile_url)**. For the **Recruiter** flows the profile_url is a
  **`/talent/profile/<id>`** URL (the search extractor + the candidate cards), NOT a public `/in/` URL.
  Keep keying consistent on the `/talent/profile/` URL across search-push and outreach-update so they match.
  (Note: the *existing* linkedin.com lead flow uses public `/in/` urls — a different surface; don't mix the two.)
- The **bulk-message-send** run messages a project's candidates (by name/checkbox); to update the right
  leads it must carry **job_id + the messaged `/talent/profile/` urls**. The send workflow already
  selects the project's candidates — capture their profile urls (extract) so the outreach push can match.
- **Dedup of outreach**: with `outreach_status`, the message flow can later select only `not_contacted`
  candidates (skip anyone already messaged) — avoids double-messaging.

## Build order (when wiring)
1. Param substitution (#1) + create-project URL capture (#2a) — foundation; backend-only, seat-safe.
2. akodoo #5 (hr.job field + 2 endpoints + lead sent_at) — needs Odoo deployed.
3. Push services + terminal hooks (#3).
4. Trigger (#4) → end-to-end: new position → -EZ project → linked → sourced → messaged → status tracked.
5. Advanced/param search (#2) for real per-position sourcing.

## Open decisions (need a call before wiring)
- **Naming**: confirm `-EZ <position>` (prefix) and exact format (spacing, dedup-friendly).
- **Trigger scope**: does `new_job_position` create the project ONLY, or also auto-source (search) +
  auto-message? (Recommend: auto-create + auto-source; **keep message-send manual / gated** — it sends real InMail.)
- **Outreach matching key**: confirm `/talent/profile/` url as the join key for leads ↔ messaged candidates.
- **One project per position**: dedup via `hr.job.recruiter_project_url` presence (recommended).
