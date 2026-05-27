# Next-iteration plan — recruitment automation polish

> **Read first**: `docs/recruitment-automation-flow.md` (the end-to-end runbook).
> This document picks up where that one ends — improvements to the flow's UX
> and architecture, in suggested execution order.
>
> **Format**: each task has *Goal*, *Why now*, *Options considered with rationale*,
> *Implementation outline*, *Acceptance criteria*, and *Pitfalls*. Designed so
> the next implementer (human or Claude) can execute without me.
>
> **Suggested order** (smallest blast radius first, dependencies respected):
> 1. Task A — Daemon health surface (independent, ~half day)
> 2. Task B — Odoo "LinkedIn sync stats" view (independent, ~1 day)
> 3. Task C — Generic schema-driven AI extractor in the daemon (refactor, ~1 day)
> 4. Task D — Collapse the AI-extraction duplication with Easy Recruit (~1 day)
>
> A + B can run in parallel. C must finish before D.

---

## Task A — Daemon health visible in the dashboard

### Goal
Operator opens the dashboard and immediately knows: is the driver-daemon up?
When did it last poll? Is it currently driving a run? If it's been down for
> 60s, show a red status pill at the top of every page.

### Why now
Today a dead daemon is silent failure. A user publishes a job, sees the run
appear in "running", and waits. After 10 min with nothing happening they don't
know whether (a) LinkedIn is slow, (b) the daemon is wedged, or (c) the
daemon is dead. This costs trust.

### Options considered

| Option | Pros | Cons |
|---|---|---|
| **A.1**: Daemon POSTs `/v1/daemon/heartbeat` every poll | Simple, explicit, scales to N daemons | Adds an endpoint + DB column (or in-memory) |
| A.2: Backend tails `~/Library/Logs/.../daemon.log` | Zero daemon changes | macOS-only, fragile, only works on same machine |
| A.3: Frontend checks a Postgres advisory lock | Zero new endpoints | Clever but opaque; requires DB connection from frontend |

**Recommendation: A.1.** It generalises cleanly to multi-machine fleets (each
worker reports in, dashboard shows them all). Trivial backend code.

### Implementation outline

**Backend** (`backend/api/v1/daemon.py` — new file):

```python
class DaemonHeartbeat(BaseModel):
    worker_id: str = "default"
    polling: bool = True
    driving_run_id: str | None = None

@router.post("/daemon/heartbeat")
async def heartbeat(req: DaemonHeartbeat, db: AsyncSession = Depends(get_db)):
    """Daemon pings every 5 s. Cached in-memory; survives backend restart
    by falling back to /v1/daemon/status returning down."""
    DAEMON_STATE[req.worker_id] = {
        "polling": req.polling,
        "driving_run_id": req.driving_run_id,
        "last_seen": datetime.now(UTC).isoformat(),
    }
    return {"ok": True}

@router.get("/daemon/status")
async def status():
    now = datetime.now(UTC)
    workers = []
    for wid, st in DAEMON_STATE.items():
        last = datetime.fromisoformat(st["last_seen"])
        age_s = (now - last).total_seconds()
        workers.append({**st, "worker_id": wid, "age_seconds": age_s,
                        "up": age_s < 30})
    return {"workers": workers, "any_up": any(w["up"] for w in workers)}
```

In-memory dict `DAEMON_STATE` is fine for single-process backend. If/when we
add multiple backend workers behind a load balancer, swap to Redis with a
30 s TTL.

**Daemon** (`extension/driver-daemon.mjs`):

In the poll loop, before each `findPendingRun`:
```js
await fetchJson(`${BACKEND}/v1/daemon/heartbeat`, {
    method: "POST",
    body: JSON.stringify({
        worker_id: process.env.WORKER_ID || os.hostname(),
        polling: true,
        driving_run_id: currentRunId || null,
    }),
});
```

Capture `currentRunId` from the `driveRun` invocation.

**Frontend** (`frontend/src/components/DaemonStatusPill.tsx` — new):

Polls `/v1/daemon/status` every 5 s. Renders one of:
- `🟢 Daemon up · idle` (any_up && no driving_run_id)
- `🟡 Daemon up · driving run abc12345…` (links to that run)
- `🔴 Daemon down — last seen 4 min ago` (red, prominent)

Mount in `AppShell.tsx` header, right of the title.

### Acceptance criteria
- [ ] `make daemon-restart` → dashboard pill goes 🟢 within 10 s
- [ ] `make daemon-uninstall` → pill goes 🔴 within 60 s (the heartbeat-TTL window)
- [ ] When a run is being driven, the pill shows 🟡 with a clickable run id
- [ ] Backend restart loses the in-memory state — first poll after restart
      shows down until the daemon's next heartbeat (acceptable)
- [ ] No alerts on the pill block other dashboard interactions (it's passive)

### Pitfalls
- Don't write a heartbeat on every step — only once per poll cycle (5 s).
  Heartbeat storms during a 12-step iteration would obscure the "is it
  alive?" signal.
- If multiple daemons run (future), worker_id collisions: pick `os.hostname() +
  process.pid`. Document.
- The dashboard's existing fetch infrastructure (`useApi` hook) handles the
  API key; reuse it, don't roll new fetch logic.

---

## Task B — Odoo "LinkedIn sync stats" view

### Goal
A recruiter in Odoo can see:
1. Per-job: how many LinkedIn candidates have been synced, and when was the
   last sync.
2. Globally (Recruitment → LinkedIn Integration menu): a summary of all
   syncs across all jobs — total candidates, completion rate, recent fires.

### Why now
Today the only visibility into "did the LinkedIn flow run for this job?" is
filtering `hr.applicant` by the "From LinkedIn" tag manually. Easy to miss,
no per-job context.

### Options considered

| Option | Pros | Cons |
|---|---|---|
| **B.1**: Smart-button on `hr.job` form + Recruitment menu item | Idiomatic Odoo UX, both views possible | Two changes |
| B.2: Just the menu item with kanban grouped by job | Simpler | No context on the job form |
| B.3: Tag-filter shortcut on the existing applicant kanban | Lowest effort | Already exists implicitly; no real new value |

**Recommendation: B.1.** Recruiters spend most of their time on the job
form — that's where the count belongs. The menu view is for ops / leadership
who want cross-job aggregates.

### Implementation outline

Three small additions in `akodoo/akcr/`:

**1. Computed field + smart-button on `hr.job`** (`models/hr_job.py`):

```python
linkedin_applicant_count = fields.Integer(
    string="LinkedIn Candidates",
    compute='_compute_linkedin_applicant_count',
)
last_linkedin_sync_date = fields.Datetime(
    string="Last LinkedIn Sync",
    compute='_compute_linkedin_applicant_count',
)

@api.depends('applicant_ids', 'applicant_ids.linkedin')
def _compute_linkedin_applicant_count(self):
    for rec in self:
        linkedin_apps = rec.applicant_ids.filtered(
            lambda a: a.linkedin and 'linkedin.com/in/' in a.linkedin
        )
        rec.linkedin_applicant_count = len(linkedin_apps)
        rec.last_linkedin_sync_date = max(linkedin_apps.mapped('create_date'),
                                          default=False)

def action_view_linkedin_applicants(self):
    return {
        'type': 'ir.actions.act_window',
        'name': _('LinkedIn-sourced candidates'),
        'res_model': 'hr.applicant',
        'view_mode': 'kanban,tree,form',
        'domain': [('job_id', '=', self.id),
                   ('linkedin', 'ilike', 'linkedin.com/in/')],
        'context': {'default_job_id': self.id},
    }
```

**2. Smart-button + Easy-Recruit summary tab on the form view**
(`views/hr_job_views.xml` — extend, don't replace):

```xml
<record id="view_hr_job_form_linkedin_stats" model="ir.ui.view">
    <field name="model">hr.job</field>
    <field name="inherit_id" ref="hr_recruitment.hr_job_survey"/>
    <field name="arch" type="xml">
        <xpath expr="//div[@name='button_box']" position="inside">
            <button name="action_view_linkedin_applicants" type="object"
                    class="oe_stat_button" icon="fa-linkedin">
                <field name="linkedin_applicant_count" widget="statinfo"
                       string="LinkedIn"/>
            </button>
        </xpath>
        <xpath expr="//field[@name='linkedin_sync']" position="after">
            <field name="last_linkedin_sync_date" readonly="1"
                   attrs="{'invisible': [('linkedin_applicant_count', '=', 0)]}"/>
        </xpath>
    </field>
</record>
```

**3. Menu item + global summary view**
(`views/linkedin_sync_dashboard.xml` — new):

A kanban / pivot view on `hr.applicant` filtered to LinkedIn-sourced, grouped
by job, showing count + average score per job. Menu under
`Recruitment → Configuration → LinkedIn Sync` (or top-level if higher visibility
is wanted).

### Acceptance criteria
- [ ] Open any `hr.job` with prior LinkedIn syncs → smart-button shows count
- [ ] Click the smart-button → opens kanban of just LinkedIn applicants for
      that job
- [ ] After publishing a job and waiting for the daemon to finish: the count
      updates (the compute is reactive on `applicant_ids`, no manual refresh)
- [ ] Recruitment menu has a new "LinkedIn Sync" entry → kanban grouped by
      job, sortable by recency
- [ ] Translations work (the `_()` calls + view labels both en/es)

### Pitfalls
- `applicant_ids` on `hr.job` may not exist by default — check the standard
  Odoo `hr.recruitment` module. If missing, derive via a search instead of
  reverse-related-field.
- Don't compute on every read of `hr_job` — the `@api.depends` should fire
  only when applicants change. Verify there's no N+1 query problem with 100
  jobs.
- Smart-button icon `fa-linkedin` may not exist in all FontAwesome versions
  Odoo ships with — fallback to `fa-users` if not rendering.

---

## Task C — Generic schema-driven AI extractor

### Goal
The daemon's `aiExtractSection()` currently has hardcoded prompts + JSON
schemas per LinkedIn section (`education`, `skills`, `certifications`,
`projects`, `courses`). Replace this with a generic extractor driven by the
workflow's existing `extract_shapes` declarations, so the same extractor
works for any future workflow on any site without code changes.

### Why now
Two reasons:
1. **It enables reuse**: when we add a workflow for X-Twitter profiles or
   GitHub repos, the daemon should "just work" without bespoke prompt
   engineering.
2. **It cleanly precedes Task D**: a generic extractor is the natural place
   to also decide "do we extract structure here, or pass raw text to Odoo for
   Easy Recruit to extract?". Without the refactor, that decision is tangled
   in per-section hardcoded logic.

### Options considered

| Option | Pros | Cons |
|---|---|---|
| **C.1**: Refactor `aiExtractSection` to generate schema+prompt from `extract_shapes` | Surgical, reuses existing data model | Loses fine-grained per-section instructions (e.g. "skip filter tabs") |
| C.2: Same but with optional `extract_hints` field on each shape | Recovers fine-grained guidance | Requires schema additions in `core/models/analysis.py` + a migration |
| C.3: Move the extraction to backend (run after raw text arrives) | Centralises AI calls, easier observability | Bigger change, affects extraction event format, dashboard rendering |

**Recommendation: C.2.** Add an optional `extract_hints` string field to the
shape definitions. The daemon's generic extractor reads it and appends to
the prompt. Defaults to empty (so most shapes work without hints). The
"skip filter tabs" / "exclude company-context" guidance becomes data, not
code.

### Implementation outline

**1. Add `extract_hints` to the shape schema** — no migration needed if we
store shapes as JSON inside `WorkflowStep.methods`. Update the seeder
(`scripts/seed_linkedin_people_search.py`):

```python
PROFILE_EXTRACT_SHAPES = [
    {"key": "skills", "label": "Skills", "kind": "string_list",
     "extract_hints": "Skip filter tabs ('All', 'Industry Knowledge', "
                       "'Tools & Technologies', 'Languages', 'Other Skills'). "
                       "Skip company/job-title context that follows each skill."},
    {"key": "education", "label": "Education", "kind": "record_list",
     "item_keys": ["school", "degree", "field", "dates"],
     "extract_hints": "Copy values verbatim. School is the institution; "
                      "degree is the type (e.g. 'Bachelor of Science')."},
    # ... etc
]
```

**2. Refactor the daemon** (`extension/driver-daemon.mjs`):

```js
// Replaces AI_SCHEMAS + AI_PROMPTS hardcoded dicts.
function shapeToSchema(shape) {
    if (shape.kind === "scalar") return { type: "string" };
    if (shape.kind === "string_list") return { type: "array", items: { type: "string" } };
    if (shape.kind === "record_list") {
        const props = {};
        for (const k of shape.item_keys) props[k] = { type: "string" };
        return { type: "array", items: {
            type: "object", additionalProperties: false,
            properties: props, required: shape.item_keys,
        }};
    }
    throw new Error(`unknown shape.kind: ${shape.kind}`);
}

function shapeToPrompt(shape) {
    const desc = {
        scalar: `Extract "${shape.label}" as a single string. Copy verbatim.`,
        string_list: `Extract "${shape.label}" as a list of short phrases — one per item.`,
        record_list: `Extract "${shape.label}" as a list of objects. Fields per object: ${(shape.item_keys || []).join(", ")}. Copy values verbatim; empty string when a field is not present.`,
    }[shape.kind];
    return shape.extract_hints ? `${desc}\n\n${shape.extract_hints}` : desc;
}

async function aiExtractByShape(shape, rawText) {
    const schema = {
        type: "object", additionalProperties: false,
        properties: { [shape.key]: shapeToSchema(shape) },
        required: [shape.key],
    };
    // ... rest mirrors current aiExtractSection but uses generated schema+prompt
}
```

**3. Drive from the workflow's shapes**: when scraping a profile, look up the
inner extract step's `methods` array, find the `extract_shapes` method, and
iterate its `shapes` list calling `aiExtractByShape` for each. Map each
section URL (`/details/education/`, etc.) by convention from `shape.key`
(e.g. `education` → `/details/education/`).

### Acceptance criteria
- [ ] `AI_SCHEMAS` and `AI_PROMPTS` dicts deleted from the daemon
- [ ] Per-profile extraction works identically to before (same fields, same
      quality) — verify with a manual run against a known-good profile (e.g.
      `node extension/live-linkedin-driver.mjs` for `Staff Software Engineer`,
      compare extracted_data JSON to the pre-refactor baseline)
- [ ] Adding a new shape `{key: "languages", label: "Languages", ...}` to the
      seed makes that section auto-extract on the next run, no daemon code
      changes
- [ ] `extract_hints` field is preserved through the seed → workflow_snapshot
      → daemon → AI prompt pipeline (assert by reading a run's snapshot)

### Pitfalls
- Section-URL convention (`shape.key → /details/<key>/`) only works for
  LinkedIn. For other sites the daemon already has per-step navigation
  encoded in workflow steps, so this mostly matters for the LinkedIn
  details-subpage walk. Document the convention; keep it simple.
- gpt-4o-mini sometimes hallucinates fields that look correct but aren't in
  the source text. Strict mode + "Copy values verbatim" reduces but doesn't
  eliminate. Spot-check the first few runs after the refactor.
- The schema generator must produce JSON Schema valid for OpenAI's strict
  mode (every property in `required`, `additionalProperties: false`). Don't
  trust the model to fix bad schemas — bad schemas hard-fail.

---

## Task D — Collapse the AI-extraction duplication with Easy Recruit

### Goal
Today, two systems extract structured data from a LinkedIn profile:
1. **Daemon** runs gpt-4o-mini on `/details/<section>/` text → produces
   structured `education`, `skills`, `certifications`, `projects`.
2. **Easy Recruit in Odoo** then runs 7 analysis agents on `about_you` that
   ALSO extract education, skills, experience, English level, etc.

Stop the duplication. Pick one place to extract, use it everywhere.

### Why now
- ~$0.003 per profile in wasted OpenAI calls (small but multiplies)
- Inconsistent results — daemon says skills=`[A, B, C]`, Easy Recruit re-
  extracts and finds `[A, B, D, E]` from the same dossier. Whose is right?
- Cognitive load: when debugging "why does Marco have skill X but not Y", a
  dev has to trace through TWO extraction paths.

### Options considered

| Option | Pros | Cons |
|---|---|---|
| **D.1**: Daemon is canonical. Easy Recruit's analyzer SKIPS the extraction agents and trusts the structured data already in the payload (passed alongside `about_you`). | Avoids the most expensive Odoo-side work. Single source. | Requires changes to `easy_recruit_analyzer.py` to accept pre-extracted fields. |
| D.2: Easy Recruit is canonical. Daemon strips its AI calls entirely, sends raw text. | Daemon becomes a dumb scraper. Easy Recruit retains its existing rich analysis. | Dashboard's extraction tab now shows just raw text (less useful for ops/debug). |
| D.3: Backend becomes canonical. Both daemon (no AI) and Easy Recruit (no AI extraction) just consume backend's structured data. | Most pure architecturally. | Two consumers, two refactors. Biggest blast radius. |

**Recommendation: D.1.** Daemon extraction stays (Task C made it clean +
generic), Easy Recruit drops the redundant extraction agents and uses what
the daemon already sent. Reasoning:
- Daemon already does the work; the data is already in `extracted_data` and
  in the akcr controller's payload.
- Easy Recruit's VALUABLE agents (job_fit scoring, recommendation, English
  level inference, specialization) STAY — those require AI judgment, not
  just extraction.
- Dashboard continues to show rich structured data (Task A health pill,
  Task B sync stats both depend on this being visible).

### Implementation outline

**1. Extend the controller payload** (`akcr/controllers/linkedin_applicant_controller.py`):

Receive `pre_extracted` blob alongside the existing free-text dossier fields.
Store on the `concierge.easy.recruit.profile` record so the analyzer can pick
it up:

```python
profile = EasyRecruitProfile.create({
    'model': 'hr.applicant',
    'model_reference_id': applicant.id,
    'corpus_request': corpus,
    'pre_extracted': json.dumps({
        'skills': payload.get('skills') or [],
        'education': payload.get('education') or [],
        'certifications': payload.get('certifications') or [],
        'experience': payload.get('experience') or [],
        'projects': payload.get('projects') or [],
        'courses': payload.get('courses') or [],
    }),
})
```

**2. Add `pre_extracted` field on the profile model**
(`akcr/models/concierge/easy_recruit_profile.py`):

```python
pre_extracted = fields.Text(help="JSON of structured fields already extracted "
                                  "by the upstream scraper. When present, "
                                  "the analyzer skips its own extraction agents.")
```

**3. Branch the analyzer** (`akcr/models/concierge/easy_recruit_analyzer.py`):

```python
async def run_analyze_agents(corpus, name, profile_id, api_key,
                              skill_catalog="", job_corpus="",
                              pre_extracted=None):
    """If pre_extracted is provided, skip the extraction agents and use it
    directly. Always run the scoring agents (job_fit, recommendation,
    review, English level, specialization)."""
    if pre_extracted:
        extracted = pre_extracted
    else:
        # current behaviour — run the 6 extraction agents
        extracted = await _run_extraction_agents(corpus, ...)

    # Always run analysis agents on top of the extracted data
    fit = await run_job_fit_agent(corpus, extracted, job_corpus, api_key)
    recommendation = await run_recommendation_agent(extracted, ...)
    # ...
    return {...}
```

**4. Backend sends `pre_extracted`** in `linkedin_applicant_push_service.py`
already does — the structured `skills`, `education`, etc. fields are in the
POST body. Just confirm they're forwarded properly to the new payload key.

### Acceptance criteria
- [ ] Re-run a known-good test (e.g. `Project Manager` with `candidate_count=3`)
- [ ] Verify in `concierge_easy_recruit_profile.results` that the `skills`,
      `education` etc. now match what's in the run's `extracted_data` exactly
      (within ordering)
- [ ] Token usage in OpenAI dashboard drops by ~40 % per applicant (the
      extraction agents being skipped)
- [ ] `job_fit_score`, `recommendation`, `english`, `specialization` are
      still produced correctly (analysis agents unaffected)
- [ ] Manually-uploaded CV applicants (no `pre_extracted`) still get the
      full pipeline — extraction agents run as before. Verify with one CV
      upload through Odoo's UI.

### Pitfalls
- The daemon's structured output may not match Easy Recruit's expected shape
  exactly (e.g. skill names with vs without proficiency levels). Add a
  `_normalize_pre_extracted(...)` step in the analyzer that maps the
  daemon's shape to whatever the scoring agents expect.
- Test the CV-upload path explicitly — easy to accidentally break it.
- Easy Recruit's "review agent" validates the extraction. With
  `pre_extracted`, what does it validate against? Two options: skip it, or
  re-run it against the dossier to flag hallucinations from the daemon's
  extraction. Pick one consciously.

---

## Sequencing rationale (the "sequential thinking" the user asked for)

**Why A first**: highest user-felt impact per line of code. Once the pill is
visible on the dashboard, any other work landing on the daemon is observable.
Future tasks depend on being able to tell "is the daemon healthy with my new
code?" — having the indicator already makes them easier.

**Why B second** (and parallel-able with A): independent codebase (Odoo),
self-contained, doesn't touch session-replay at all. Two team members could
do A + B in parallel without conflict.

**Why C before D**: D depends on knowing what structured data the daemon
sends. Making that data shape declarative (via shapes + hints) means D's
contract is "Easy Recruit receives the data per shape definition" — clean.
If D went first, we'd hardcode an integration around the current LinkedIn-
specific extraction, and Task C would later require redoing it.

**Why D last**: it touches three repos (session-replay backend, akcr models,
akcr analyzer) and one external system (OpenAI billing impact). Highest
coordination cost. By the time we get here, A + B prove the operational
loop works (so we can verify D didn't break it), and C has made the
daemon's contract clean (so D has a clear interface).

---

## Out of scope (intentionally)

These are real improvements but separate from this iteration:

- **"Approve before create" review gate** — meaningful product change, needs
  product input first
- **Extension polling** to replace the daemon entirely — biggest scope; do
  after C/D land so the extension's polling-driven extractor inherits the
  generic, schema-driven design from day one
- **Multi-recruiter daemon fleet** — only matters if usage scales beyond one
  Mac
- **Retry-on-failure for push to Odoo** — small, real, but unrelated to
  these four
- **Fix the `hr_applicant.job_fit_score` 0-10 vs 0-100 mismatch** — pre-
  existing Odoo bug, separate from this work

---

## Definition of done for this iteration

All four tasks shipped + verified by running a fresh end-to-end test as
described in `docs/recruitment-automation-flow.md` §5, with the daemon pill
🟢, the Odoo job form showing the updated sync count, and the OpenAI token
usage per applicant ≤ 60 % of the pre-refactor baseline.
