# Project notes

Things future Claude sessions on this repo should know up front — discovered the
hard way and not obvious from reading code.

## Read first

- **`docs/recruitment-automation-flow.md`** — full runbook for the Odoo job
  publication → LinkedIn search → applicant ingestion → AI scoring loop. Has
  the end-to-end architecture diagram, all prerequisites, first-time setup,
  per-step verification, troubleshooting (9 common failure modes), and config
  reference. Treat as the source of truth; this `CLAUDE.md` only adds
  shorthand reminders.
- **`docs/next-iteration-plan.md`** — implementation plan for the next four
  improvements (Odoo sync-stats view, daemon health in dashboard, kill the
  AI-extraction duplication with Easy Recruit, generic schema-driven
  extractor). Has ordered tasks with acceptance criteria.
- **`docs/windows-bot-host-runbook.md`** — how to access and operate the
  PRODUCTION bot host (Fernanda's **Windows** machine): SSH over Tailscale as
  `linkedin-bot@100.107.206.110` (elevated, key-based), where everything lives on
  the host, the `linkedin-bot-daemon` scheduled task, common ops, and gotchas.
  The daemon runs on Windows; the backend runs on Andrey's Mac
  (`BACKEND=http://100.100.20.99:8081` over Tailscale). NOTE: the older
  `docs/linkedin-bot-host-setup.md` is written for a **Mac** host — for Fernanda's
  real host, the Windows runbook supersedes it. Setup scripts:
  `scripts/setup-windows-host.ps1` + `scripts/elevate-bot-windows.ps1`.

## LinkedIn LEAD-sourcing flow (qaodoo → Fernanda's host → `linkedin.lead`) — THE flow we run

This is the **currently-exercised** flow (live-verified 2026-06-04: qaodoo job
304 "Full Stack Developer" → run `d4887175` on Fernanda's host → 14 leads in
qaodoo). It is **DISTINCT from the applicant push flow documented below** — when
someone says "run the flow", default to this one unless they ask for AI scoring.

- **What it does**: search-results-only — name + headline + profile_url, **NO
  profile visits, NO Easy Recruit / AI scoring**. Creates `linkedin.lead` rows in
  Odoo linked to the job (`job_id`) and the search run (`source_run_id`). Much
  lighter anti-bot footprint than the applicant flow.
- **Workflow**: "LinkedIn Lead Search" (`a2ae6cdb…`), `event_kind =
  linkedin_lead_search`, hardcoded mode. Push target `POST /akcr/api/linkedin_lead`
  (sibling of the applicant controller, same `akcr.linkedin_ingest_api_key`).
  Push service: `backend/services/linkedin_lead_push_service.py`.

### Run it end-to-end on qaodoo
1. **qaodoo needs the akcr lead ingestion deployed** (model `linkedin.lead` +
   `POST /akcr/api/linkedin_lead`). **qaodoo deploys from the akodoo `qaodoo`
   branch** (not master); the lead code shipped via PR #1807. Verify live:
   `curl -s -o /dev/null -w '%{http_code}' -X POST
   https://qaodoo.akurey.com/akcr/api/linkedin_lead -H 'X-API-Key: <key>'
   -H 'Content-Type: application/json' -d '{"job_id":"0","leads":[]}'` → **200**
   (404 = not deployed; an older akcr only has `linkedin_sync` on `hr.job`).
2. **Ingest key matches on both sides**: Odoo `ir.config_parameter
   akcr.linkedin_ingest_api_key` == connector `config.linkedin_ingest_api_key`
   (dev default `akcr-linkedin-dev-key-change-me`). If the connector lacks the
   key, the push **silently no-ops** (the run still completes).
3. **Connector + trigger**: connector `qaodoo-forum-live` (`2c7a49e9…`) must have
   an ENABLED `linkedin_lead_search` trigger → workflow `a2ae6cdb`.
   `fire_from_odoo_payload` fires **ALL** enabled triggers on a connector — keep
   only the intended one enabled (we disabled a dangling `new_job_position`
   trigger pointing at a deleted workflow). The trigger-create API only allows
   `new_job_position`; create the lead trigger via `WebhookTriggerService.create_trigger`.
4. **Fire it**: publish a job in qaodoo with **"Sync with LinkedIn" ✓ AND
   Published**. qaodoo can't reach the Mac backend over Tailscale, so there is
   **NO inbound webhook** — the **reconcile supervisor** is the trigger: it polls
   qaodoo every `RECONCILE_POLL_INTERVAL_SECONDS` (300) for
   `linkedin_sync=True AND is_published=True` jobs with id >
   `connector.config.reconcile_min_job_id`, and enqueues a QUEUED run. Skip the
   wait with `ReconcileSupervisor(session).reconcile_connector(<id>)` or by
   replaying the trigger.
5. **The daemon on Fernanda's host claims the QUEUED run** and drives it.

### Host realities (learned the hard way 2026-06-04; see memory `project_fernanda_host_ops`)
- **Only ONE daemon may poll the backend** or they race for the QUEUED run (see
  `/v1/daemon/status`). To force the run onto Fernanda's host, stop the Mac daemon
  (`make daemon-uninstall`; restore with `make daemon-install`).
- **The host's `.linkedin-profile` needs a LIVE logged-in session.** You CANNOT
  copy a Mac Chrome profile to Windows — cookies are OS-encrypted (macOS Keychain
  vs Windows DPAPI), so copied cookies are unreadable → checkpoint. Establish the
  session by an **interactive login AT the host**: `extension/login-linkedin.mjs`
  (launches visible Chrome against `.linkedin-profile`, waits for `/feed`); a
  launcher bat sits on the host's Public desktop. **The host is Windows 11 Home →
  it canNOT be an RDP server** (no inbound RDP); log in at the physical screen or
  via a remote-GUI tool (Chrome Remote Desktop / AnyDesk).
- **Checkpoint handling**: on a login/captcha/checkpoint wall the daemon PAUSES
  the run (`waiting_for_user`, pause_reason "Blocking: checkpoint") and trips a 4h
  circuit breaker. Clear it by deleting `.linkedin-budget.json` in the host's
  extension dir.
- **Verify a session non-invasively**: pull
  `.linkedin-profile/Default/Network/Cookies` and check `li_at` exists with a
  future `expires_utc` (values are DPAPI-encrypted but name/expiry are plaintext).
- **Tailscale must run unattended** or the host drops offline on logout/sleep:
  policy `HKLM\SOFTWARE\Policies\Tailscale\UnattendedMode=always` + a user must
  log in once so the GUI applies `ForceDaemon=true`. **Never restart the Tailscale
  service over the Tailscale-SSH link** (saws off your own branch → lockout).

## LinkedIn integration (Odoo new-job webhook → applicant push)

- **End-to-end flow**: Odoo publishes a new job → webhook hits
  `POST /v1/webhooks/incoming/odoo/{connector_id}` →
  `WebhookTriggerService._fire` creates an `ExecutionRun` with `origin`
  metadata (connector_id, event_kind, trigger_id, job_payload) →
  extension drives LinkedIn search + profile scrape → run `/complete` →
  `ExecutionService.transition` calls
  `LinkedInApplicantPushService.push_from_run` →
  `POST /akcr/api/linkedin_applicant` to Odoo → controller creates
  `hr.applicant` tagged "From LinkedIn" → controller calls
  `applicant._analyze_easy_recruit(force=True)` synchronously.
- **Two different `X-API-Key`s flow through this pipeline.** Don't mix them up:
  - Webhook ingress (`POST /v1/webhooks/incoming/odoo/{connector_id}`)
    is gated by the **backend gateway key** (`settings.api_key`, dev
    default `dev-api-key-change-in-production`) via the global FastAPI
    middleware. Not the connector's key.
  - The **reverse** push (`POST /akcr/api/linkedin_applicant` to Odoo)
    sends the connector's `linkedin_ingest_api_key`, which must match
    Odoo's `ir.config_parameter` `akcr.linkedin_ingest_api_key`.
- **Webhook payload is FLAT, not nested.** Fields go at the top level:
  `{ "event_kind": "new_job_position", "job_id": "76",
  "name": "...", "job_title": "...", "job_description": "...",
  "department": "...", "candidate_count": 2 }`. The persisted
  `execution_runs.origin.job_payload` IS nested, which is misleading —
  ingest reads top-level, storage wraps. Don't wrap on the way in.
- **Dedup is by `(job_id, profile_url)`** in the akcr controller. A second
  webhook for the same job+url returns `{status:"exists"}` and does NOT
  overwrite — so if a first scrape produced empty fields, re-runs won't
  fix it. Delete the applicant row in psql to force a clean re-create.
- **Push hook timeout**: Odoo's `_analyze_easy_recruit` runs 8 AI agents
  serially (30–120s per applicant). The httpx client in
  `linkedin_applicant_push_service.py` must use `timeout=240.0`.
- **Run-origin column** (`execution_runs.origin`, migration 021) is what
  the terminal-state hook uses to decide whether to push. Only runs with
  `origin.event_kind == "new_job_position"` trigger the push.
- **Never `await` slow external calls inside `ExecutionService.transition()`
  without committing first.** transition() does `SELECT … FOR UPDATE` on
  the run row. Any HTTP / AI / sleep awaited between that and the request
  commit blocks every other writer of that row — produces an endless
  `idle in transaction` chain because each daemon heartbeat / step-result
  / push update queues behind the lock and itself becomes a new blocker.
  The LinkedIn push hook commits explicitly before firing for this exact
  reason (commit e06a10e). Any new terminal-state hook must either commit
  the outer session first, or run on a separate session via
  `async_session_factory()`.

## Anti-bot (read `docs/anti-bot-measures.md` — source of truth)

- **The daemon (`extension/driver-daemon.mjs`) is the PRODUCTION scraper, NOT
  the extension.** They're separate runtimes; keep their behavior in sync via
  the shared modules in `extension/src/{shared/stealth.mjs,behavior/*}`. An
  account got flagged (2026-05-28) because V2 anti-bot work landed only in the
  extension and never reached the daemon.
- **Never hardcode GPU / CPU cores / deviceMemory / locale in stealth.** This is
  a real M1 Mac running real Chrome — the native fingerprint is already a
  consistent human. The old code faked WebGL to "Intel Iris" on Apple Silicon, a
  self-contradiction that flagged us. `STEALTH_INIT` now patches only
  `navigator.webdriver` + `permissions.query`.
- **Blocker → pause, never plow.** Every navigation goes through `safeGoto`,
  which detects login/captcha/checkpoint walls and PAUSES the run (cursor not
  advanced) + trips a persisted circuit breaker. Don't add raw `page.goto` that
  bypasses it.
- **Click "Show all", don't deep-link `/details/<section>/`.** Full extraction
  is preserved (every section, shuffled order, single visit) — only the
  navigation is humanized (bezier mouse, trusted click via `page.mouse`).
- **Account state** (budget + circuit) is in gitignored
  `extension/.linkedin-budget.json`; delete it to clear a tripped circuit. Env
  knobs: `MAX_PROFILE_VIEWS_*`, `WORK_*`, `*_COOLDOWN_MS`, `RESPECT_WORKING_HOURS`.

## LinkedIn scraping (2025 DOM, anti-bot)

- **Chrome 148 removed `--load-extension`** entirely. Playwright tests
  using `channel: "chrome"` can't load the unpacked extension on macOS —
  service worker never spawns. Use `channel: "chromium"` (chrome-for-
  testing, same 148.x) which still honors the flag. Or, when not using
  the extension, real Chrome works fine.
- **Anti-bot bypass**: stage the user's real Chrome profile via
  `extension/prepare-stealth-profile.mjs` (snapshots Profile 4 → 283 MB,
  cookies + history + IndexedDB + Local Storage; now refuses to run while
  Chrome is open — quit Chrome first). Launch with the shared `STEALTH_INIT`
  from `extension/src/shared/stealth.mjs` (minimal: webdriver +
  permissions.query only — see the Anti-bot section above and
  `docs/anti-bot-measures.md`; the old "fake WebGL/plugins/cores" bundle was
  removed because it contradicted the real M1 fingerprint). First launch may
  hit a `/checkpoint/challenge/...` page — user solves it once, the profile is
  then whitelisted.
- **LinkedIn moved profile data structurally in 2025**. The profile name
  is now in `<h2>` inside `[data-view-name="profile-top-card"]`, not
  `<h1>`. Section anchor IDs (`#about`, `#experience`) are gone — use
  `[data-view-name="profile-card-{about,experience,…}"]`.
- **Experience / Skills / Education are no longer in the main profile
  page**. Visit `/in/<slug>/details/experience/`,
  `/details/skills/`, `/details/education/`, `/details/certifications/`
  individually. Each renders entries as `<li>` inside the largest `<ul>`
  by total text — beware of the tab-nav `<ul>` on the skills page which
  rivals the real list by li count (filter by total text or skip
  `role=tablist` / inside `<nav>`).
- **LinkedIn UI is locale-dependent**. Spanish profiles show "Acerca de"
  not "About", "Experiencia" not "Experience". Section detection by
  heading text needs i18n alternatives.

## Easy Recruit (Odoo-side AI scoring)

- **Lives entirely inside Odoo** in `akodoo/akcr/models/concierge/` —
  there is NO `easy-recruit-workflow` Docker dependency. The Docker
  containers seen running on the box are vestigial. The analyzer uses
  the `openai-agents` pip package directly against OpenAI.
- **Requires `openai-agents` + `unidecode`** installed in Odoo's Python
  env (pyenv 3.10.13 on this machine). Without them, lazy-import in
  `analyze_and_complete` raises and analysis fails.
- **API key lives in `ir_config_parameter` key `openai_api_key`**, not
  the shell env. The shell `OPENAI_API_KEY`/`OPENAI_BASE_URL` will
  override Odoo's settings if inherited.
- **NVIDIA env vars poison Odoo's OpenAI calls.** If the shell has
  `OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1` (set for other
  projects), `openai-agents` routes calls to nvidia.com which returns
  404 on `/v1/responses`. **Always start Odoo with `env -u
  OPENAI_BASE_URL -u OPENAI_API_KEY -u NVIDIA_API_KEY ./odoo-bin ...`**.
- **`_compose_dossier` writes everything (headline, about, skills,
  experience, education, certifications) into `about_you`** — that's
  the corpus the AI agents read. For LinkedIn applicants without a CV,
  the dossier *is* the curriculum.
- **`_populate_from_easy_recruit` has a score-scale mismatch**: AI
  returns `overall_score` 0–10 in `results.job_fit_score`, but
  `hr_applicant.job_fit_score` is a 0–100 integer column. The integer
  often ends up at 0 even when AI scored high. The full dimensional
  breakdown lives in `concierge_easy_recruit_profile.results` (JSON) +
  `results_document` (rendered text) — both visible on the profile
  form. Don't trust `hr_applicant.job_fit_score` alone.

## Local environment (morsoft DB / native Odoo)

- **Odoo runs native** (not in Docker) on `localhost:8070`, db `morsoft`.
  Start with:
  ```
  pkill -f 'odoo-bin.*morsoft'; sleep 2
  cd /Users/andreysanchez/Documents/odoo
  env -u OPENAI_BASE_URL -u OPENAI_API_KEY -u NVIDIA_API_KEY \
    nohup ./odoo-bin --config=/Users/andreysanchez/Documents/akodoo/Utilities/odoo.conf \
      -d morsoft --db_host=localhost --db_user=odoo --db_password=odoopwd \
      --db-filter='^morsoft$' > /tmp/odoo-run.log 2>&1 & disown
  ```
- **morsoft admin user**: `support@akurey.com` / `admin` (pbkdf2-sha512
  hash of "admin" was applied via psql once; see memory).
- **easy-recruit-workflow Docker stack** is broken and unused — ignore
  the "Restarting" containers in `docker ps`.

## Dev keys and config

- **Backend gateway API key** (`X-API-Key` for `:8081`): the dev default
  `dev-api-key-change-in-production` (from `backend/core/config.py`).
- **Frontend reads `VITE_API_KEY`** from `frontend/.env` — that file is
  gitignored; create it if the dashboard shows
  "Invalid or missing API key".
- **Extension API key lives in `chrome.storage.session`**, with a fallback
  to `DEV_DEFAULTS.apiKey` in `extension/src/background/api.ts` (must
  match the backend gateway key — historical bug: it was a random unrelated
  string and every recording POST silently 401'd). When recordings don't
  appear in the workflow list, suspect this before AI quota: reload the
  extension at `chrome://extensions/`, then either re-enter the key in
  the extension's settings panel or run `chrome.storage.session.clear()`
  in the service-worker DevTools console. `chrome.storage.session` is
  volatile across browser restarts but persists across reloads; an old
  bad value silently overrides any default you ship.
- **Backend `AI_API_KEY`** is read from `backend/.env` (also gitignored).
  Set it for any session-replay-side AI feature; Odoo's AI key is
  separately in `ir.config_parameter`.

## Persistent services (launchd + screen)

`make all-services-install` brings a fresh clone to a fully-running
state with one command:
  - daemon (`extension/driver-daemon.mjs`) → launchd LaunchAgent;
    survives reboot, auto-restarts on crash (KeepAlive +
    ThrottleInterval=15, ProcessType=Interactive)
  - backend (`uvicorn` on :8081) → `screen -dmS sr-backend …`
  - frontend (`vite` on :5173) → `screen -dmS sr-frontend …`

The plist templates live in `scripts/launchd/*.plist.template` with
`__HOME__`, `__REPO__`, `__NODE__`, `__UVICORN__`, `__VITE__`
placeholders. `scripts/launchd-install.sh <service>` renders the
template against this machine's paths and writes the rendered file
to `~/Library/LaunchAgents/<label>.plist`. **Rendered plists are
NEVER committed** (machine-specific paths). Only the templates are
in git.

Make targets (memorize these — most common ops):

```
make all-services-install     # daemon launchd + backend/frontend screen
make all-services-uninstall   # stop all 3
make all-services-restart     # bounce all 3

make services-status          # PID/exit + screen sessions + port codes
make services-logs            # tail -F all launchd logs

# Per-service
make daemon-install     | daemon-uninstall   | daemon-status | daemon-logs | daemon-restart
make backend-install    | backend-uninstall    # launchd (needs FDA)
make frontend-install   | frontend-uninstall   # launchd (needs FDA)
make dev-backend        | dev-frontend         # screen-based (no FDA)
```

When editing the daemon code:
```
make daemon-restart && make daemon-logs
```

When editing backend code (auto-reload is off in screen mode):
```
make all-services-uninstall && make all-services-install
```

### macOS TCC gotcha (why mixed mode)

macOS 14+ blocks launchd-spawned processes from reading
`~/Documents/`, `~/Desktop/`, `~/Downloads/` unless the spawning
binary has **Full Disk Access** in System Settings → Privacy &
Security. If the repo is under `~/Documents/`, `uvicorn` and `vite`
EPERM-crash when launchd execs them. The daemon's
`/opt/homebrew/bin/node` is usually already FDA-granted, so it works.

To put backend + frontend ALSO under launchd, the user has to either
grant FDA to their python interpreter + `node_modules/.bin/vite`,
OR move the repo out of `~/Documents/`. Then run
`make all-services-launchd-install`. Default keeps them in screen to
avoid the friction.

For the daemon to do useful work the backend must be up AND
`extension/.linkedin-profile/` must be a staged Chrome profile with
a logged-in LinkedIn session — see test scripts section below.

## Test scripts (extension/)

- `prepare-stealth-profile.mjs` — snapshot real Chrome Profile 4 →
  `.linkedin-profile/`. Run once; reuse across runs.
- `login-linkedin.mjs` — phase 1 interactive login. User solves any
  LinkedIn challenge in the opened Chrome window.
- `live-linkedin-driver.mjs` — phase 2 driver: fires webhook, scrapes
  N profiles (5 page loads each — main + 4 detail subpages), POSTs
  extractions, completes the run. Env: `JOB_ID`, `JOB_TITLE`,
  `PROFILE_LIMIT`, `CONNECTOR_ID`.
- `profile-probe.mjs` / `topcard-probe.mjs` — diagnostic dumpers when
  LinkedIn's DOM drifts again (it will).
- `scripts/test_push_e2e.py` — synthetic E2E without a browser; useful
  for testing backend changes without driving LinkedIn.
