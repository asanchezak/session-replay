# NEXT TASK — Recruiter: get ~30 results (scroll + pagination) + save them to a project from the results page

> Self-contained briefing. You are continuing work on the **LinkedIn Recruiter (`/talent`)
> automation** in the `session-replay` repo. The **boolean search already works**; this task is
> the next two steps. Read this whole doc before touching anything — the LinkedIn account is
> **VERY sensitive** (deliberate, capture-first work only; never casual live tests).

---

## 🎯 Mission (two parts)

1. **Collect ~30 results from a boolean search.** The results page shows **25 per page** and the
   list **lazy-loads** (only ~6 cards render until you scroll), plus there's **pagination** to more
   pages. You must reliably gather ~30 candidates by **scrolling to load the full page** AND
   **clicking "Next"** across pages, deduped.
2. **Save candidates to a specific project — directly from the results page.** Each result card has
   a **"Guardar en proyecto"** (Save to project) button; there's also a per-card checkbox for
   **bulk** selection. Build a flow that saves N candidates from the results page into a named
   project (no per-profile visit). Use the **"Easy Recruit"** sandbox project for tests, never a
   real recruiting project.

Verify by reading **snapshots** (the count + the cards + the post-save state), not by trusting the
run status. Don't extract/save more than needed for a test.

---

## ✅ What already works (your foundation — don't rebuild)

- **Boolean search via the advanced-search keyword facet.** On `/talent/search/advanced`:
  - Reveal the keyword facet: click **`button[aria-label="Añadir Palabras clave del perfil u operadores booleanos"]`**.
  - The keyword field is a **`<textarea data-test-free-text-single-value-facet-textarea>`**
    (placeholder "Introducir palabras clave…"). **It COMMITS ON ENTER (`\n`)** — blur DISCARDS the
    value, the Search button alone races/discards, there is **no apply button**. The daemon's
    generic `type` verb types `{{boolean_query}}\n` and the `\n` fires a real Enter (that's the commit).
  - Run the search: click **`button[data-test-save-advanced-button]`** (text "Buscar"). Lands on
    `/talent/search?searchContextId=…` — the real results page.
- **Location facet** (the big count-lever): reveal **`button[aria-label="Añadir ubicación del candidato"]`**,
  type into **`[data-test-facet-locations] input.ts-common-typeahead__input`**, then **click the top
  suggestion `li[data-live-test-result="0"]`** (selecting it commits — it's a typeahead, NOT Enter).
- **Working workflow spec**: `recruiter-workflows/focused-boolean-location-search.json` (params:
  `boolean_query`, `location`; ends on the results page, NO extract). LIVE-VERIFIED 2026-06-09:
  job 231 → `Next.js AND React AND Azure` + Costa Rica → **146 focused results**, top hit spot-on.
- **Booleans are generated FROM Odoo positions** (never hand-crafted): `scripts/boolean_from_odoo.py
  <id…>` fetches each position's JD corpus from the Odoo DB → AI `BooleanQueryBuilder` → per-position
  boolean, stored in **`recruiter-workflows/odoo-position-booleans.json`** (15 dev positions).
- The funnel proven this session: keywords-only **1.4M** → +location **3K** → +real-JD boolean **146**.
- See **`CLAUDE.md` bullets (2c) and (2d)** for the full record.

---

## 🔑 Key selectors (captured live 2026-06-09 from the Spanish `/talent` UI)

| Thing | Selector |
|---|---|
| Keyword/boolean facet reveal | `button[aria-label="Añadir Palabras clave del perfil u operadores booleanos"]` |
| Keyword field (commit on `\n`) | `textarea[data-test-free-text-single-value-facet-textarea]` |
| Location facet reveal | `button[aria-label="Añadir ubicación del candidato"]` |
| Location typeahead input | `[data-test-facet-locations] input.ts-common-typeahead__input` |
| Location suggestion (top = select) | `li[data-live-test-result="0"]` (container `[data-test-typeahead-results]`) |
| Run search | `button[data-test-save-advanced-button]` |
| **Result card** | `[data-view-name^="talent-profile-list-element"]` |
| Candidate link in card | `a[href*="/talent/profile/"]` |
| **Save-to-project (per card)** | `button[data-test-action="save-to-project"]` (class `profile-item-actions__item`) |
| **Per-card checkbox (bulk select)** | `input.small-input` (the header/first one = "select all N") |
| **Pagination "Next"** (an `<a>`, NOT button) | `[data-test-pagination-next]` / `a[aria-label*="siguiente" i]` ("Ir a la página N siguiente") |
| Results count (top-left) | text like "146 resultados" (regex misreads "1 – 25" page indicator on huge sets — fine once focused) |

The **save dialog** that opens after clicking a save button is likely the SAME one
`recruiter-workflows/save-to-project.json` (workflow `4da44557…`) already drives from the *profile*
page: radio `label[for='choose-existing-projects']` → type project name into
`#save-to-projects-typeahead` → (2 no-op `scroll` delays for the async typeahead) → click the option
by exact project `text` → `button[data-test-action='save']`. **CAPTURE-FIRST to confirm** the
results-page dialog matches before relying on it (it may differ for the card/bulk entry).

---

## 🧩 The daemon extractor — current state + the PENDING fix (important)

The production scraper is **`extension/driver-daemon.mjs`**, function **`scrapeRecruiterSearch(page)`**
(strategy `recruiter_search_people`). CARD = `[data-view-name^="talent-profile-list-element"]`.
It returns `{ people, total_count }`.

- **It currently gets only ~6 of 25 on a page** because the live results list is lazy/virtualized and
  the pager "Next" is an `<a>` the old code didn't match.
- **A fix is already COMMITTED to the repo** (commit `56885fc` on branch `feat/recruiter-odoo-pipeline`):
  (a) scroll-until-the-card-count-stabilizes per page, and (b) the pager "Next" selector now matches
  `[data-test-pagination-next]` / `a[aria-label*="siguiente"]`, with `MAX_PAGES = 4`.
- **⚠️ The fix is NOT live yet.** The running daemon loaded the OLD code at its last restart. To
  activate it you must **sync `extension/driver-daemon.mjs` to the host `C:\Users\Public\extension`
  and RESTART the daemon** — which **kills the warm `/talent` seat** (see below) → needs a Fernanda
  re-login. So: **this fix is UNVERIFIED**; verifying/iterating the ~30-result extraction is the
  core of Part 1, and it requires a daemon restart + re-login.
- The scroll-to-stable loop may not fully handle a *truly* virtualized list (where off-screen cards
  are removed from the DOM). If 6→all doesn't work after the restart, switch to **scroll-and-collect**
  (extract at each scroll step, dedup by `/talent/profile/` URL) rather than one extract at the end.

---

## 🖥️ Environment & access

- **Backend (source of truth):** AWS, `https://52-5-45-84.sslip.io`. Gateway key (`X-API-Key`):
  `28e54ef83e040faa366260aa13af5f5b1947b364731e1f22`. (Repo is PUBLIC — this key is already exposed;
  rotating it is a known TODO. Don't add new secrets to git.)
- **Daemon (the scraper):** runs on **Fernanda's Windows host** as the S4U scheduled task
  `linkedin-bot-daemon`, `OPERATOR_ID=fernanda`, pointing at AWS. SSH over Tailscale:
  `ssh linkedin-bot@100.107.206.110` (the default shell is **cmd**; for PowerShell with pipes use
  `powershell -NoProfile -EncodedCommand <base64-UTF16LE>` to dodge quoting). Daemon code +
  snapshots live at `C:\Users\Public\extension`.
- **The `/talent` SEAT:** held by an open browser the daemon keeps alive. It **DIES on browser close**
  (i.e., on any daemon restart) — the `li_at` cookie survives so `/talent/home` still loads, but
  `/talent/search/*` walls to `/uas/login-cap`. Re-establishing the seat needs a **human, physical-screen
  login**: switch-user to `linkedin-bot` (pw `admin`) → double-click `login-talent.bat` on the Desktop
  → sign in to LinkedIn Talent → it closes on `/talent/`. Then start the daemon (S4U task, on-demand
  `schtasks /Run` works while `linkedin-bot` is logged on; its +30s keepalive ping grabs the warm seat).
  **The seat is currently WARM** (Fernanda logged in this session) — preserve it; only restart when you
  must ship daemon code, and coordinate the re-login first.
- **Anti-bot:** the daemon is UNCONDITIONALLY protected (stealth + human-like input + circuit breaker);
  the per-workflow `config.anti_bot` toggle is moot for daemon runs. NEVER drive Recruiter via the raw
  extension. Budget knobs in `daemon-task.ps1` (e.g. `MAX_SEARCHES_DAY=10`).
- **The `/talent` UI is in SPANISH** — prefer `data-test-*` / Spanish `aria-label` selectors.
- **Odoo (JD source):** local **morsoft** has rich dev JDs — `psql -h localhost -U odoo -d morsoft`
  (pw `odoopwd`); `hr_job.name`/`description` (jsonb or HTML), `ak_job_requirement.name` (plain text).
  The live pipeline uses qaodoo via the OdooAdapter.

### Recipes you'll re-create (the `/tmp` helpers from last session are gone)

```bash
KEY=28e54ef83e040faa366260aa13af5f5b1947b364731e1f22
B=https://52-5-45-84.sslip.io

# Create a workflow from a spec (pure AWS API; no daemon restart; keeps the seat warm):
SR_API_KEY=$KEY python3 scripts/create_recruiter_workflow.py spec.json   # prints WORKFLOW_ID=<uuid>

# Trigger a daemon run (snapshot per step → host):
curl -s -X POST "$B/v1/workflows/<WID>/run-with-params" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"execution_target":"daemon","operator_id":"fernanda","execution_options":{"use_profile":true,"snapshot":true},"runtime_params":{"boolean_query":"…","location":"Costa Rica"}}'
# → {"run_id":"…"}; poll GET /v1/runs/<run_id> (status; extracted_data[0].people / .total_count if extracting)

# Pull a step snapshot to analyze OFFLINE (never reload the live account to tune selectors):
scp linkedin-bot@100.107.206.110:'C:/Users/Public/extension/recruiter-snapshots/<run_id>/step-N-<action>.{html,png}' /tmp/
# files: step-<idx>-<navigate|click|type|scroll|extract>.{html,png,dom.json}

# Generate a boolean from an Odoo position:
cd backend && python3 ../scripts/boolean_from_odoo.py 231 --tightness 3   # uses backend/.env AI key
```

To **iterate a daemon code change** (the extractor): edit `extension/driver-daemon.mjs` → `scp` it to
`C:\Users\Public\extension\driver-daemon.mjs` → restart the S4U task (kill node + the session-0
powershell wrapper, then `schtasks /Run /TN linkedin-bot-daemon`) → **re-login the seat** (above).
Pure-workflow changes (navigate/click/type/existing strategy) need NO restart — prefer them.

---

## 📋 The task, step by step

### Part 1 — reliably collect ~30 results
1. Sync the committed extractor fix to the host + restart + re-login (coordinate the human login).
2. Run a focused search (a real Odoo boolean from the manifest + a location that yields >30, e.g. a
   broad one) with `snapshot:true` and the `recruiter_search_people` extract.
3. From `GET /v1/runs/<id>` read `extracted_data[0].people` (count) + `.total_count`; pull the
   results-page snapshots. Confirm it now gathers ~25/page (scroll-to-stable) AND advances pages
   (pagination) up to ~30, deduped by profile URL.
4. If still short, switch the extractor to **scroll-and-collect** (extract+dedup at each scroll
   position) and/or raise `MAX_PAGES`; re-ship + re-verify. Log any cap you impose (don't silently truncate).

### Part 2 — save from the results page
1. **Capture-first**: a read-only workflow that runs a small focused search, then on the results page
   clicks one card's `button[data-test-action="save-to-project"]` (or selects via `input.small-input`
   then the bulk-action bar `[data-test-profile-list-bulk-actions]`), and **snapshots** the dialog that
   opens. Pull the snapshot; lock the project-picker + confirm selectors (compare to `save-to-project.json`).
2. Build the save-from-results workflow (params: the project name + how many to save). For **per-card**:
   loop click save → pick project ("Easy Recruit") → confirm `button[data-test-action='save']`. For
   **bulk**: select N checkboxes → bulk "Guardar en proyecto" → pick project → confirm.
3. Verify by re-reading the **project pipeline count** (the daemon reports step success even on soft-miss,
   so confirm the save actually landed). Easy Recruit sandbox project id = `2051206850`.

---

## 🚧 Hard rules / gotchas
- **Sensitive account:** capture-first, deliberate runs only. Pull snapshots and tune selectors OFFLINE.
- **Spanish UI**; use stable `data-test-*` selectors. Free-text facets commit on **Enter**; typeaheads
  commit by **selecting a suggestion**; the daemon's generic `type` can send `\n` (Enter) but cannot
  blur or press other keys.
- **Don't break the seat** casually — a daemon restart costs a human re-login. Batch daemon-code changes.
- After backend changes, redeploy AWS (`./deploy/redeploy.sh`); never `docker compose down -v`.
- The booleans come **from Odoo positions** (the AI builder) — never hand-craft them.

## 📁 Files that matter
- `extension/driver-daemon.mjs` → `scrapeRecruiterSearch` (the extractor + the committed scroll/pagination fix).
- `recruiter-workflows/focused-boolean-location-search.json` (the working focused search).
- `recruiter-workflows/save-to-project.json` (the profile-page save flow — reuse the dialog selectors).
- `recruiter-workflows/odoo-position-booleans.json` (per-position booleans, "in place").
- `scripts/boolean_from_odoo.py` (generate booleans from Odoo) · `scripts/create_recruiter_workflow.py` (create workflows).
- `CLAUDE.md` bullets (2c) keyword facet + (2d) location facet & Odoo-driven booleans.
- `backend/services/recruiter_pipeline_service.py` (the live pipeline: build boolean → search → leads → saves).
