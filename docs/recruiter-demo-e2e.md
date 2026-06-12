# LinkedIn Recruiter — Demo end-to-end runbook

**Trigger:** when the user says *"corre el test de linkedin para el demo"*, run
`scripts/demo_e2e.sh` (defaults are SAFE — preview only, no real InMail, no archive).

This drives the **LinkedIn + session-replay** side directly so the demo works today. The
**Odoo-side** template field + "Mandar mensaje" wizard need the qaodoo `-u akcr` upgrade
(PR #1818, merged to the `qaodoo` branch → an operator runs the Jenkins job). Everything
else is already deployed + live-verified.

## What the demo shows (4 phases)

| Phase | What | How | Verify |
|---|---|---|---|
| 0 Pre-flight | Warm `/talent` seat | wf `7246989f` on fernanda | `completed` |
| 1 Reset to only Andrey | Archive ALL in the project + add Andrey + reset Odoo leads to Andrey | wf `511ceaab` + `f003f090` + `scripts/demo_odoo_reset_add_andrey.py` | project active=1, Odoo leads=1 |
| 2 Verify | Project counts | wf `b5e3d433` (read-only) | active=1 (Andrey) |
| 3 Message | Templated bulk InMail with the `{firstName}` chip — **preview** (default) or **send** | `POST /v1/recruiter/jobs/{id}/send-messages {body,subject,send}` → wf `c46c296f` | recipient = Andrey only; on send → Odoo `outreach_status=messaged` |
| 4 Archive (opt) | Archive the whole project | wf `752753a9` | gone from active projects |

## How to run

```bash
# SAFE default: reset to Andrey + verify + PREVIEW the message (no real send, no archive)
bash scripts/demo_e2e.sh

# Also send the REAL InMail to Andrey + verify Odoo status flips to "messaged"
SEND=1 bash scripts/demo_e2e.sh

# Full run incl. archiving the project at the end
SEND=1 ARCHIVE=1 bash scripts/demo_e2e.sh

# Operate on the current project state (skip the reset)
SKIP_RESET=1 bash scripts/demo_e2e.sh
```

Overridable env: `JOB_ID` (323), `PROJECT_URL`, `PROJECT_NAME`, `PROFILE_URL`
(`/in/crandrey/`), `MSG_SUBJECT`, `MSG_BODY`, `SR_BACKEND`, `SR_API_KEY`, `OPERATOR`.

The message step prints a `scp …/recruiter-snapshots/<runId>/step-2-extract.png` line —
pull it to show the composer (To: Andrey, subject, body with the `{firstName}` chip).

## Phase 1 prelude (optional — show the autonomous pipeline from Odoo)

To demo the *origin* (Odoo position → project + template + candidates), publish a fresh
qaodoo position BEFORE the steps above:
- Create an `hr.job` (XML-RPC `support@akurey.com`/`Akurey1234*`) with `name`,
  `department_id`, **`job_location`** (`cr`/`latam`/`global` — required or the form won't
  save), a real `description` (the JD), and `linkedin_sync=True` + `is_published=True`
  (akcr caps LinkedIn sync at 4 jobs — disable sync on stale ones first).
- The reconcile supervisor fires the pipeline → `-EZ <pos>` project + boolean search +
  ~30 `linkedin.lead` rows + the `recruiter_message_template` auto-fills on the job.
Then run `scripts/demo_e2e.sh` to reset that project to Andrey and message/archive.

## Live-verified (2026-06-11/12)
Phases 1 (prior sessions), 2, 3 (preview **and** real send → Odoo `messaged`), 4 — all
verified on job 323 / project `2057213706` / Andrey. Workflow ids are in `.env.prod` on the
box + this doc. See `CLAUDE.md` ("Per-position message TEMPLATE …") and the memory
`project_recruiter_archive_candidate` for the selectors + gotchas.
