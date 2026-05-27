# Recruitment Automation Flow

> **Audience**: anyone testing, debugging, or onboarding to the Odoo job-publication
> → LinkedIn search → applicant ingestion → AI scoring loop. Treat this as the
> living runbook for that feature.
>
> **Last verified end-to-end**: 2026-05-27, commit `8c3ac3f`.

---

## 1. What it does

When a recruiter publishes a job in Odoo, the platform automatically:

1. Reads the job title.
2. Logs into LinkedIn (using a real Chrome session) and searches for that title.
3. Pulls the top N candidate profiles, extracting full bios — about, headline,
   experience, education, skills, certifications, projects, courses.
4. Creates one `hr.applicant` per candidate in Odoo, tagged **"From LinkedIn"**.
5. Runs Easy Recruit's 8 AI agents on each applicant and stores a structured
   job-fit score + dimensional breakdown + extracted skills.
6. Reports back via the dashboard at `localhost:5173/runs/<id>` and the Odoo
   recruitment view.

Configurable per-fire: how many candidates to sync (`candidate_count`, default 2).

---

## 2. Architecture (end-to-end)

```
   ┌────────────────────────── ODOO (port 8070) ──────────────────────────┐
   │  hr.job.write({linkedin_sync: True})                                 │
   │      └─→ akcr/models/hr_job.py write() override detects              │
   │          (False → True) transition                                    │
   │      └─→ _notify_session_replay_new_job()                             │
   │            POST /v1/webhooks/incoming/odoo/<connector_id>             │
   │            { job_id, job_title, candidate_count, … }                  │
   └──────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼
   ┌─────────────────── SESSION-REPLAY BACKEND (port 8081) ───────────────┐
   │  WebhookTriggerService.fire_from_odoo_payload                        │
   │      └─→ Looks up WebhookTrigger rows where                          │
   │          connector_id matches AND event_kind = "new_job_position"    │
   │      └─→ Renders WorkflowConnectorBinding templates                  │
   │           (keyword → {job_title}, count → {candidate_count})         │
   │      └─→ Creates ExecutionRun with origin = {connector_id,           │
   │           event_kind, job_payload}; transitions to RUNNING           │
   └──────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼
   ┌────────────────── DRIVER DAEMON (launchd LaunchAgent) ───────────────┐
   │  extension/driver-daemon.mjs polls /v1/runs every 5s                 │
   │      └─→ Picks up runs whose origin.event_kind == new_job_position   │
   │           AND extracted_data is empty AND not stale (>30min)         │
   │      └─→ Launches real Chrome 148 with extension/.linkedin-profile   │
   │           (cookies, history, IndexedDB cloned from your Chrome's     │
   │            Profile 4 — see "Stealth profile setup" below)            │
   │      └─→ Steps 0-5: navigate /feed, search, paginate, scrape URLs    │
   │      └─→ Step 6: POST /v1/runs/<id>/expand-for-each → backend        │
   │           materializes N (navigate+extract) inner steps              │
   │      └─→ Per profile: visit /in/<slug>, then /details/{experience,   │
   │           education, skills, certifications, projects, courses}.     │
   │           experience parsed structurally; other sections sent to     │
   │           gpt-4o-mini with JSON-Schema strict mode for extraction.   │
   │      └─→ POSTs extraction payload per profile                        │
   │      └─→ POSTs /complete → run transitions to COMPLETED              │
   └──────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼
   ┌─────────────────────── PUSH HOOK (backend) ──────────────────────────┐
   │  ExecutionService.transition (terminal-state)                        │
   │      └─→ If origin.event_kind == "new_job_position":                 │
   │           LinkedInApplicantPushService.push_from_run                 │
   │      └─→ Groups event_log extraction rows by canonical /in/<slug>    │
   │      └─→ POSTs first `candidate_count` to                            │
   │           {connector.url}/akcr/api/linkedin_applicant                │
   │           with X-API-Key from connector.linkedin_ingest_api_key      │
   └──────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼
   ┌────────────────────────── ODOO CONTROLLER ───────────────────────────┐
   │  akcr/controllers/linkedin_applicant_controller.py                   │
   │      └─→ Validates X-API-Key                                          │
   │      └─→ Dedup A: same (job_id, profile_url) → {status:"exists"}     │
   │      └─→ Dedup B: same profile_url on different job → reuses dossier │
   │      └─→ Composes dossier into about_you (headline + about + skills  │
   │           + experience + education + certifications + LinkedIn URL)  │
   │      └─→ Creates hr.applicant tagged "From LinkedIn"                  │
   │      └─→ Calls _analyze_easy_recruit(force=True) — synchronous       │
   │           runs 8 AI agents (~30–120s per applicant); writes back     │
   │           job_fit_score, level, skill links, English level, summary  │
   └──────────────────────────────────────────────────────────────────────┘
```

---

## 3. Prerequisites

| Component | Requirement | Verify |
|---|---|---|
| macOS | 14+ (for the launchd flow) | `sw_vers` |
| Node.js | ≥ 18 | `node --version` |
| Postgres | Local instance, role `workflow`/`workflow` for backend, `odoo`/`odoopwd` for Odoo | `psql -h localhost -U workflow -d workflow -c "\dt"` |
| Real Chrome | **148.x** (older might still work; not tested) | `/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --version` |
| Chrome **Profile 4** | Logged-in LinkedIn account | open Chrome → switch to Profile 4 → linkedin.com/feed/ |
| Odoo (akcr module) | Running at `localhost:8070`, db `morsoft`, with `akcr` module installed | `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8070/web/login` → `200` |
| OpenAI API key | `sk-proj-…` (NOT NVIDIA `nvapi-…`) in `backend/.env` as `AI_API_KEY` AND in Odoo `ir.config_parameter` key `openai_api_key` | see §6.2 |
| session-replay services | backend (:8081), frontend (:5173), driver-daemon | `make services-status` |

Critical Odoo `ir.config_parameter` keys (must exist on morsoft DB):

| Key | Value | Source |
|---|---|---|
| `openai_api_key` | Your real OpenAI key (sk-proj-…) | manual |
| `akcr.linkedin_ingest_api_key` | Shared secret (X-API-Key) used by session-replay → Odoo controller | manual |
| `akcr.session_replay_base_url` | `http://localhost:8081` | manual |
| `akcr.session_replay_connector_id` | UUID of the local-odoo connector in session-replay's DB | manual |
| `akcr.session_replay_api_key` | session-replay's API key (default `dev-api-key-change-in-production`) | manual |
| `akcr.linkedin_candidate_count` | Default candidate_count if webhook doesn't override | manual, default `2` |
| `linkedin_job_seats` | Max number of jobs that can have `linkedin_sync=True` simultaneously. Default `4`. Bump if needed. | constraint in `hr_job._check_linkedin_seat_limit` |

Critical session-replay rows (in the `workflow` Postgres DB):

| Table | Row | Purpose |
|---|---|---|
| `connector_configs` | One row of type `odoo`, `config.url = http://localhost:8070`, `config.linkedin_ingest_api_key = <same as Odoo>` | Where the backend POSTs applicants |
| `workflows` | One row with `name = 'LinkedIn People Search'` | The workflow that runs |
| `webhook_triggers` | One row binding the connector to the workflow with `event_kind = 'new_job_position'`, `enabled = true` | What makes the webhook fire |
| `workflow_connector_bindings` | Two rows: `keyword → {job_title}` and `count → {candidate_count}` | Parameter substitution |

---

## 4. First-time setup (from a fresh clone)

```bash
git clone <repo> && cd session-replay
make setup                   # backend + extension + frontend deps
make all-services-install    # daemon under launchd; backend + frontend in screen
```

Then the one-time interactive steps:

```bash
# Snapshot your real Chrome Profile 4 (cookies, history, IndexedDB) → ~283 MB.
# Skips the giant Service Worker / WebStorage caches.
node extension/prepare-stealth-profile.mjs

# Open Chrome interactively so you can log into LinkedIn (or solve a
# checkpoint challenge). The script waits up to 25 min for the URL to
# land on /feed/, then exits.
node extension/login-linkedin.mjs
```

Seed the workflow + bindings (idempotent — re-running is safe):

```bash
cd backend && source .venv/bin/activate
python ../scripts/seed_linkedin_people_search.py        # creates the workflow
python ../scripts/seed_linkedin_people_search_bindings.py <connector_id>
```

Configure Odoo (one-time, via psql):

```bash
psql -h localhost -U odoo -d morsoft <<'SQL'
INSERT INTO ir_config_parameter (key, value, create_date, write_date) VALUES
  ('akcr.session_replay_base_url',     'http://localhost:8081',                          NOW(), NOW()),
  ('akcr.session_replay_connector_id', '<your-connector-uuid>',                          NOW(), NOW()),
  ('akcr.session_replay_api_key',      'dev-api-key-change-in-production',               NOW(), NOW()),
  ('akcr.linkedin_candidate_count',    '2',                                              NOW(), NOW()),
  ('akcr.linkedin_ingest_api_key',     '<your-shared-secret>',                           NOW(), NOW())
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, write_date=NOW();
SQL
```

Restart Odoo with the NVIDIA env vars stripped (see §6.2):

```bash
pkill -f 'odoo-bin.*morsoft' ; sleep 3
cd ~/Documents/odoo && env -u OPENAI_BASE_URL -u OPENAI_API_KEY -u NVIDIA_API_KEY \
    nohup ./odoo-bin --config=~/Documents/akodoo/Utilities/odoo.conf \
        -d morsoft --db_host=localhost --db_user=odoo --db_password=odoopwd \
        --db-filter='^morsoft$' > /tmp/odoo-run.log 2>&1 & disown
```

You're ready.

---

## 5. Running the test

### 5.1 Pick a fresh draft job

```bash
psql -h localhost -U odoo -d morsoft -c "
  SELECT j.id, j.name->>'en_US' AS name, COUNT(a.id) AS prior_apps
    FROM hr_job j
    LEFT JOIN hr_applicant a ON a.job_id=j.id AND a.linkedin LIKE 'https://%linkedin%'
   WHERE j.is_published=false AND j.id BETWEEN 4 AND 30
   GROUP BY j.id, j.name ORDER BY prior_apps, j.id LIMIT 8;
"
```

Pick one with `prior_apps = 0` so dedup doesn't kick in. Common search-friendly
titles to test against: Project Manager (16), Associate QA Engineer (14),
Software Engineer (4), Quality Assurance Manager (17).

### 5.2 Set candidate_count (optional)

```bash
psql -h localhost -U odoo -d morsoft -c \
  "UPDATE ir_config_parameter SET value='3' WHERE key='akcr.linkedin_candidate_count';"
```

(Range: 1–25. Webhook payload can override per-fire — see §7.)

### 5.3 Publish the job

Either via Odoo's recruitment UI (toggle "Sync with LinkedIn" → "Save"), or
via XML-RPC for scripting:

```bash
python3 - <<'PY'
import xmlrpc.client
URL, DB, USER, PWD = "http://localhost:8070", "morsoft", "support@akurey.com", "admin"
JOB_ID = 16  # change me
uid = xmlrpc.client.ServerProxy(f"{URL}/xmlrpc/2/common").authenticate(DB, USER, PWD, {})
models = xmlrpc.client.ServerProxy(f"{URL}/xmlrpc/2/object")
models.execute_kw(DB, uid, PWD, "hr.job", "write", [[JOB_ID], {"linkedin_sync": True}])
print(f"job {JOB_ID} → published + linkedin_sync=True")
PY
```

### 5.4 Watch it run

```bash
# Confirm webhook fired in Odoo
grep "session-replay webhook" /tmp/odoo-run.log | tail -1

# Watch the daemon drive
tail -f ~/Library/Logs/session-replay/daemon.log

# Open dashboard
open http://localhost:5173/runs
```

Typical wall-clock per run:

| candidate_count | Scrape | Push + Easy Recruit | Total |
|---|---|---|---|
| 1 | ~3 min | ~1 min | ~4 min |
| 3 | ~5–7 min | ~2–4 min | ~7–11 min |
| 5 | ~10–12 min | ~3–6 min | ~13–18 min |

### 5.5 Final report

```bash
node extension/report.mjs <job_id>
```

Prints per-applicant: Easy Recruit status + AI fit score (0-10 with dimensional
breakdown), specialization, English level, linked + AI-inferred skills, Odoo URL.

---

## 6. Verification at each step

If something didn't land where you expected, walk the chain:

### 6.1 Webhook fired from Odoo

```bash
grep "session-replay webhook" /tmp/odoo-run.log | tail -3
```

Healthy: `webhook OK job_id=N status=200 body={"triggered_runs":["<uuid>"]…}`.
Failure: `webhook FAILED` — usually network (backend not running) or
`akcr.session_replay_connector_id` not set.

### 6.2 Run created with origin

```bash
psql -h localhost -U workflow -d workflow -c \
  "SELECT id, status, origin->>'event_kind' AS evt
     FROM execution_runs WHERE id='<run-uuid>';"
```

Must show `status = running`, `evt = new_job_position`. If `origin IS NULL`,
the WebhookTriggerService `_fire` didn't stamp it — usually because the
backend version is stale; restart.

### 6.3 Daemon picked the run up

```bash
tail -50 ~/Library/Logs/session-replay/daemon.log
```

Look for `[daemon] driving run <uuid>`. If absent after 15s of webhook firing,
the daemon's `findPendingRun` skipped it. Most common causes:
- Run is older than `STALE_RUN_AGE_MS` (30 min) — re-publish a fresh job.
- Run already has `current_step_index > 0` (something else is driving it).
- Daemon isn't running (`make daemon-status`).

### 6.4 Scrape progress

Daemon logs print one line per step:

```
step 3: 19 URLs on page 1
step 5: 19 URLs on page 2
step 6: for_each expanded into 3 iterations
step 8: "Sofia Llona" headline="QA Manager at Encora" edu=2 skills=10 certs=1
```

If a step errors out (e.g. `ERR_INTERNET_DISCONNECTED`), the resilience patch
will log the error and continue — the affected iteration loses its profile
data but the run doesn't abort.

### 6.5 Push to Odoo fired

```bash
psql -h localhost -U odoo -d morsoft -c \
  "SELECT id, partner_name, easy_recruit_status, LENGTH(about_you) AS abt
     FROM hr_applicant WHERE job_id=<job_id> ORDER BY id DESC LIMIT 5;"
```

Should show one row per candidate (up to `candidate_count`). If 0 rows:
- check backend logs for `LinkedInApplicantPushService` errors
- confirm `connector_configs.config.linkedin_ingest_api_key` matches Odoo's
  `ir.config_parameter.akcr.linkedin_ingest_api_key`

### 6.6 Easy Recruit scored

In the `psql` query above, `easy_recruit_status` should be one of:
- `completed` — passed the threshold (default 80), full success
- `threshold_not_met` — AI ran, score below threshold (still useful — see
  results breakdown in the report)
- `failed` — AI errored out (see §7.4)

---

## 7. Troubleshooting

### 7.1 "Cannot sync more than 4 jobs with LinkedIn"

```
ValidationError: Cannot sync more than 4 jobs with LinkedIn (current limit).
```

Bump the seat limit or disable an existing synced job:

```bash
psql -h localhost -U odoo -d morsoft -c \
  "INSERT INTO ir_config_parameter (key, value, create_date, write_date)
   VALUES ('linkedin_job_seats', '99', NOW(), NOW())
   ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;"
# Then RESTART Odoo — the constraint reads cached config at boot.
```

Or disable a previously-synced job:

```bash
psql -h localhost -U odoo -d morsoft -c \
  "UPDATE hr_job SET linkedin_sync=false WHERE id=<some-old-id>;"
```

### 7.2 Easy Recruit fails with "404 page not found"

```
Easy Recruit analysis failed: 404 page not found
```

You started Odoo with `OPENAI_BASE_URL` pointing at NVIDIA in your shell env.
`openai-agents` inherits it and routes calls to nvidia.com which doesn't have
the Responses API. Restart Odoo with those vars stripped:

```bash
pkill -f 'odoo-bin.*morsoft' ; sleep 3
cd ~/Documents/odoo && env -u OPENAI_BASE_URL -u OPENAI_API_KEY -u NVIDIA_API_KEY \
    nohup ./odoo-bin --config=~/Documents/akodoo/Utilities/odoo.conf \
        -d morsoft --db_host=localhost --db_user=odoo --db_password=odoopwd \
        --db-filter='^morsoft$' > /tmp/odoo-run.log 2>&1 & disown
```

### 7.3 LinkedIn challenge page blocks the daemon

```
[daemon] driveRun <uuid> failed: ... checkpoint/challenge ...
```

LinkedIn served a security challenge. The Chrome window the daemon opened is
still visible — solve the challenge in it (email code, CAPTCHA, etc.). The
daemon's wait loop gives you up to 15 min, then continues. After clearing once,
the session is whitelisted for subsequent runs.

### 7.4 Run stuck at `waiting_for_user`

A transient `ERR_INTERNET_DISCONNECTED` or similar paused the run mid-flight.
The daemon's resilience patch normally catches this and continues, but if the
error happens during `page.goto` itself (rare), the run can pause.

Cancel + republish:

```bash
curl -s -X POST -H "X-API-Key: dev-api-key-change-in-production" \
  -H "Content-Type: application/json" -d '{}' \
  http://localhost:8081/v1/runs/<uuid>/cancel
# Then toggle the job: linkedin_sync=False then linkedin_sync=True
# (write() override fires on transition, not on every save)
```

### 7.5 Dedup hides changes

If you re-publish the same job and the same candidates come up, the akcr
controller returns `{status:"exists"}` and doesn't update the applicant.
Earlier-empty fields stay empty.

Two ways to force fresh creates:
1. Use a **different `job_id`** for the next test.
2. Delete the existing rows:
   ```bash
   psql -h localhost -U odoo -d morsoft -c \
     "DELETE FROM hr_applicant WHERE job_id=<id> AND linkedin LIKE 'https://%linkedin%';"
   ```

### 7.6 Only N-1 candidates land when count=N

The push service caps at `candidate_count` from `origin.job_payload`. If
fewer applicants land than expected, the daemon scraped fewer profiles than
requested — usually because LinkedIn's search returned fewer URLs than
`count`, or one of the inner navigations failed (see daemon log).

### 7.7 `job_fit_score = 0/100` but `AI fit = 9/10` in the report

Expected. `hr_applicant.job_fit_score` is a 0–100 column populated by
`_populate_from_easy_recruit`. AI returns `results.job_fit_score.overall_score`
on a 0–10 scale. Mapping is broken upstream — the real score is in the report
under "AI fit" / the dimensional breakdown.

### 7.8 Dashboard says "Invalid or missing API key"

`frontend/.env` is missing. Create it:

```bash
cat > frontend/.env <<'EOF'
VITE_API_KEY=dev-api-key-change-in-production
VITE_API_BASE_URL=http://localhost:8081/v1
EOF
```

Then restart the frontend (`make all-services-restart` or kill the screen
session and `make dev-frontend`).

### 7.9 Chrome 148 dropped `--load-extension`

If you try to load the unpacked extension via Playwright with `channel:"chrome"`,
the service worker times out. **The daemon doesn't use the extension** — it
drives a plain Chrome instance directly with the staged `.linkedin-profile/`.
For Playwright-based testing that DOES need the extension, use
`channel:"chromium"` (chrome-for-testing).

---

## 8. Configuration reference

### 8.1 candidate_count

Set globally:
```bash
psql -h localhost -U odoo -d morsoft -c \
  "UPDATE ir_config_parameter SET value='5' WHERE key='akcr.linkedin_candidate_count';"
```

Override per-fire (when triggering via curl instead of toggling a job):
```bash
curl -s -X POST -H "X-API-Key: dev-api-key-change-in-production" \
  -H "Content-Type: application/json" \
  -d '{"job_id": 16, "name": "Project Manager", "candidate_count": 7}' \
  http://localhost:8081/v1/webhooks/incoming/odoo/<connector_id>
```

The path resolution is: webhook payload `candidate_count` → falls back to
`akcr.linkedin_candidate_count` ir.config_parameter → falls back to literal `2`.
Clamped to 1..25 at both ends (in `WebhookTriggerService.fire_from_odoo_payload`
and `LinkedInApplicantPushService.push_from_run`).

### 8.2 Easy Recruit threshold

```bash
psql -h localhost -U odoo -d morsoft -c \
  "UPDATE ir_config_parameter SET value='70' WHERE key='easy_recruit_review_threshold';"
```

Default 80. Candidates whose confidence score is below this end up as
`threshold_not_met` instead of `completed`. The dimensional scoring is
unaffected — it always runs.

### 8.3 Different Odoo, different LinkedIn account

To switch backing Odoo:
1. Update `connector_configs.config.url` to the new Odoo host.
2. Update `connector_configs.config.linkedin_ingest_api_key` to match the new
   Odoo's `ir.config_parameter.akcr.linkedin_ingest_api_key`.
3. Restart the backend.

To switch the LinkedIn account the daemon uses:
1. `make all-services-uninstall`
2. Delete `extension/.linkedin-profile/`
3. Re-run `node extension/prepare-stealth-profile.mjs` (will snapshot whatever
   Chrome profile you point it at — edit the script's `SRC_PROFILE` constant
   if you want a profile other than `Profile 4`).
4. `node extension/login-linkedin.mjs` (interactive log-in for the new account).
5. `make all-services-install`.

---

## 9. File / log / table reference

### Source code

| Path | Role |
|---|---|
| `akodoo/akcr/models/hr_job.py` | `write()`/`create()` overrides + `_notify_session_replay_new_job()` |
| `akodoo/akcr/controllers/linkedin_applicant_controller.py` | Receives POSTs from session-replay, creates applicants, triggers scoring |
| `akodoo/akcr/models/concierge/easy_recruit_profile.py` | Easy Recruit `analyze_and_complete` — 8 AI agents |
| `backend/services/webhook_trigger_service.py` | Receives Odoo webhooks, creates runs with origin |
| `backend/services/linkedin_applicant_push_service.py` | On COMPLETED, POSTs profiles to Odoo |
| `backend/services/execution_service.py` | `transition()` calls the push hook |
| `extension/driver-daemon.mjs` | The long-running poll + drive loop |
| `extension/live-linkedin-driver.mjs` | Same logic as a one-shot for ad-hoc testing |
| `extension/report.mjs` | Per-job final-report query |
| `scripts/seed_linkedin_people_search.py` | Creates / re-creates the workflow |
| `scripts/seed_linkedin_people_search_bindings.py` | Wires connector → workflow → bindings |

### Logs

| Path | What lives there |
|---|---|
| `~/Library/Logs/session-replay/daemon.log` | Daemon stdout (per-step progress) |
| `~/Library/Logs/session-replay/daemon.err.log` | Daemon stderr |
| `~/Library/Logs/session-replay/backend.log` | (only populated if backend is in launchd mode, not screen) |
| `/tmp/odoo-run.log` | Native Odoo stdout/stderr — has `session-replay webhook OK/FAILED` |
| `screen -r sr-backend` | Live backend logs in screen mode |
| `screen -r sr-frontend` | Live frontend logs in screen mode |

### DB tables

| DB | Table | What to look at |
|---|---|---|
| `workflow` | `execution_runs` | `origin` (JSONB), `extracted_data`, `status`, `current_step_index`/`total_steps` |
| `workflow` | `event_log` | One row per step event; `event_type='extraction'` rows carry the scraped data |
| `workflow` | `webhook_triggers` | The binding from connector → workflow + `enabled` flag |
| `workflow` | `workflow_connector_bindings` | `parameter_key` + `template` per workflow param |
| `workflow` | `connector_configs` | The Odoo connection details (url, linkedin_ingest_api_key) |
| `morsoft` | `hr_applicant` | `partner_name`, `linkedin`, `easy_recruit_status`, `job_fit_score`, `about_you` |
| `morsoft` | `concierge_easy_recruit_profile` | `results` (JSONB) — full AI breakdown |
| `morsoft` | `ak_applicant_skill` | Linked `hr_skill` rows extracted by Easy Recruit |
| `morsoft` | `ir_config_parameter` | All the akcr.* + openai_api_key keys |

### Useful one-liners

```bash
# All LinkedIn-sourced applicants across all jobs
psql -h localhost -U odoo -d morsoft -c \
  "SELECT id, partner_name, job_id, easy_recruit_status FROM hr_applicant
   WHERE linkedin LIKE 'https://%linkedin%' ORDER BY id DESC LIMIT 20;"

# Current `running` runs with their origins
psql -h localhost -U workflow -d workflow -c \
  "SELECT id, status, origin->>'event_kind' AS evt, origin->'job_payload'->>'job_title' AS title
     FROM execution_runs WHERE status='running' ORDER BY started_at DESC LIMIT 10;"

# Cancel a wedged run
curl -s -X POST -H "X-API-Key: dev-api-key-change-in-production" \
  -H "Content-Type: application/json" -d '{}' \
  http://localhost:8081/v1/runs/<run-uuid>/cancel

# Full report for one job
node extension/report.mjs <job_id>

# Live daemon log
make daemon-logs

# Are all services up?
make services-status
```

---

## 10. Known limitations

1. **The daemon spawns one Chrome at a time** — `.linkedin-profile/` is a
   singleton. Two concurrent webhook-triggered runs serialize.
2. **LinkedIn cookie expiry** — every ~30 days you'll need to re-run
   `node extension/login-linkedin.mjs`.
3. **No retries on push-to-Odoo failure** — if Odoo is down when the push
   fires, the run still goes COMPLETED but no applicants are created. The
   daemon doesn't re-try. Workaround: re-publish the job.
4. **`hr_applicant.job_fit_score`** ≠ AI overall score (see §7.7).
5. **Backend + frontend aren't in launchd by default** because of macOS TCC.
   See README "Why backend + frontend aren't in launchd" for the FDA workaround.
6. **Education / skills / certs from PRIVATE LinkedIn profiles** come back
   empty — those sections aren't visible to non-1st-connections. The AI
   extracts whatever's in the public textContent; if there's nothing, you get
   `[]`. This is correct behaviour, not a bug.
