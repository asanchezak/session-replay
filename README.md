# Session Replay — AI Browser Workflow Runtime

Autonomous browser workflow platform: record once, replay with AI-driven parameter substitution, connector-backed data, and self-healing selectors.

---

## Services

| Service | Port | Start (dev) | Start (persistent) |
|---------|------|-------------|--------------------|
| Backend API | 8081 | `make dev-backend` | via `make all-services-install` |
| Frontend dashboard | 5173 | `make dev-frontend` | via `make all-services-install` |
| Both | — | `make dev` | — |
| LinkedIn driver daemon | — | `node extension/driver-daemon.mjs` | `make daemon-install` (launchd) |

Health check: `curl http://localhost:8081/v1/health`

---

## Quick start (fresh clone)

```bash
git clone <repo> && cd session-replay
make setup                 # backend + extension + frontend deps
make all-services-install  # daemon under launchd; backend + frontend in screen
make services-status       # verify everything's up
```

Then one-time, when you'll run real LinkedIn scrapes:

```bash
node extension/prepare-stealth-profile.mjs   # snapshot your Chrome profile
node extension/login-linkedin.mjs            # interactive LinkedIn login
```

After that, publishing a job in Odoo (with `linkedin_sync=True`) fires the
full pipeline: webhook → backend → daemon drives LinkedIn → applicants
land in Odoo with Easy Recruit AI scoring. Run `node extension/report.mjs <job_id>`
to see scores.

---

## Persistent services (launchd / screen / restart)

The daemon survives reboot via a launchd LaunchAgent. Backend + frontend stay
in `screen` sessions by default (a macOS Privacy & Security quirk — see
"Why backend + frontend aren't in launchd" below).

```bash
make all-services-install    # daemon (launchd) + backend + frontend (screen)
make all-services-uninstall  # stop everything (port 8081 + 5173 freed)
make all-services-restart    # bounce all 3

make services-status         # PID / exit code / port status for all 3
make services-logs           # tail -F all launchd logs

# Per-service ops
make daemon-install / daemon-uninstall / daemon-status / daemon-logs / daemon-restart
make backend-install / backend-uninstall      # launchd (needs FDA — see below)
make frontend-install / frontend-uninstall    # launchd (needs FDA — see below)
make dev-backend / dev-frontend                # screen-based (no FDA needed)
```

After editing the daemon code:
```bash
make daemon-restart
make daemon-logs   # confirm new code is running
```

After editing backend code (auto-reload is off in screen mode):
```bash
make all-services-uninstall && make all-services-install
```

### Why backend + frontend aren't in launchd

macOS 14+ blocks launchd-spawned processes from reading files in
`~/Documents/`, `~/Desktop/`, `~/Downloads/` unless the spawning binary has
**Full Disk Access** granted. If you cloned this repo into `~/Documents/`,
uvicorn + vite will EPERM-crash when launchd execs them. The driver-daemon
happens to work because `/opt/homebrew/bin/node` is often already FDA-granted
by another app's install.

To put backend + frontend under launchd too (so they auto-start at login like
the daemon), either:

1. **Grant Full Disk Access**: System Settings → Privacy & Security → Full
   Disk Access → add your python interpreter (`~/.local/share/uv/python/cpython-*/bin/python3`)
   and `frontend/node_modules/.bin/vite`. Then run `make all-services-launchd-install`.
2. **Move the repo out of `~/Documents/`** (e.g. to `~/Projects/`). Then run
   `make all-services-launchd-install`. No FDA needed.

The default `make all-services-install` skips this complexity by running
backend + frontend in `screen` sessions, which inherit your terminal's TCC
grants and Just Work.

---

## Environment setup

Copy `.env.example` to `.env` and fill in the required variables before starting:

```bash
cp .env.example .env
```

Key variables:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `API_KEY` | Shared secret for all API requests (`X-API-Key` header) |
| `AI_API_KEY` | Anthropic API key — required, AI must always be on |
| `VITE_API_URL` | Backend URL used by the frontend (default `/v1`) |

---

## Odoo → LinkedIn invite flow

This platform supports an automated recruitment flow: when a new position is published in Odoo, it triggers a LinkedIn messaging workflow that sends a personalised invitation to a target contact.

### How it works

1. Odoo fires a webhook to this platform when a job is published.
2. The platform resolves the workflow's connector binding (fetches job data, renders the message template).
3. A run is created and the LinkedIn workflow executes — the extension sends the message.

### ⚠️ Required: expose the backend via a public URL

The Odoo webhook cannot reach `localhost:8081` directly. **You must expose the backend with a public URL** before the flow will work.

**Development (ngrok):**

```bash
ngrok http 8081
```

Get the current URL:

```bash
curl -s http://localhost:4040/api/tunnels \
  | python3 -c "import sys,json; [print(t['public_url']) for t in json.load(sys.stdin)['tunnels'] if t['proto']=='https']"
```

**Configure Odoo** to POST to:

```
POST {your-public-url}/v1/webhooks/incoming/odoo/{connector_id}
Content-Type: application/json
X-API-Key: {API_KEY}
```

Expected payload from Odoo:

```json
{
  "event": "job.published",
  "job_id": 42,
  "name": "Senior Software Engineer",
  "department": "Engineering",
  "company": "AKUREY S.A.",
  "website_url": "/jobs/detail/senior-software-engineer-42",
  "apply_url": "https://akurey.com/careers/apply/?pId=42",
  "job_location": "global",
  "seniority_level": "senior",
  "employment_model": "full_time",
  "internal_area": "software"
}
```

> `description` is not required in the payload — the platform fetches it from Odoo automatically using `job_id`.

### Manual test (without waiting for Odoo)

From the workflow detail page, use the **Automation Triggers → Manual Test** section:
- Paste an Odoo position URL (optional override for the apply link)
- Select the connector
- Click **Trigger Now**

Or via API:

```bash
curl -X POST http://localhost:8081/v1/workflows/{workflow_id}/trigger-now \
  -H "X-API-Key: {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"connector_id": "{connector_id}", "job_url": "https://..."}'
```

### Template placeholders

The message template for the connector binding supports:

| Placeholder | Source |
|-------------|--------|
| `{job_title}` | Payload `name` field |
| `{job_description}` | Fetched from Odoo (full, HTML-stripped) |
| `{job_description_short}` | First paragraph, max 300 chars |
| `{job_url}` | `apply_url` → `website_url` (made absolute) → Odoo admin URL |
| `{department}` | Payload field |
| `{company}` | Payload field |
| `{job_location}` | Payload field |
| `{seniority_level}` | Payload field |
| `{employment_model}` | Payload field |
| `{internal_area}` | Payload field |

---

## Chrome extension

```bash
cd extension && npm run build
```

Load the unpacked extension from `extension/dist` in `chrome://extensions`.

Requires `extension/.env` with `VITE_API_BASE_URL` and `VITE_DASHBOARD_ORIGIN`.

---

## Running tests

```bash
# Backend unit + integration
cd backend && pytest

# Frontend
cd frontend && npm test

# E2E (requires running services + extension loaded)
cd frontend && npx playwright test
```
