# Recruiter sub-workflow build notes

Detailed build status, run IDs, selectors, and gotchas per sub-workflow.
Summary table lives in `CLAUDE.md`. Daemon + session ops are in `docs/recruiter-daemon-ops.md`.

## Sub-workflow build status

- **(2) Search → candidates — DONE & LIVE-VERIFIED.** Workflow `5bdc4d51-cbe8-46fb-986e-da67f9e4a3d1`
  "Recruiter Search → candidates" (generic, 3 steps): navigate `/talent/home` → navigate
  `/talent/search?searchHistoryId=21166179650&start=0` → extract (strategy
  `recruiter_search_people`, hot-loaded from `extension/runtime-strategies/recruiter.mjs`). Live run
  `e2cbdb34` extracted **4 candidates** (name + `/talent/profile/` URL) in 31s against the
  warm seat. Results land in the run's **`extracted_data`** field (`GET /v1/runs/{id}` →
  `extracted_data[0].people`; there is NO `/extraction` endpoint — that 405s). Run it:
  `POST /v1/workflows/5bdc4d51…/run-with-params` with
  `{"execution_target":"daemon","operator_id":"fernanda","execution_options":{"use_profile":true,"snapshot":true}}`.
  **Historical gap:** that run's `headline` came back `""` (the title sat deeper in the card than the
  innerText split reached) — extractor fixes now belong in the hot-loaded Recruiter strategy module,
  then sync just that file. The saved-search URL (`searchHistoryId`) is hardcoded — this `5bdc4d51` flow is
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

- **(2c) Advanced BOOLEAN search — DONE & LIVE-VERIFIED 2026-06-09** (`recruiter-workflows/advanced-boolean-search.json`,
  v4, run `602c34fb`). The facets CAN be driven (extends 2b): the keyword/boolean facet on
  `/talent/search/advanced` is a **`<textarea data-test-free-text-single-value-facet-textarea>`**
  (placeholder "Introducir palabras clave…"), revealed by **`button[aria-label="Añadir Palabras clave del
  perfil u operadores booleanos"]`**, and it **COMMITS ON ENTER (`\n`)** — **blur DISCARDS** the value, the
  Search button alone races/discards, and there is **NO apply button**. Flow: reveal facet → type
  `{{boolean_query}}\n` → click Search `button[data-test-save-advanced-button]` → extract. Live: a boolean
  returned real candidate cards (Hugo Villalta, Jonnathan Charpentier…). **CRITICAL: keywords-only is GLOBAL
  (1.4M+ results) — the location + skills/years facets are REQUIRED to focus to ~15, NOT optional "v2".**
  Years facet (from the recording): `input[name="range-from"]`/`[name="range-to"]` + **"Update"**
  `button.button-small-primary[type="submit"]` (a per-facet commit button). **Daemon extraction fixes applied
  2026-06-09:** `recruiter_search_people` now lives in hot-loaded
  `extension/runtime-strategies/recruiter.mjs`; it scrolls-to-stable per page (was 6 of 25 —
  lazy/virtualized list) and the pager "Next" is an **`<a data-test-pagination-next>`** (was `button`-only).
  The `total_count` regex still misreads the "1 – 25" page indicator on huge sets — fine once focused (small
  "N resultados"). **Lesson: free-text Recruiter facets commit on ENTER, not blur; the daemon's generic `type`
  can send `\n` (Enter) but cannot blur/press-key otherwise.**

- **(2d) FOCUSED, position-driven search (location facet + Odoo-built booleans) — LIVE-VERIFIED 2026-06-09.**
  Keywords-only is global (1.4M); the **LOCATION facet** is the big lever (1.4M → 3K for Costa Rica), and a
  **real-JD boolean** lands it focused: job 231 "Sr. Full-Stack Engineer" → `Next.js AND React AND Azure` +
  Costa Rica → **146 results**, top hit a perfect Senior Full-Stack/.NET/React in San José. The LOCATION facet is
  a **typeahead** (NOT free-text like keywords): reveal `button[aria-label="Añadir ubicación del candidato"]` →
  type into `[data-test-facet-locations] input.ts-common-typeahead__input` → click the top suggestion
  `li[data-live-test-result="0"]` (selecting it commits — no Enter). Workflow:
  `recruiter-workflows/focused-boolean-location-search.json` (params: boolean_query, location; ends on results,
  no extract). **Booleans are generated FROM Odoo positions by the AI builder** — `scripts/boolean_from_odoo.py
  <id…>` fetches the position's JD corpus from the Odoo DB (morsoft psql; the live pipeline uses the OdooAdapter
  on qaodoo) → `BooleanQueryBuilder` → a per-position boolean, kept "in place" in
  `recruiter-workflows/odoo-position-booleans.json` (15 dev positions). NEVER hand-craft the boolean — derive it
  from the real JD (the user's directive). The builder now strips version numbers ("Next.js 15"→"Next.js") so
  AND terms don't over-narrow. To go 146 → ~15: raise tightness / add the years facet (`input[name="range-from"]`/
  `[name="range-to"]` + "Update" `button.button-small-primary[type="submit"]`, per the recording) — the calibration knob.

- **(2e/3b) Results-page extract + save — LIVE-VERIFIED 2026-06-09.** Workflow
  `1bc44128-6755-437e-b41c-2cc65d135454` run `017d0562-6fa3-4614-b943-0d739b394fb5`
  extracted **30 unique `/talent/profile/` URLs** from the focused search, proving lazy-list scroll plus pagination
  (`total_count=576`, final URL `start=25`). Capture workflow `719c53bc-49d3-4b46-8229-7a0e4c92d276` run
  `b9d184c0-0016-4037-b79c-039e68361c3d` confirmed the results-page Save dialog reuses the profile selectors:
  it opens in **Crear proyecto** mode, then use `label[for='choose-existing-projects']` → `#save-to-projects-typeahead`
  → exact project text → `button[data-test-action='save']`. Results-page bulk save is in hot-loaded
  `recruiter_save_results_to_project`; it selects per-card `input.small-input` under `article.profile-list-item`
  and falls back to `input.click()` only if the human-like checkbox click does not set `checked`. Verified save:
  short workflow `7f11deb6-0d44-4298-b047-4fadb71ba559` run `21324185-bcc8-4fd5-8bef-b7d3a9247cac`
  saved **Luis Avila** (`AEMAACKigzwBVBIoagTPi7vBzuNJRarUDrXOYKk`) to sandbox project **Easy Recruit**; final
  snapshot toast: "Se ha guardado a Luis Avila en el proyecto." Prefer the short workflow
  `recruiter-workflows/save-current-search-url-results-to-project.json` when a concrete `/talent/search` URL already
  exists, to avoid re-driving advanced facets.

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

## Recruiter ↔ Odoo integration — E2E detail

Full design: **`docs/recruiter-odoo-integration-design.md`**. The whole loop now runs end-to-end:
Odoo new position → create `-EZ <position>` project → push its URL to `hr.job.recruiter_project_url`
→ AI-Copilot search → push candidates as `linkedin.lead` → save N to the project. **Message-send
stays MANUAL/gated** — req B is now WIRED but deliberate: `RecruiterPipelineService.send_messages(job_id)`
(via `POST /v1/recruiter/jobs/{job_id}/send-messages`) reconstructs the job's saved candidates, fires a
`recruiter_message` run (parameterized bulk-message wf `3541e5a8`); on completion the terminal hook
(`_after_message`) pushes `/akcr/api/lead_outreach_update` → `outreach_status=messaged`. ⚠️ Sends real
InMail; NEVER auto-fired by the pipeline. **LIVE-VERIFIED 2026-06-09:** a `recruiter_message` run
to the Easy Recruit project (synthetic job 308 + 2 leads) completed → the hook flipped both leads to
`outreach_status=messaged` + logged 2 `linkedin.lead.message` (outbound/sent, inmail) in qaodoo.

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

## Recruiter /talent selector + build tips

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

## Recruiter session is SEPARATE — historical (resolved 2026-06-05)

Driving `/talent/` needs its OWN sign-in even when the daemon's regular linkedin.com
session (`li_at`) is live. Hitting `/talent/home` redirects to `/uas/login-cap` →
**"Inicia sesión en LinkedIn Talent Solutions"** (email pre-filled `fbenavides@akurey.com`).

**RESOLVED:** one-time interactive Talent sign-in was done and verified. The `/talent/` sub-workflows can now run live.

How it was done:
- **Cookie transplant from Fernanda's personal Chrome FAILED** — Chrome 148 uses App-Bound
  Encryption; opening a VSS copy as `linkedin-bot` decrypted 0 cookies. Don't retry.
- **What worked:** sign in to Talent ONCE directly in `.linkedin-profile`, running Chrome as
  `linkedin-bot` (physical switch-user; pw `admin`). Launcher `login-talent.bat` on Desktop →
  `extension/login-talent.mjs`. `.linkedin-profile` uses classic DPAPI (no ABE) so cookies
  are daemon-readable.
- CRD attaches to the **console** session (María's) — the linkedin-bot switch-user must be
  done at the physical screen, not over CRD.

To re-verify: register+start `recruiter-sesscheck` (host helpers:
`register-sesscheck.ps1` / `sesscheck-task.ps1` / `wait-sesscheck.ps1`).

## How to run the read-only composer probe

`extension/recruiter-composer-probe.mjs` — read-only, human-slow (bezier mouse, multi-s
dwells); NEVER types a body or clicks Send; aborts on any wall. Writes screenshots + DOM
inventory + `STATUS` to `.debug/composer-probe/`.

**Must run via S4U scheduled task**, NOT raw SSH (network-logon Chrome can't DPAPI-decrypt
staged cookies → login wall). Helper scripts (host `C:\Users\Public\extension\`):
`probe-task.ps1` + `register-probe-task.ps1` (registers+starts `recruiter-probe`) +
`wait-probe.ps1` (polls STATUS). Keep the daemon **Disabled** during the probe.
Pre-flight with `recon.ps1` (profile lock / chrome-on-profile / budget breaker).

## Runtime strategy hot-reload

Recruiter strategy changes go in **`extension/runtime-strategies/recruiter.mjs`**, NOT in the
long-lived daemon loop. The module is hot-loaded by the running daemon on the next `recruiter_*`
strategy run (file mtime as import cache-buster) — no daemon restart, no `/talent` seat loss:

```
scp extension/runtime-strategies/recruiter.mjs linkedin-bot@100.107.206.110:'C:/Users/Public/extension/runtime-strategies/recruiter.mjs'
```

Verified live 2026-06-09: daemon PID stayed `1828`, the host log showed
`[daemon] hot-loaded runtime strategy "recruiter"` plus `/talent OK — Recruiter seat warm`.

Still requires restart + Fernanda re-login: edits to `extension/driver-daemon.mjs`, shared
behavior in `extension/src/behavior/`, env/task config, dependency changes, or new strategy
families. Pure-workflow flows (navigate/click/type/existing strategy) avoid restart entirely.
