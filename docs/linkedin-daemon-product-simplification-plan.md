# LinkedIn Daemon Product Simplification Plan

Generated: 2026-06-05

Branch: `simplify-linkedin-daemon-product`

## Goal

Refocus the product around the path that is actually used now:

1. Odoo job signal or manual operator action creates a LinkedIn daemon run.
2. The targeted daemon uses the protected LinkedIn session.
3. The daemon runs lightweight LinkedIn lead sourcing by default.
4. Leads are pushed to Odoo.
5. The operator can clearly see daemon health, run progress, extracted leads, push status, and failures.

The generic recorder/replay/AI platform should remain available for engineering and future workflows, but it should stop being the primary daily operator surface.

## Sequential-Thinking Review Summary

The plan was reviewed with sequential thinking before writing:

- Keep the proven daemon path intact first; do not start with a daemon rewrite.
- Make `linkedin_lead_search` visible and configurable before removing anything.
- Move broad workflow-builder controls behind advanced/operator tooling.
- Modularize the daemon after the product path is stable.
- Do not weaken anti-bot, routing, heartbeat, debug, or reconciliation safeguards.

## Current Architecture Snapshot

### Core Flow

```text
Odoo webhook or reconciler
  -> WebhookTriggerService.fire_from_odoo_payload()
  -> ExecutionRun(status=queued, origin={event_kind, job_payload, target_operator})
  -> driver-daemon polls /v1/runs for queued/running/recovering work
  -> daemon claims queued run via POST /v1/runs/{id}/start
  -> daemon drives LinkedIn
  -> daemon posts extraction events and step results
  -> ExecutionService completes run
  -> terminal hook pushes leads/applicants to Odoo
  -> frontend shows run details
```

### Two LinkedIn Flows

`linkedin_lead_search` is the default path we should optimize:

- Searches LinkedIn People results.
- Extracts `name`, `headline`, and `profile_url`.
- Visits no profiles.
- Has no `for_each`.
- Does not run Easy Recruit scoring.
- Pushes to `/akcr/api/linkedin_lead`.

`new_job_position` is the heavier advanced path:

- Searches LinkedIn People results.
- Extracts profile URLs.
- Visits profiles and detail pages.
- Expands `for_each`.
- Extracts full profile sections.
- Pushes applicants to `/akcr/api/linkedin_applicant`.
- Triggers synchronous Easy Recruit scoring in Odoo.

## Guiding Decisions

- Default to lightweight lead sourcing.
- Treat full applicant scraping/scoring as an explicit advanced mode.
- Preserve all account-protection mechanisms.
- Preserve generic workflow/replay code until the LinkedIn product path is stable.
- Prefer hiding/moving low-use features before deleting them.
- Make the operator UI say what the system is doing in product terms, not platform internals.

## Phase 1: Make Lead Sourcing First-Class

Objective: the current primary flow should be visible, configurable, and inspectable without scripts or database knowledge.

### Backend Changes

- Return `linkedin_leads` from `GET /v1/runs/{run_id}`.
- Add a lightweight `POST /v1/runs/{run_id}/refresh-leads` endpoint if Odoo lookup exists or can be added cheaply; otherwise explicitly mark lead snapshots as push-time-only.
- Allow `CreateTriggerRequest.event_kind` to accept all supported event kinds, not only `new_job_position`.
- Add validation that prevents multiple enabled LinkedIn triggers on the same connector unless explicitly overridden.
- Add a convenience endpoint for the current product path:
  - `POST /v1/linkedin-sourcing/triggers`
  - `GET /v1/linkedin-sourcing/status`
  - Optional if we want to avoid new APIs initially: implement the same behavior using existing webhook trigger APIs and a frontend view model.

### Frontend Changes

- Add a `LinkedIn Sourcing` page or dashboard panel focused on:
  - Connector.
  - Enabled trigger.
  - Trigger event kind.
  - Target operator.
  - Daemon status.
  - Account cooldown/circuit reason.
  - Latest job payload.
  - Latest run.
  - Leads pushed to Odoo.
- Render a `LinkedIn Leads Pushed to Odoo` card for `origin.event_kind === "linkedin_lead_search"` on Run Detail.
- Show lead rows with:
  - Name.
  - Headline.
  - LinkedIn URL.
  - Odoo URL.
  - Push status.
  - Refreshed/pushed timestamp.
- In Workflow Detail automation triggers, support selecting `linkedin_lead_search`.
- Make `LinkedIn Lead Search` the preferred/default trigger kind for Odoo job publish flows.

### Acceptance Criteria

- A completed `linkedin_lead_search` run shows leads in Run Detail without opening raw extraction events.
- A user can create or repair a `linkedin_lead_search` trigger from the UI.
- UI clearly warns when more than one trigger would fire for the same connector.
- Daemon down/cooldown states are visible before an operator fires a manual run.
- Existing `new_job_position` applicant flow still works when explicitly configured.

### Files To Touch First

- `backend/api/v1/runs.py`
- `backend/api/v1/webhooks.py`
- `backend/services/webhook_trigger_service.py`
- `frontend/src/pages/RunDetailPage.tsx`
- `frontend/src/pages/WorkflowDetailPage.tsx`
- `frontend/src/pages/ConnectorsPage.tsx`
- Optional new page: `frontend/src/pages/LinkedInSourcingPage.tsx`

## Phase 2: Simplify the Daily Operator UI

Objective: daily operators should see product concepts, not workflow-platform internals.

### Move Behind Advanced UI

- Semantic/literal workflow views.
- Re-analyze.
- Edit extraction fields.
- Connector binding editor.
- Message template editor.
- Promote workflow.
- Raw step list.
- Generic run goal modal.
- Load browser session toggle.
- Run-as-recorded/parameter modal complexity.

### Keep Visible In Daily Path

- Run now.
- Latest run status.
- Daemon/operator health.
- Account cooldown.
- Job title and candidate/lead count.
- Leads/applicants pushed.
- Screenshots/debug artifacts for failed runs.
- Human intervention reason and recovery action.

### Connector UI Simplification

- Show Odoo as the supported connector.
- Hide Salesforce, HubSpot, and custom connector creation until implemented.
- Keep existing backend model permissive if needed, but do not advertise unsupported connector types in the daily UI.

### Acceptance Criteria

- A recruiter/operator can fire and inspect LinkedIn sourcing without touching semantic analysis, bindings, or raw steps.
- Advanced controls remain available for engineering, but are visually separated.
- Unsupported connector options are not presented as production-ready.

## Phase 3: Tighten LinkedIn Trigger Semantics

Objective: prevent accidental double-runs and make event-kind behavior obvious.

### Changes

- Enforce one enabled LinkedIn trigger per connector by default.
- Surface the active trigger directly on the connector card.
- Add explicit labels:
  - `Lead sourcing: search results only`
  - `Applicant scraping: visits profiles and runs Easy Recruit scoring`
- Add a confirmation warning before enabling applicant scraping.
- Preserve seed scripts as repair tools, not the main setup path.

### Acceptance Criteria

- Enabling lead sourcing disables or prompts to disable old applicant trigger.
- Manual trigger uses the configured event kind, never a hardcoded fallback.
- The UI explains the cost/risk difference between lead and applicant flows.

## Phase 4: Daemon Modularization

Objective: reduce risk in `extension/driver-daemon.mjs` without changing behavior.

### Proposed Modules

```text
extension/daemon/main.mjs
extension/daemon/backend-client.mjs
extension/daemon/run-poller.mjs
extension/daemon/account-guard.mjs
extension/daemon/debug-capture.mjs
extension/daemon/browser-context.mjs
extension/daemon/flows/linkedin-lead-flow.mjs
extension/daemon/flows/linkedin-applicant-flow.mjs
extension/daemon/flows/generic-runner.mjs
extension/daemon/linkedin/search-results.mjs
extension/daemon/linkedin/profile-extract.mjs
```

### Keep Behavior Stable

- Preserve heartbeat payload.
- Preserve operator routing.
- Preserve queued claim path.
- Preserve circuit breaker and budget file behavior.
- Preserve screenshot/debug artifact behavior.
- Preserve lead-flow page 2 direct navigation behavior.
- Preserve applicant flow and `for_each` behavior until separately retired.

### Suggested Extraction Order

1. Extract backend client and retry helpers.
2. Extract account guard/circuit helpers.
3. Extract debug capture and step screenshots.
4. Extract LinkedIn search-result scraping.
5. Extract lead flow.
6. Extract applicant flow.
7. Extract generic runner.
8. Shrink `driver-daemon.mjs` to process bootstrap and poll loop.

### Acceptance Criteria

- Existing daemon tests pass.
- No change to default env behavior.
- A live or harness lead run produces equivalent extraction/push output before and after modularization.
- Failure screenshots and heartbeat still work.

## Phase 5: Defer or Demote Low-Use Features

These should not be deleted first. Mark them advanced, experimental, or hidden from the daily path.

### Defer

- Generic browser-session daemon runs.
- AI agent replay for non-LinkedIn sites.
- AI plan mutation for LinkedIn daemon runs.
- Full applicant profile scraping as default behavior.
- Outreach draft opening.
- Analyze Page as a recruiter-facing feature.
- Salesforce/HubSpot/custom connector UI.
- Workflow promotion and public workflow library concepts.

### Keep But Restrict

- Recovery supervisor should remain for stale runs, but LinkedIn blockers should primarily pause and trip circuit rather than AI-mutate the plan.
- Generic recorder/replay should remain for engineering and future workflows, not recruiter daily operation.
- Full applicant scraping should require explicit operator confirmation.

## Phase 6: Documentation and Runbooks

Objective: align docs with the product reality.

### Update Docs

- `docs/recruitment-automation-flow.md`
  - Split default lead sourcing from advanced applicant scoring.
  - Make `linkedin_lead_search` the first documented path.
- `docs/system-architecture-flow.md`
  - Add lead push path.
  - Update Odoo integration table to include both event kinds.
- `CLAUDE.md`
  - Keep operational notes, but avoid burying the current flow under older applicant docs.
- Add a short operator runbook:
  - How to verify daemon.
  - How to verify active trigger.
  - How to fire a run.
  - How to inspect leads.
  - How to handle cooldown/checkpoint.

## What Not To Change Early

- Do not weaken anti-bot pacing, budget gates, working-hour gates, or circuit breaker.
- Do not remove operator routing.
- Do not remove daemon heartbeat/status.
- Do not remove reconciler.
- Do not delete applicant flow until lead flow has stable UI and live proof.
- Do not rewrite the whole daemon before lead visibility is fixed.
- Do not make AI recovery more aggressive on LinkedIn.

## Validation Plan

### Static

- `make lint`
- Frontend typecheck through existing lint/build target.
- Targeted backend tests:
  - webhook trigger event-kind validation.
  - run response includes `linkedin_leads`.
  - lead trigger conflict guard.
- Targeted frontend tests:
  - Run Detail renders lead card.
  - Workflow Detail creates lead trigger.
  - Connector page shows active trigger type.

### Harness

- Use existing seed scripts to create/repair lead workflow.
- Run local connector/lead harness where available.
- Confirm a completed lead run stores:
  - extraction events.
  - `run.linkedin_leads`.
  - Odoo lead push response.

### Live Proof

Required before accepting browser/daemon behavior changes:

- Verify daemon status is up for target operator.
- Fire one controlled `linkedin_lead_search` run.
- Confirm terminal status.
- Confirm leads visible in dashboard.
- Confirm leads created in Odoo.
- Confirm no profile visits occurred for lead flow.
- Confirm no account circuit/cooldown regression.

## Proposed Work Breakdown

### PR 1: Lead Output Visibility

- Return `linkedin_leads` from run API.
- Render lead results in Run Detail.
- Add tests.

### PR 2: First-Class Lead Trigger Setup

- Permit supported event kinds in trigger creation.
- Add UI selector/default for `linkedin_lead_search`.
- Add guard/warning for multiple active triggers on connector.
- Add tests.

### PR 3: LinkedIn Sourcing Dashboard Surface

- Add dedicated page/panel.
- Show daemon, connector, active trigger, latest run, cooldown, and lead count.
- Keep advanced workflow internals one click away.

### PR 4: Daily UI Simplification

- Hide unsupported connectors.
- Move advanced Workflow Detail controls behind an Advanced section.
- Simplify primary run action labels around product flows.

### PR 5: Daemon Module Split

- Extract helper modules with no behavior changes.
- Add focused unit tests around extracted modules.
- Validate one lead run end to end.

### PR 6: Advanced Flow Cleanup

- Mark applicant scraping and outreach drafts advanced.
- Decide whether `DAEMON_GENERIC_PREAMBLE` is still needed.
- If generic path is not live-used, leave disabled and documented rather than deleting immediately.

## Success Criteria

- The product can be explained as "LinkedIn Sourcing" instead of "generic session replay."
- Lead sourcing can be configured from the UI.
- Lead results are visible without raw event inspection.
- The daemon remains protected by operator routing, budgets, circuit breaker, heartbeat, and debug capture.
- Advanced/generic platform features are still available but no longer dominate the daily path.
