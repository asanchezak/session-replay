# Kickoff prompt — Restart the Recruiter daemon + re-establish the /talent seat

> Self-contained operational guide for another AI. GOAL: restart the daemon on Fernanda's Windows
> host so it loads freshly-synced code, and re-establish the LinkedIn Recruiter `/talent` **seat**
> (which dies on the restart). This is the exact sequence that worked on 2026-06-09. After this
> succeeds, hand off to the task in `docs/PROMPT-next-ai-extract-save.md`.

---

## Why this is needed (read first)
- The **daemon** (the LinkedIn scraper) runs on **Fernanda's Windows host** as the S4U scheduled task
  `linkedin-bot-daemon` (`OPERATOR_ID=fernanda`), code at `C:\Users\Public\extension`. Restarting it
  loads whatever `driver-daemon.mjs` is currently on the host (e.g. a just-synced extractor fix).
- The Recruiter **`/talent` seat dies when the daemon's browser closes** (i.e. on ANY restart). The
  `li_at` cookie survives — so `/talent/home` still loads — but `/talent/search/*` walls to
  `/uas/login-cap`. The keepalive **cannot resurrect a dead seat**; only a fresh interactive Talent
  login (`login-talent.bat`) does. That login is **HUMAN-ONLY** (sensitive password, physical screen).
- So the restart has an **AI part** (SSH: stop → start → verify) and a **HUMAN part** (the login).
  Order matters: the daemon must be **DOWN during the login** (its open browser holds the profile lock).

## Access
- SSH: `ssh linkedin-bot@100.107.206.110` (Tailscale). **Default shell is cmd.** For PowerShell with
  pipes/filters use `powershell -NoProfile -EncodedCommand <base64-UTF16LE>` (cmd mangles quotes; and
  `findstr` is UTF-8-blind — use `Select-String`). To make the base64:
  `python3 -c "import base64,sys;print(base64.b64encode(sys.stdin.read().encode('utf-16-le')).decode())" <<<'<PS command>'`
- Backend (source of truth): `https://52-5-45-84.sslip.io`, header
  `X-API-Key: 28e54ef83e040faa366260aa13af5f5b1947b364731e1f22`.

## THE SEQUENCE

### 1) Stop the daemon (AI, via SSH) — release the profile lock
```
taskkill /F /IM node.exe
schtasks /Change /TN linkedin-bot-daemon /DISABLE      # so it can't race during the login
schtasks /End    /TN linkedin-bot-daemon
```
Then kill the **phantom session-0 powershell wrapper** (it keeps the task "Running" → the next start
QUEUES) and any **Chrome still holding `.linkedin-profile`** — via PowerShell (base64 it for SSH):
```
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*daemon-task*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe'      -and $_.CommandLine -like '*linkedin-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```
Confirm the task is idle: `schtasks /query /TN linkedin-bot-daemon /fo list` → state should be
**Deshabilitado/Listo**, NOT **En ejecución**.

### 2) Re-login the seat (HUMAN — physical screen, NOT Chrome Remote Desktop)
> CRD attaches to María's console session; the `linkedin-bot` switch-user must be at the PHYSICAL screen.
1. Switch-user to **`linkedin-bot`** (password `admin`).
2. Double-click **`login-talent.bat`** on the Desktop → visible Chrome opens on `.linkedin-profile` →
   **sign in to LinkedIn Talent/Recruiter** (the sensitive password) → solve any challenge → the window
   **closes itself** when it reaches `/talent/`.
3. **Stay logged in as `linkedin-bot`** until the daemon is confirmed up (the on-demand start needs it).

### 3) Start the daemon (AI, via SSH — works while linkedin-bot is logged on)
```
schtasks /Change /TN linkedin-bot-daemon /ENABLE
schtasks /Run    /TN linkedin-bot-daemon
schtasks /query  /TN linkedin-bot-daemon /fo list      # want "En ejecución" (Running)
```
If it shows **En cola/Queued** → `linkedin-bot` isn't logged on, or a phantom wrapper survived (redo
step 1's wrapper kill). The daemon opens its browser and its **+30s keepalive ping grabs the warm seat**
from the fresh cookies.

### 4) Verify (AI)
- **Daemon registered:** `GET /v1/daemon/status` → a `fernanda` worker, `up:true`, recent age, **new pid**
  (different from before).
- **Seat warm (the real check):** read the keepalive log (PowerShell, base64'd):
  `Get-Content C:\Users\Public\extension\daemon.task.log -Tail 40 | Select-String 'keepalive|warm|WALLED'`
  → want **`[keepalive] /talent OK — Recruiter seat warm (warm=true)`**. If you see
  **`/talent WALLED … needs a fresh login`** → the login didn't take; redo step 2.
- **Functional confirm:** trigger the read-only workflow `7246989f-a6ce-4b8a-b7f4-16a49d930cae`
  ("Open Talent Home"): `POST /v1/workflows/7246989f-.../run-with-params` with
  `{"execution_target":"daemon","operator_id":"fernanda","execution_options":{"use_profile":true,"snapshot":true},"runtime_params":{}}`
  → poll `GET /v1/runs/<id>`; must **complete** and land on `https://www.linkedin.com/talent/home`
  (NOT `/uas/login-cap`). "completed" alone ≠ warm — verify the landing URL (it's in the run / the snapshot).

## Gotchas
- Restarting is finicky: `schtasks /End` orphans node; the session-0 powershell wrapper lingers as a
  phantom and makes starts QUEUE (`MultipleInstancesPolicy=IgnoreNew`). Kill **both** node and the wrapper.
- On-demand S4U start only fires at boot or **while `linkedin-bot` is interactively logged on**.
- Never automate the Talent password — the login is human-only. The account is VERY sensitive.
- The seat persists in `.linkedin-profile` once the daemon holds it open; the human can lock/leave after
  step 4 confirms warm (the daemon runs in session 0, independent of the interactive session).

## After this
Daemon is up with the new code + a warm seat. Hand off to **`docs/PROMPT-next-ai-extract-save.md`**
(the task: collect ~30 results via scroll+pagination, then save-to-project from the results page).
