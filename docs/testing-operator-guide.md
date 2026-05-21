# Testing Operator Guide

Practical guide for the next agent working in `session-replay`.

This is not a replacement for `TESTING_STRATEGY.md`. That file describes the
test pyramid and desired coverage. This guide is about how to get real proof
quickly, how not to fool yourself, and what usually goes wrong.

## Core testing rule

When the feature crosses backend, extension, and browser boundaries, test it
against the live system and prefer end-to-end tests.

In practice that means:

- run the browser proof outside the sandbox when sandboxed browser execution is
  known to be unreliable
- use the real backend on `:8081`
- use the built extension artifact
- use Playwright E2E for the final acceptance proof

Do not stop at unit tests, mocked integration tests, or API-only run creation
when the user is asking whether the browser actually completed a workflow.

## What counts as proof

Do not treat these as equivalent:

- `run-with-params` returned `200`
- a run record exists
- a run reached `running`
- a browser workflow actually completed
- the target message was actually sent

For connector-backed messaging workflows, meaningful proof is:

1. Odoo preview resolves a real job.
2. The resolved message is persisted into `resolved_parameters`.
3. The browser run completes.
4. The send step succeeds with the resolved message.

If you only prove step 1 or 2, you have not proved the feature.

For this class of feature, the final proof should be an E2E run against the
live system.

## Recommended debugging order

Use this order. It is faster than bouncing between frontend, backend, and E2E blindly.

1. **Check the workflow record**
   - status
   - steps
   - analysis
   - connector binding
2. **Check preview**
   - connector preview endpoint
   - resolved job title / description
3. **Check `run-with-params`**
   - `resolved_parameters`
   - `connector_resolution`
   - execution plan substitution
4. **Check browser execution**
   - run status
   - current step index
   - run events
5. **Only then inspect UI screenshots / Playwright output**

This avoids spending time on browser symptoms when the backend contract is wrong.

## Commands that are worth memorizing

### Backend health

```bash
curl -s http://localhost:8081/v1/health
```

### Read API key

```bash
sed -n 's/^VITE_API_KEY=//p' frontend/.env
```

### Inspect a workflow

```bash
curl -s -H "X-API-Key: <API_KEY>" \
  http://localhost:8081/v1/workflows/<workflow_id> | python3 -m json.tool
```

### Inspect analysis

```bash
curl -s -H "X-API-Key: <API_KEY>" \
  http://localhost:8081/v1/workflows/<workflow_id>/analysis | python3 -m json.tool
```

### Preview a saved connector binding

Important: the current preview route still expects the full binding payload.
Do not assume `POST {}` will work.

```bash
curl -s -X POST \
  -H "X-API-Key: <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "connector_id": "<connector_id>",
    "source_kind": "odoo_latest_job",
    "template": "Hi, we are hiring for {job_title}\n\n{job_description}",
    "job_filters": {},
    "enabled": true
  }' \
  http://localhost:8081/v1/workflows/<workflow_id>/connector-bindings/recipient/preview \
  | python3 -m json.tool
```

### Inspect latest runs

```bash
curl -s -H "X-API-Key: <API_KEY>" \
  "http://localhost:8081/v1/runs?limit=5" | python3 -m json.tool
```

### Inspect a run

```bash
curl -s -H "X-API-Key: <API_KEY>" \
  http://localhost:8081/v1/runs/<run_id> | python3 -m json.tool
```

### Inspect run events

```bash
curl -s -H "X-API-Key: <API_KEY>" \
  "http://localhost:8081/v1/runs/<run_id>/events?limit=120" | python3 -m json.tool
```

### Start backend after code changes

```bash
make dev-backend
```

### Rebuild the extension after TypeScript changes

```bash
cd extension && npx vite build
```

### Run the live LinkedIn proof

```bash
cd extension
RUN_LINKEDIN_LIVE_E2E=true npx playwright test e2e/linkedin-odoo-bound-run.spec.ts --retries=0
```

Use the live Playwright path outside the sandbox when necessary. For this repo,
that is often the difference between proving the browser flow and only proving
API behavior.

## Non-obvious rules for this repo

### 1. Restart the backend after runtime changes

If you change:

- backend execution logic
- site adapter compilation
- connector resolution
- API response shape used by the live flow

restart `:8081` before trusting any new run.

Otherwise you may be debugging stale process state and draw the wrong conclusion.

### 2. Rebuild the extension after extension changes

Playwright E2E loads the built extension artifact in `extension/dist`.

If you change:

- `extension/src/background/**`
- `extension/src/content/**`
- `extension/src/background/site-adapters/**`

run `npx vite build` before rerunning E2E.

If you forget, you may think your patch failed when the browser is still running old code.

### 3. A completed backend run is not the same as a visible page scrape

The most reliable evidence for “message was sent” is usually:

- run status is `completed`
- send step event exists
- send step event has `success: true`
- resolved message in `resolved_parameters` matches the connector preview

Scraping the final page body can be useful, but it is often noisier than the run events.

## Live proof pattern for connector-backed LinkedIn messaging

Use this pattern when proving the feature end to end:

1. Fetch the workflow.
2. Fetch the saved connector binding.
3. Call preview with the binding payload.
4. Assert preview returned:
   - `job_id`
   - `job_title`
   - `job_description`
   - `resolved_value`
5. Start the browser run through the extension, not just the API.
6. Poll `/v1/runs/<run_id>`.
7. Assert:
   - `status == completed`
   - `current_step_index == total_steps`
   - `resolved_parameters.recipient == preview.resolved_value`
8. Pull run events and assert the send step succeeded.

That is the shortest path to credible proof.

## Known false-failure patterns

### False failure: backend is stale

Symptoms:

- latest run still behaves like an old bug
- event payloads still show old command shape or old success conditions

Fix:

- restart backend

### False failure: extension is stale

Symptoms:

- browser behavior ignores a fresh TypeScript patch
- Playwright reruns keep failing in the exact old way

Fix:

- rebuild `extension/dist`

### False failure: preview route called with empty body

Symptoms:

- preview returns `422`
- missing `connector_id` or `template`

Fix:

- send the saved binding payload explicitly

### False failure: post-run page scrape is too brittle

Symptoms:

- run completed
- send step succeeded
- final page assertion still says the message was not present

Fix:

- prefer run-event evidence over generic `body.innerText` checks

### Real failure: type-step draft verification on LinkedIn

What happened in this session:

- draft verification on the LinkedIn composer was less reliable than send confirmation
- the better invariant was to prove the send step, not the draft text mirror

Implication:

- if a type-step check is flaky but send-step proof is strong, treat the send step as authoritative

## Practical tips for run-event debugging

When a live browser run fails, look for these event types first:

- `agent_decision`
- `script_executed`
- `step_executed`
- `recovery_failure`

Questions to answer:

1. Did the adapter compile the expected operation?
2. Did the injected script actually run?
3. Did the step fail because the command was wrong or because the success condition was wrong?
4. Is the browser page wrong, or is the verifier wrong?

That distinction matters. In this session, the browser could type and send, but the draft verification logic was the broken part.

## How to decide whether to write a new E2E

Write a new E2E when all of these are true:

- the feature crosses backend + extension + browser boundaries
- unit and integration tests can prove substitution but not execution
- the user explicitly wants live proof

Also prefer E2E when the acceptance question is phrased as:

- “did the browser complete?”
- “was the message actually sent?”
- “does this work on the real site?”

Do not write a new E2E just to prove an API payload shape.

## Suggested acceptance template for future agents

Use this structure in final validation notes:

1. **Backend substitution**
   - connector preview result
   - resolved parameter value
2. **Browser execution**
   - run id
   - terminal status
   - total steps completed
3. **Message proof**
   - send step event succeeded
   - message resolved from the expected source record
4. **Known limitations**
   - what was not proven

## Improvements worth making

These are worth doing if you touch this area again:

1. Add a real “preview saved binding” endpoint that does not require resending the binding body.
2. Add a small helper script for:
   - fetching API key
   - previewing a workflow binding
   - tailing a run and its send-step events
3. Add a preflight check before live E2E:
   - backend reachable
   - extension rebuilt recently
   - LinkedIn session file exists
4. Add a run-event filter endpoint or CLI helper so agents do not have to scrape large event payloads manually.

## Bottom line

When testing this repo, the fastest path is:

- prove substitution first
- restart stale services
- rebuild the extension after TS changes
- use the live system, not only mocks, for final acceptance
- run the browser proof outside the sandbox when needed
- use end-to-end tests for cross-layer features
- use run events as the source of truth for browser success
- only trust a live proof when the browser completed and the send step succeeded
