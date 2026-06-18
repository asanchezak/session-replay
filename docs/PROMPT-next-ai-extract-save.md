# Kickoff prompt — LinkedIn Recruiter: ~30 results (scroll + pagination) + save-to-project from results

> Paste this into the next AI session working on the `session-replay` repo. It is self-contained;
> the exhaustive detail lives in `docs/NEXT-TASK-recruiter-extract-and-save.md` (same repo) — read it.

---

You are continuing the **LinkedIn Recruiter (`/talent`) automation** in the `session-replay` repo
(branch `feat/recruiter-odoo-pipeline`). The **boolean search already works**. A human just
**restarted the daemon and re-logged-in the `/talent` seat** right before you started.

## Why the restart (context that just changed)
The daemon's extractor (`extension/driver-daemon.mjs` → `scrapeRecruiterSearch`) got a fix committed
(scroll-until-the-card-count-stabilizes per page + the results pager "Next" is an
`<a data-test-pagination-next>`, not a `<button>`). That code was **synced to the host**
(`C:\Users\Public\extension\driver-daemon.mjs`, 99,055 bytes, 2026-06-09) and the daemon **restarted**
to load it — which kills the warm `/talent` seat, so the human also **re-logged-in** (`login-talent.bat`).
So the fix should now be **LIVE but UNVERIFIED** — verifying it actually gathers ~30 (not ~6) is Part 1.

## Step 0 — verify health BEFORE any search
1. **Daemon up:** `GET https://52-5-45-84.sslip.io/v1/daemon/status` (header
   `X-API-Key: 28e54ef83e040faa366260aa13af5f5b1947b364731e1f22`) → a `fernanda` worker, up, recent.
2. **Seat warm:** trigger the read-only "Open Talent Home" workflow
   `7246989f-a6ce-4b8a-b7f4-16a49d930cae` (daemon, operator `fernanda`, `use_profile:true`,
   `snapshot:true`); poll `GET /v1/runs/<id>` → must **complete** and land on
   `https://www.linkedin.com/talent/home` (NOT `/uas/login-cap`). If it walls/pauses → seat not warm;
   STOP and ask the human to re-run `login-talent.bat` (physical screen, user `linkedin-bot`, pw `admin`).
   ⚠️ "completed" alone ≠ warm — check the landing URL via the snapshot.
3. **New code loaded:** the daemon node process should be a fresh pid. (To grep the host file use
   PowerShell `Select-String`, NOT `findstr` — findstr is UTF-8-blind on this file.)

## The task (two parts)
**Part 1 — reliably collect ~30 results.** Run a focused search (a real Odoo boolean from
`recruiter-workflows/odoo-position-booleans.json` + a location broad enough to exceed 30) WITH the
`recruiter_search_people` extract + `snapshot:true`. From `GET /v1/runs/<id>` read
`extracted_data[0].people` (count) and `.total_count`; pull the results snapshots. Confirm it now
gathers ~25/page (scroll-to-stable) AND advances pages (pagination `<a>`), deduped by `/talent/profile/`
URL, up to ~30. If still short: switch the extractor to **scroll-and-collect** (extract + dedup at each
scroll step, not one extract at the end) and/or raise `MAX_PAGES` (currently 4) → re-sync to host +
restart (= another human re-login; batch it) + re-verify. Log any cap you impose (no silent truncation).

**Part 2 — save candidates to a project, from the results page.** Each result card has
`button[data-test-action="save-to-project"]`; per-card checkboxes are `input.small-input` (the header
one = "select all N"). **Capture-first**: a read-only run that does a small focused search, clicks one
card's save button (or selects via checkboxes → the bulk-action bar
`[data-test-profile-list-bulk-actions]`), and SNAPSHOTS the dialog that opens. The dialog likely
matches `recruiter-workflows/save-to-project.json` (the profile-page flow):
`label[for='choose-existing-projects']` → type into `#save-to-projects-typeahead` → (insert no-op
`scroll` delays for the async typeahead) → click the option by exact project `text` →
`button[data-test-action='save']`. Build a workflow to save N candidates into the **"Easy Recruit"**
sandbox project (id `2051206850`). Verify via the project's pipeline count (the daemon reports step
success even on a soft-miss — don't trust it; re-read the page).

## Key selectors (Spanish `/talent` UI — prefer `data-test-*`)
| Thing | Selector |
|---|---|
| Keyword/boolean facet reveal | `button[aria-label="Añadir Palabras clave del perfil u operadores booleanos"]` |
| Keyword field (commit on `\n`) | `textarea[data-test-free-text-single-value-facet-textarea]` |
| Location facet reveal | `button[aria-label="Añadir ubicación del candidato"]` |
| Location input / top suggestion | `[data-test-facet-locations] input.ts-common-typeahead__input` / `li[data-live-test-result="0"]` |
| Run search | `button[data-test-save-advanced-button]` |
| Result card / candidate link | `[data-view-name^="talent-profile-list-element"]` / `a[href*="/talent/profile/"]` |
| Save-to-project (per card) | `button[data-test-action="save-to-project"]` |
| Per-card checkbox / select-all | `input.small-input` (header = select all) |
| Pagination "Next" (an `<a>`) | `[data-test-pagination-next]` / `a[aria-label*="siguiente" i]` |

## Environment & recipes
- Backend (source of truth): `https://52-5-45-84.sslip.io`, key above. Daemon on Fernanda's Windows
  host (`ssh linkedin-bot@100.107.206.110`, default shell cmd; PowerShell via
  `powershell -NoProfile -EncodedCommand <base64-UTF16LE>`). Daemon code + snapshots at
  `C:\Users\Public\extension`. The S4U task is `linkedin-bot-daemon`, `OPERATOR_ID=fernanda`.
- Run a workflow: `POST /v1/workflows/<id>/run-with-params` with
  `{"execution_target":"daemon","operator_id":"fernanda","execution_options":{"use_profile":true,"snapshot":true},"runtime_params":{…}}`.
- Create a workflow (pure AWS API, no restart, keeps the seat warm):
  `SR_API_KEY=<key> python3 scripts/create_recruiter_workflow.py spec.json`.
- Pull a step snapshot to analyze OFFLINE:
  `scp linkedin-bot@100.107.206.110:'C:/Users/Public/extension/recruiter-snapshots/<run>/step-N-<action>.{html,png}' /tmp/`.
- Generate a boolean from an Odoo position: `cd backend && python3 ../scripts/boolean_from_odoo.py <id>`.
- Working focused search workflow spec: `recruiter-workflows/focused-boolean-location-search.json`.

## Hard rules
- **Sensitive account** — capture-first, deliberate runs only; tune selectors OFFLINE from snapshots,
  never reload the live account to fiddle.
- A daemon restart costs a human re-login (the seat dies on browser close). Batch daemon-code changes;
  prefer pure-workflow (navigate/click/type/existing-strategy) changes that need no restart.
- Spanish UI. Free-text facets commit on **Enter**; typeaheads commit by **selecting a suggestion**;
  the daemon's generic `type` can send `\n` (Enter) but cannot blur or press other keys.
- After backend changes redeploy AWS (`./deploy/redeploy.sh`); never `docker compose down -v`.
- **"Easy Recruit" sandbox project only** (id `2051206850`) — never a real recruiting project.

**Full briefing (all detail): `docs/NEXT-TASK-recruiter-extract-and-save.md` in this repo. Read it first.**
