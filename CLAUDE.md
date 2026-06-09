# Project notes

Things future Claude sessions on this repo should know up front — discovered the
hard way and not obvious from reading code.

## CURRENT GOAL — decompose the Recruiter recording into reusable sub-workflows

We now have access to **LinkedIn Recruiter** (the paid "Talent"/`/talent/hire/...`
surface) on Fernanda's host. The recruiter recorded ONE long exploratory session:
workflow **`0a8404f9-f745-4778-9429-3e06e125c146`** ("LinkedIn and Akurey Careers
Search", 317 steps, `target_url https://www.linkedin.com/talent/home`). It is just a
walkthrough — NOT a clean automation.

**Goal:** analyze that recording, identify the distinct high-level actions, and carve
them into **separate, SIMPLE, reproducible, parameterized workflows** (one action each),
so we can replay/compose them. Keep them minimal but actually working.

**Hard rule — this LinkedIn account is VERY sensitive.** Do NOT run live tests casually.
Every test must be deliberate and careful (mirrors the anti-bot discipline below). Build
and reason about the sub-workflows first; only run live when explicitly cleared, on
Fernanda's host where the Recruiter session lives.

**NOTE:** this is the **Recruiter/Talent** product (`/talent/`), a DIFFERENT surface from
the `linkedin.com` people-search + applicant/lead flows already documented further down.

### High-level actions identified in the recording (candidate sub-workflows)
1. **Pull job requirements from Akurey careers** (steps 4–12): Google "akurey careers" →
   `akurey.com/careers` → SEE REQUIREMENTS → `careers/requirements/?pId=<id>`. Non-LinkedIn
   input source for the job description/requirements.
2. **Recruiter advanced search** (steps 18–75): `/talent/search` → Advanced search → set
   filters (spoken language = English / Must have / Full Professional; total years of
   experience range; skill keywords) → Search → results list. *Parameterize the filters.*
3. **Save a candidate to an existing project** (76–85, 256–265, 298–310): open profile →
   "Save to project" → "Choose existing project" → pick project → "Save X to project".
4. **Create a new project** (278–294): "Create new project" → name + description → "Create
   project" (created "Easy Recruit", landed on `/talent/hire/<id>/overview`).
5. **Connect with a candidate** (102–112): open public profile → "Connect" (connection req).
6. **Message a single candidate** (125, 171–176): open profile → "Message X" → pick template.
7. **Bulk-message everyone in a project/pipeline** (179–201): Pipeline → "Select all N
   profiles" → "Message (N)" → edit subject → "Search template" → pick template → send.
8. **Open a project pipeline & sourcing views** (117–159): project → "Pipeline"
   (`/manage/all`), "Recommended matches" (automatedSourcing), "Apply starters".
9. **Find a specific person** (221–255): search the pipeline by name, or global LinkedIn
   search by name / paste a profile URL → "View in Recruiter" (bridge public profile →
   `/talent/profile/...`).

Highest-value first three to productize: **(2) search**, **(3) save-to-project**,
**(7) bulk-message a project** — these are the "search / add to project / message the
project" examples the user called out.

### Sub-workflow build status (updated 2026-06-05)
- **(2) Search → candidates — DONE & LIVE-VERIFIED.** Workflow `5bdc4d51-cbe8-46fb-986e-da67f9e4a3d1`
  "Recruiter Search → candidates" (generic, 3 steps): navigate `/talent/home` → navigate
  `/talent/search?searchHistoryId=21166179650&start=0` → extract (strategy
  `recruiter_search_people` → `scrapeRecruiterSearch` in `driver-daemon.mjs:645`). Live run
  `e2cbdb34` extracted **4 candidates** (name + `/talent/profile/` URL) in 31s against the
  warm seat. Results land in the run's **`extracted_data`** field (`GET /v1/runs/{id}` →
  `extracted_data[0].people`; there is NO `/extraction` endpoint — that 405s). Run it:
  `POST /v1/workflows/5bdc4d51…/run-with-params` with
  `{"execution_target":"daemon","operator_id":"fernanda","execution_options":{"use_profile":true,"snapshot":true}}`.
  **Known gap:** `headline` comes back `""` (the title sits deeper in the card than the
  innerText split reaches) — fix `scrapeRecruiterSearch` offline against a results snapshot,
  then redeploy. The saved-search URL (`searchHistoryId`) is hardcoded — this `5bdc4d51` flow is
  the "re-run a saved search" variant.
- **(2b) Parameterized search — DONE via the AI Copilot 2026-06-08** (`recruiter-workflows/keyword-search.json`,
  workflow `ecd976b1`, system). The recording's REAL search entry (steps 13–15) is the **AI Copilot**,
  NOT the advanced facets or the global box (both need a finicky commit/submit that wouldn't take —
  facets apply on blur, the global box didn't submit). Type **"Buscar candidatos para: <position>"**
  into **`textarea.copilot-chat-input__textbox`** + Enter (`\n`) → the AI builds & runs the search →
  results → `recruiter_search_people`. Live-verified: "Full Stack Developer" → 5 candidates, real
  `/talent/search?searchContextId=…` page. PARAM = the position in the request (the single value an
  Odoo trigger overrides). **Lesson: mine the recording's recorded selectors for the real entry
  before fighting the live UI** — the human used the Copilot, not the facets.
- **(3) Save-to-project — DONE & LIVE-VERIFIED (2026-06-08).** Spec
  `recruiter-workflows/save-to-project.json` (workflow `4da44557…`). Live run `00eac46b`
  saved Oscar Carmona Mora → "Easy Recruit"; his profile went to **"En 2 proyectos"** and the
  activity feed logged "ha añadido el perfil a Easy Recruit". Built as a pure generic
  click/type workflow (no daemon restart). Flow + locked selectors: navigate profile →
  `[data-test-action='save-to-project']` → `label[for='choose-existing-projects']` (switch to
  existing mode) → type project name into `#save-to-projects-typeahead` → **2 no-op `scroll`
  steps (delay for the async typeahead to load)** → click the option by exact `text` (project
  name) → `button[data-test-action='save']`. Params to vary: candidate URL (step 1) + project
  name (step 4 type + step 7 option text). DON'T target a real recruiting project (use the
  "Easy Recruit" sandbox) — they're María Fernanda's live projects.
- **Archive a candidate — flow PROMOTED 2026-06-08** (`recruiter-workflows/archive-candidate.json`,
  `77f6095c…`, system). Recruiter has **NO hard "remove from project"** — the way to take a
  candidate out of the active pipeline is **Archive** (moves them to "Archived candidates").
  Each pipeline row has `[data-test-component='archive-profiles-btn']` (also
  `data-test-profile-item-actions="archive"`); there's one per row, so target the specific
  person by name via accessibility/text **"Archive <Name>" / "Archivar a <Name>"** (a bare css
  would archive whoever's on top). Archives with the AI "doesn't seem fit" reason. Params:
  pipeline URL (step 1) + candidate name (step 4). Built from live-captured selectors but NOT
  run-verified (to avoid archiving an active candidate); verify via the Archived-candidates
  count, and a confirm click may be needed. The per-row "…" more-actions and "In N projects"
  controls did NOT expose a remove (and the row "…" only reveals on hover → soft-misses).
- **(6) Message a single candidate — composer CAPTURED 2026-06-08 (build-only).** Entry:
  `button[aria-label='Enviar mensaje a <Name>']` on the pipeline (or the profile message icon)
  → opens the InMail composer (same one bulk uses).
- **(7) Bulk-message — SEND LIVE-VERIFIED 2026-06-08** (`recruiter-workflows/bulk-message-send.json`).
  Sent 2 InMails (subject "Oportunidad en Akurey" + a short Spanish body) to the active Easy
  Recruit candidates (Andrey + Franz; Oscar excluded — archived) on explicit user go-ahead.
  Composer closed + "messages sent successfully" toast = success (a blocked send keeps it open).
  **KEY QUIRK — the bulk composer's subject input is HIDDEN until a Send attempt validates it.**
  So the working pattern is: type body → click **Send #1** (harmlessly blocked → "Subject can't
  be empty" REVEALS the now-visible subject field) → click+type the subject → **Send #2** (sends).
  Typing the subject before that reveal silently no-ops (field not visible → not resolvable) and
  the send is then blocked as "incomplete" (safe — nothing goes out, no credit). Recipients =
  whoever is ACTIVE (archived excluded); messaging a 1st-degree connection is free, 2nd-degree
  uses an InMail credit. The single-message composer (flow 6) shows the subject directly (no reveal needed).
- **(7-orig) Bulk-message DRAFT (no send)** = `recruiter-workflows/bulk-message-draft.json`. NEVER send without explicit OK (each send
  burns an InMail credit — composer shows "N/590 créditos de InMail"). Flow:
  `/talent/hire/<projectId>/manage/all` (pipeline) → select-all → "Mensaje (N)" → InMail
  composer → Enviar. **Composer selectors captured live 2026-06-08** (the gap the recording
  never recorded; it's the InMail composer, opens with an AI-drafted body, uses declarative
  shadow DOM, ghost-loads ~5-10s so insert delay steps before reading/clicking it):
  - subject: `input[placeholder='Añade un asunto']`
  - body (rich-text, AI-prefilled): `div[role='textbox']`
  - template search: `input[placeholder='Busca una plantilla…']`
  - **Send: `button[aria-label='Enviar este mensaje']`**  ← the long-missing SEND selector
  - save-as-template: text "Guardar como plantilla nueva"; preview: "Vista previa"
  **Pipeline select-all + bulk Message — captured 2026-06-08:** select-all = first
  `input.small-input` (header checkbox; a11y-text "Select all N profiles", count-dependent so
  use the css); after selecting, the bulk-action bar (`data-test-profile-list-bulk-actions`)
  shows **`button[data-test-action='send-message']`** ("Message (N)") → opens the bulk InMail
  composer addressed to all selected. **DRAFT COMPLETE & VERIFIED** (no send): see
  `recruiter-workflows/bulk-message-draft.json` — navigate pipeline → select-all → Message →
  composer opens with N recipients ("To: … View all N"), template picker, empty body, "Send"
  button present but NOT clicked. Send label is locale-dependent ("Send this message" /
  "Enviar este mensaje"). Easy Recruit sandbox = project `2051206850` (now 3 candidates:
  Oscar, Andrey, Franz — Franz added 2026-06-08 via the bridge below).
- **(4) Create a new project — DONE & LIVE-VERIFIED 2026-06-08** (`recruiter-workflows/create-project.json`,
  workflow `dd8fe22d`, promoted to system). Created **"-EZ Full Stack Developer"** live (confirmed
  in /talent/projects). Flow: navigate **`/talent/create/get-started`** → type name into
  **`input[data-test-project-name-input]`** → click **`button[data-test-create-button]`**
  ("Create project"; the form then auto-navigates to the new project + "imports optimized search
  results"). Goal: an Odoo **new job position** → create a Recruiter project named **`-EZ <position>`**
  (the `-EZ` prefix marks our auto-created projects so we can find/clean them). The workflow
  creates an **EMPTY standalone project** (candidates added later by search/save → composes:
  create → search → save → message). Design notes for the eventual Odoo trigger (NOT connected
  now, per user):
  - **Param**: the project NAME (= `-EZ ` + position) is the single runtime input Odoo would
    pass — keep it as one `type` step. The daemon doesn't substitute `runtime_params` into step
    values yet → hardcode the example now; backend param-substitution (bake into the run snapshot
    at creation) is the prerequisite for a live trigger.
  - **Dedup** (don't create `-EZ X` twice for the same position) is **trigger/reconciler logic
    (backend)**, not the workflow — the workflow just creates.
  - Verified: created "-EZ Full Stack Developer" live → projects count 4→5, listed in
    /talent/projects. (The "Create a project" link on /talent/projects targets
    `/talent/create/get-started`; the form's only required field is the name.)
- **Adding a public `/in/` profile to a project (the "Find a person" bridge, flow 9):** the
  public profile has no Save-to-project; it has a **"Ver en Recruiter"** link →
  `/talent/profile/<id>` (extract that href, navigate to it, then run save-to-project).
  **Bridged profiles load slowly** — the first save attempt clicked through before the
  candidate context was ready and showed "Saving…" but didn't persist; adding generous delay
  steps after navigating the bridged profile (and before Save) fixed it. Verify saves via the
  **project pipeline count**, not the bridged `/talent/profile` URL (which can show "Projects 0").

**Iteration constraint (learned 2026-06-05):** creating + running workflows uses only the
public AWS API (no SSH needed — the daemon claims them). But any DAEMON CODE change (new
extract strategy, the headline fix) needs a daemon restart, which on-demand only fires while
`linkedin-bot` is interactively logged on (else it sticks "Queued") — so batch daemon-code
changes for a moment when Fernanda is at the host, or for the next boot. Pure-workflow flows
(navigate/click/existing-strategy) avoid this entirely.

### Recruiter ↔ Odoo integration — BUILT & LIVE E2E-VERIFIED 2026-06-08 ✅
Full design: **`docs/recruiter-odoo-integration-design.md`**. The whole loop now runs end-to-end:
Odoo new position → create `-EZ <position>` project → push its URL to `hr.job.recruiter_project_url`
→ AI-Copilot search → push candidates as `linkedin.lead` → save N to the project. **Message-send
stays MANUAL/gated** — req B is now WIRED but deliberate: `RecruiterPipelineService.send_messages(job_id)`
(via `POST /v1/recruiter/jobs/{job_id}/send-messages`) reconstructs the job's saved candidates, fires a
`recruiter_message` run (parameterized bulk-message wf `3541e5a8`); on completion the terminal hook
(`_after_message`) pushes `/akcr/api/lead_outreach_update` → `outreach_status=messaged`. ⚠️ Sends real
InMail; NEVER auto-fired by the pipeline. (Wiring deployed + endpoint verified; live send still gated.)
**Live E2E (qaodoo job 307 "DevOps Engineer"):** created project `2053887530`, wrote its URL back to
job 307, created **7 leads** (all `/talent/profile/` URLs), saved 2 candidates to the project.
- **Trigger** = `recruiter_pipeline` event_kind on connector `2c7a49e9` (qaodoo). The
  **reconcile-supervisor** (polls qaodoo every 5 min for `linkedin_sync+published` jobs >
  `reconcile_min_job_id`) fires it server-side from AWS — NOT a direct webhook. Keep only ONE flow
  trigger enabled (we disabled `linkedin_lead_search` so a position doesn't double-fire). Bumped the
  watermark to the current max so only NEW positions fire (don't backfill existing jobs).
- **Pieces (this repo, all deployed to AWS):** `ExecutionService.create_run` substitutes `{{key}}`
  runtime_params into literal-workflow snapshot steps (the unlock); `RecruiterPipelineService` chains
  the sub-workflows as sequential daemon runs via the `transition` terminal hook; `RecruiterPushService`
  does the 3 write-backs; `recruiter_pipeline` event_kind in `WebhookTriggerService` + the reconciler
  gate (`ALLOWED_TRIGGER_EVENT_KINDS`). 3 parameterized workflows: create-project `29ec1891`, search
  `f6f99011`, save `a352e1e4` — IDs live in **both** `.env.prod` AND the backend `environment:` block
  in `docker-compose.prod.yml` (the compose maps env explicitly → `.env.prod` alone is NOT injected).
- **akodoo (qaodoo):** `hr.job.recruiter_project_url`/`_id` + `/akcr/api/job_project_link` +
  `/akcr/api/lead_outreach_update` — PR **#1813**, merged to the `qaodoo` branch.

### Running a test on the sensitive account — READ before EVERY test (2026-06-08)
- **The daemon is UNCONDITIONALLY anti-bot protected; the `config.anti_bot` "Human-like execution"
  toggle is EXTENSION-ONLY and is moot for our runs.** Every recruiter/test run goes through the
  daemon (`execution_target=daemon`, `use_profile`), which ALWAYS applies fingerprint stealth +
  circuit breaker + budget + human-like input (bezier mouse, human typing) and **deliberately ignores**
  the per-workflow toggle (`driver-daemon.mjs` ~1353) so this flagged high-risk path can never be
  un-protected. So protection is always on — there is **no toggle to flip** for daemon runs. Only
  **extension/dashboard-driven** runs honor `config.anti_bot` (turn it ON there). **NEVER run recruiter
  tests via the raw extension / bypassing the daemon** — that's the only way to lose the protection.
- **Per-step dashboard screenshots + wait-for-selector — FIXED 2026-06-08 (synced, pending restart).**
  The daemon now (a) polls the PRIMARY recorded selector up to `STEP_RESOLVE_TIMEOUT_MS` (12s) before
  a generic click/type via `resolveLocatorWithWait` — handles the async `/talent` SPA, so the blind
  no-op `scroll` "delay" steps in the recorded flows are no longer needed; and (b) uploads a dashboard
  screenshot **per generic step** (after `STEP_SHOT_SETTLE_MS` settle + the wait → a loaded page, not
  mid-render) so a human watching the run sees each action's result (the generic loop never called
  `uploadStepShot` before — only the hardcoded applicant path did). Code is in
  `extension/{driver-daemon.mjs,src/behavior/selector-resolve.mjs}` (commit `3eee01a`) and **synced to
  the host `C:\Users\Public\extension`**, but the RUNNING daemon still has the old code in memory — it
  goes live on the **next daemon restart**, which lapses the `/talent` seat → **Fernanda re-login**.
  Until that restart, runs still show mid-load screenshots / rely on the delay steps. (Daemon code path
  on the host is `C:\Users\Public\extension`, run by `daemon-task.ps1` via the `linkedin-bot-daemon`
  scheduled task — `findstr`/`where` over SSH need `cmd /c` or they shell-mangle the path.)
- **Pre-flight:** confirm the warm `/talent` seat first (run workflow `7246989f` "Open Talent Home"
  read-only on `fernanda`; completes = warm, pauses `waiting_for_user` = walled → re-login needed).

### Recruiter /talent selector + build tips (learned 2026-06-08)
- **The /talent UI is in SPANISH** ("Guardar en proyecto", "Seleccionar proyecto existente").
  Recorded ENGLISH `text` selectors won't match. Prefer **css / `data-test-*` / stable ids**
  (locale-independent). Recruiter is rich in stable hooks: `[data-test-action='save-to-project'|'save'|'cancel']`,
  `#choose-existing-projects` / `#create-new-project` (radios), `#save-to-projects-typeahead`
  (project combobox), `li[role=option]` + `[data-test-project-typeahead-result-title]` (project
  options — click by exact project `text`). The recording's `nth-of-type`/absolute-xpath chains
  are fragile; its `anchor` selectors carry dict values that 422 the create-step API (lift
  text/css/xpath only).
- **Build flows capture-first**, never blind-replay the recording: run a snapshot-only workflow
  that opens the UI (clicks to reveal a panel/dialog), `scp` the per-step snapshots, read the
  PNG + `dom.json` + grep the HTML, lock selectors offline. Reusable builder:
  **`scripts/create_recruiter_workflow.py spec.json`** (POSTs /v1/workflows + /steps + activates;
  pure AWS API, no daemon restart → warm seat preserved). Specs live in `recruiter-workflows/`.
- **Async-rendered elements (typeaheads/dropdowns):** the daemon's Phase-A verbs are only
  `{click,type}` and resolve selectors ONCE (no wait/retry); `delay_before_ms` isn't settable
  via the step API. To wait for an async list before clicking it, insert **no-op `scroll`/`hover`
  steps** (not in PHASE_A_VERBS → they fall through to a noop that still costs ~2s each with
  snapshot on). A real fix (wait-for-selector in clickResolved) is a good future daemon change
  — batch it for a restart window. Verify writes by re-reading the page (a read-only nav+snapshot),
  since the daemon reports step success even on a soft-miss.

### Recruiter session is SEPARATE from linkedin.com (blocker found 2026-06-04)
Driving `/talent/` needs its OWN sign-in even when the daemon's regular linkedin.com
session (`li_at`, valid to 2027-06-04) is live. Hitting `/talent/home` redirects to
`/uas/login-cap` → **"Inicia sesión en LinkedIn Talent Solutions"** with the email
PRE-FILLED (`fbenavides@akurey.com`) — i.e. the account is recognized but Recruiter
wants a password to establish its seat session. The daemon never used Recruiter, so
`.linkedin-profile` has NO Recruiter session. **Fix = a ONE-TIME interactive Talent
Solutions sign-in at the host, into the SAME `.linkedin-profile`** (physical screen or
Chrome Remote Desktop / AnyDesk — Win11 Home has no RDP). Do NOT automate the password
on this sensitive account. After that, the probe below can capture the composer.

**RESOLVED 2026-06-05 — Recruiter session now LIVE in `.linkedin-profile`.** The
one-time interactive Talent sign-in was done and verified: `recruiter-sesscheck`
(read-only single nav to `/talent/home`) returns `LOGGED_IN`, title "LinkedIn Talent
Solutions", no login-cap redirect. The `/talent/` sub-workflows can now run live (with
the same anti-bot discipline — deliberate tests only).

How it was done (the easy + safe path — the cookie transplant route was a DEAD END):
- **Cookie transplant from Fernanda's personal Chrome FAILED** — Chrome 148 uses
  **App-Bound Encryption** on her profile; opening a VSS copy of it as `linkedin-bot`
  decrypted **0 cookies** (ABE binds cookies to her user), and registering an S4U task
  AS her user is "Access denied". ABE + Windows security block cross-user cookie reuse
  by design. Don't retry the transplant.
- **What worked:** sign in to Talent ONCE directly in `.linkedin-profile`, running
  Chrome **as the `linkedin-bot` user** (interactive desktop: physical switch-user to
  `linkedin-bot`, pw `admin`). Launcher `login-talent.bat` on linkedin-bot's Desktop →
  `extension/login-talent.mjs` (visible Chrome on `.linkedin-profile`, auto-closes on
  `/talent/`, has a guard that aborts if NOT run as linkedin-bot). `.linkedin-profile`
  uses **classic DPAPI (no ABE)**, so cookies written as linkedin-bot are daemon-readable.
- CRD attaches to the **console** session (María's), so the linkedin-bot switch-user must
  be done at the physical screen, not over CRD.
To re-verify later: register+start `recruiter-sesscheck` (host helpers:
`register-sesscheck.ps1` / `sesscheck-task.ps1` / `wait-sesscheck.ps1`).

### Driving Recruiter (/talent) with the DAEMON — proven 2026-06-05

The daemon can now drive a backend workflow against `/talent` using the staged
Recruiter profile. Live-proven: run `e24a66e1` of workflow **"Recruiter: Open Talent
Home"** (`7246989f-a6ce-4b8a-b7f4-16a49d930cae`) → daemon (operator `fernanda`)
navigated to the REAL `/talent/home` (title "LinkedIn Talent Solutions", 116 interactive
els, 1.86 MB HTML), `completed`, no wall, no circuit trip.

- **Daemon opt-in to the profile:** a generic daemon run uses an EPHEMERAL context by
  default; pass `execution_options.use_profile: true` so it uses `.linkedin-profile`
  (the Recruiter session). Added at `driver-daemon.mjs` (the `contextDir` line).
- **Per-step DOM snapshots:** pass `execution_options.snapshot: true` → each step writes
  full HTML + DOM inventory + screenshot to `extension/recruiter-snapshots/<runId>/`
  (via `src/behavior/page-snapshot.mjs`). Pull to the repo with `scp` and analyze
  **offline** — never reload the live account to tune selectors (see memory
  `feedback_recruiter_offline_selector_iteration`). Offline harness:
  `node extension/analyze-snapshot.mjs <snapshot.html> [--sel "css"] [--grep text]`.
- **Trigger a daemon Recruiter run:**
  ```
  curl -s -X POST https://52-5-45-84.sslip.io/v1/workflows/<id>/run-with-params \
    -H 'X-API-Key: <gateway-key>' -H 'Content-Type: application/json' \
    -d '{"execution_target":"daemon","operator_id":"fernanda",
         "execution_options":{"use_profile":true,"snapshot":true},"runtime_params":{}}'
  ```
  New workflows created via `POST /v1/workflows` default to `execution_mode=generic`
  (so the daemon's generic loop drives the recorded steps). The daemon claims it because
  `origin.target_operator == OPERATOR_ID` (`fernanda`) — its daemon must be enabled+running.

- **Session lives in `.linkedin-profile`** and persists (treat it like the regular
  linkedin.com session). During S4U/login tasks keep the daemon Disabled so it doesn't
  race for the profile; re-enable to run. If `/talent` ever walls to `/uas/login-cap`,
  re-establish it with a one-time `login-talent.bat` as the `linkedin-bot` user.

- **The Recruiter SEAT dies on browser CLOSE — the daemon now keeps ONE browser OPEN**
  (fix + LIVE-VERIFIED 2026-06-05 — 5 warm pings / ~15 min sustained, browser never
  relaunched; `driver-daemon.mjs`). The `/talent` seat is held by a session-scoped
  cookie + the open SPA's realtime polling; both are lost when Chrome closes (the
  persistent `li_at` survives, the seat doesn't — that's why it lapsed in ~5 min while
  Fernanda's always-open browser lasts weeks). The daemon used to launch+close Chrome for
  every run/ping. Now `getProfileContext()` opens `.linkedin-profile` ONCE and keeps it
  open; the keep-alive (`RECRUITER_KEEPALIVE=1`, already in `daemon-task.ps1`) re-asserts
  `/talent/home` in the parked tab every 2-3 min and never closes it, and every profile
  run REUSES that context (one Chrome per profile = profile-lock forces a single shared
  context). **Activation from a walled state (needs the sensitive password → human-only):**
  the daemon must be DOWN during login (its open browser holds the profile lock). 1) physical
  screen → switch-user to `linkedin-bot`; 2) `login-talent.bat`; 3) start the daemon — its
  +30s ping grabs the warm seat and holds it. Watch `daemon.task.log` for sustained
  `[keepalive] /talent OK … warm`; if it walls every few min DESPITE the open browser, it's
  contention (Fernanda using Recruiter in parallel), not idle. See memory
  `project_recruiter_seat_keepalive`.

- **Restarting the daemon task is finicky** (cost ~1h on 2026-06-05). `schtasks /End`
  orphans `node`; a `taskkill /F /IM node.exe` then leaves the **session-0 `powershell.exe`
  wrapper alive as a phantom**, and `MultipleInstancesPolicy=IgnoreNew` makes every start
  request stick in "Queued". To restart: kill BOTH `node.exe` AND the session-0 wrapper
  `powershell.exe`. And on-demand start of the S4U BootTrigger task only works at boot or
  while `linkedin-bot` is interactively logged on — otherwise `schtasks /Run` /
  `Start-ScheduledTask` just QUEUE. Reliable starts: reboot, or `run-daemon-visible.bat` in
  the interactive linkedin-bot session (which is the activation context anyway).

- **Saving / restoring the session** (host scripts in `C:\Users\Public\extension\`):
  - `backup-recruiter-session.ps1` → copies `.linkedin-profile` cookies + Local State to
    `.linkedin-profile-backup\<stamp>\` (+ `LATEST.txt`).
  - `restore-recruiter-session.ps1 [-Stamp <stamp>]` → restores that cookie state (daemon
    must be Disabled / no chrome on the profile). **DPAPI caveat:** restore only works on
    THIS host/user. If `/talent` still walls after a restore, re-run `login-talent.bat`.

- **To see the daemon drive Talent in a VISIBLE browser:** the S4U daemon runs in
  session 0 (its Chrome is invisible). Run the daemon in an INTERACTIVE desktop instead —
  `run-daemon-visible.bat` on the `linkedin-bot` Desktop (sets the same env, runs
  `node driver-daemon.mjs` in a console). Stop/Disable the S4U task first so they don't
  race; re-enable it after.

### How to run the read-only composer probe (the right way)
`extension/recruiter-composer-probe.mjs` — read-only, human-slow (bezier mouse, multi-s
dwells, reuses `page-nav`/`blocker-detect`); NEVER types a body or clicks Send; aborts on
any wall without tripping the circuit breaker. Writes screenshots + DOM inventory +
`STATUS` to `.debug/composer-probe/`. Its job: capture the two selectors the recording
never recorded — the message BODY field and the SEND button.

**Must run in the daemon's logon context, NOT raw SSH.** Launched directly over SSH
(linkedin-bot network logon) Chrome can't DPAPI-decrypt the staged cookies (Local State
uses classic `encrypted_key`, no App-Bound) → login wall. Run it via a one-shot scheduled
task with the SAME principal as `linkedin-bot-daemon` (UserId `linkedin-bot`, LogonType
**S4U**, RunLevel Highest). Helper scripts (host `C:\Users\Public\extension\`):
`probe-task.ps1` (action wrapper) + `register-probe-task.ps1` (registers+starts task
`recruiter-probe`) + `wait-probe.ps1` (polls STATUS). Keep the daemon **Disabled** during
the probe so it doesn't race for the profile. Pre-flight with `recon.ps1` (profile lock /
chrome-on-profile / budget breaker).

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

## Deploying changes — AWS is the source of truth (keep ALL parts in sync)

The backend runs on **AWS** (single EC2 + docker-compose), and everything reaches it
at the stable URL **`https://52-5-45-84.sslip.io`**. Infra IDs / secrets / teardown
are in memory `project_aws_backend_deploy`.

**Standing rule: after ANY change, redeploy so every part stays up to date** — the
backend on AWS AND the clients that point at it (extension, daemon on Fernanda's host,
frontend). Don't leave the box running stale code.

Per change:
- **Backend (`backend/` or `deploy/`)** → `./deploy/redeploy.sh` (one command: packages
  source, ships to the EC2, rebuilds the image, restarts the `backend` container, checks
  health). Manual equivalent: `scp` source to `/opt/sr/backend`, then on the box
  `cd /opt/sr/deploy && sudo docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build backend`.
- **Extension (`extension/`)** → rebuild pointed at AWS, then reload on each browser host:
  `VITE_API_BASE_URL=https://52-5-45-84.sslip.io/v1 VITE_API_KEY=<gateway-key> npm run build`
  → copy `dist/` to the host → reload unpacked.
- **Daemon (`extension/driver-daemon.mjs` + `src/`)** → re-sync `extension/` to Fernanda's
  host (`C:\Users\Public\extension`, see windows runbook) + restart `linkedin-bot-daemon`.
  It already points at AWS via `daemon-task.ps1` (`BACKEND`/`API_KEY`).
- **Frontend (`frontend/`)** → `frontend/.env` points at AWS; rebuild/serve.

**NEVER `docker compose down -v`** on the box: the Postgres volume holds the only
consistent schema (it can't be rebuilt from `create_all`/`alembic` — see the memory;
recreate only via a `pg_dump` restore). Redeploys reuse the volume.

Secrets never in git: `deploy/.env.prod` (on the box) + `deploy/sr-ec2.pem` are
gitignored. The gateway `API_KEY` must match across backend `.env.prod`, the
extension/frontend builds, and the daemon's `daemon-task.ps1`. (Future: a GitHub
Action on push could automate the backend redeploy; today it's `redeploy.sh`.)

## Daemon routing by operator (who runs what, and WHERE)

Multiple daemons poll the AWS backend; each claims **only runs targeted at it**.
- Each daemon runs with env `OPERATOR_ID` (Andrey's Mac = `andrey`, Fernanda's host =
  `fernanda`). `findPendingRun` (driver-daemon.mjs) claims a run only if
  `origin.target_operator === OPERATOR_ID` (on top of the existing isWatched gate).
- `origin.target_operator` is stamped at run creation:
  - **Dashboard "Run with daemon"** → the requesting operator's id, ALWAYS (incl.
    LinkedIn workflows). Flow: dashboard Settings "Operator ID" →
    `localStorage["sr.operatorId"]` → `DASHBOARD_RUN_WORKFLOW` postMessage → extension →
    `run-with-params { operator_id }` → backend → `target_operator = operator_id`.
    (Changed 2026-06-05: LinkedIn workflows are NO LONGER force-pinned to
    `linkedin_operator` on the dashboard path — any operator, e.g. Andrey, can run a
    LinkedIn workflow from their own host. Per-workflow operator pinning is a future
    feature.)
  - **Webhook/reconciler LinkedIn runs** (`new_job_position`/`linkedin_lead_search`) →
    STILL always `linkedin_operator` (Fernanda), in `WebhookTriggerService._fire` —
    that path has no human requester and needs the host holding the LinkedIn session.
- Net effect: dashboard runs (incl. LinkedIn) execute on the CLICKING operator's OWN
  machine; only automated webhook/reconciler LinkedIn flows are pinned to Fernanda's
  host. Offline target daemon ⇒ the run waits QUEUED (never falls back to the wrong
  machine). Each operator's host must hold its OWN logged-in LinkedIn session to run
  LinkedIn workflows there.
- Per operator: set "Operator ID" in dashboard Settings to match that machine's daemon
  `OPERATOR_ID`. Install a local daemon pointed at AWS:
  `DAEMON_BACKEND=https://52-5-45-84.sslip.io DAEMON_API_KEY=<key> DAEMON_OPERATOR_ID=<id> make daemon-install`
  (the launchd template renders `__BACKEND__/__API_KEY__/__OPERATOR_ID__`).
- `GET /v1/daemon/status` now includes each worker's `operator_id`.

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
