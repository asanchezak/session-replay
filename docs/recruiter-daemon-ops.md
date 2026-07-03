# Recruiter daemon operations

How to drive the `/talent` surface with the daemon: session setup, running tests,
restart gotchas, session backup/restore.

## Pre-flight checklist — READ before EVERY test

- **Anti-bot is UNCONDITIONAL on daemon runs.** The `config.anti_bot` toggle is
  extension-only and moot here. Every daemon run applies fingerprint stealth +
  circuit breaker + budget + bezier mouse/human typing, and **deliberately ignores**
  the per-workflow toggle (`driver-daemon.mjs` ~1353). There is **no toggle to flip**.
  Only extension/dashboard-driven runs honor it (turn it ON there).
- **NEVER run recruiter tests via the raw extension / bypassing the daemon** — that's
  the only way to lose anti-bot protection.
- **Pre-flight:** confirm warm `/talent` seat first: run workflow `7246989f`
  "Open Talent Home" (read-only) on `fernanda`; `completed` = warm,
  `waiting_for_user` = walled → re-login needed.

## Driving Recruiter with the daemon — proven 2026-06-05

Live-proven: run `e24a66e1` of workflow `7246989f-a6ce-4b8a-b7f4-16a49d930cae`
→ daemon navigated to the REAL `/talent/home` (title "LinkedIn Talent Solutions",
116 interactive els, 1.86 MB HTML), `completed`, no wall, no circuit trip.

**Daemon opt-in to the profile:** a generic run uses an EPHEMERAL context by default;
pass `execution_options.use_profile: true` so it uses `.linkedin-profile` (the Recruiter
session).

**Per-step DOM snapshots:** pass `execution_options.snapshot: true` → each step writes
full HTML + DOM inventory + screenshot to `extension/recruiter-snapshots/<runId>/`.
Pull with `scp` and analyze **offline** — never reload the live account to tune selectors.
Offline harness: `node extension/analyze-snapshot.mjs <snapshot.html> [--sel "css"] [--grep text]`.

**Trigger a daemon Recruiter run:**
```
curl -s -X POST https://52-5-45-84.sslip.io/v1/workflows/<id>/run-with-params \
  -H 'X-API-Key: <gateway-key>' -H 'Content-Type: application/json' \
  -d '{"execution_target":"daemon","operator_id":"fernanda",
       "execution_options":{"use_profile":true,"snapshot":true},"runtime_params":{}}'
```

New workflows via `POST /v1/workflows` default to `execution_mode=generic`.

**Per-step wait-for-selector + screenshots — FIXED 2026-06-08 (live after 2026-06-09 restart).**
The daemon now (a) polls the PRIMARY recorded selector up to `STEP_RESOLVE_TIMEOUT_MS` (12s)
before a generic click/type via `resolveLocatorWithWait` — handles the async `/talent` SPA,
so the blind no-op `scroll` "delay" steps are no longer needed; and (b) uploads a dashboard
screenshot **per generic step** (after `STEP_SHOT_SETTLE_MS` settle). Code in
`extension/{driver-daemon.mjs,src/behavior/selector-resolve.mjs}` (commit `3eee01a`).

## The Recruiter SEAT — keepalive and session persistence

The seat is held by a **session-scoped cookie + open-SPA polling** — both lost when Chrome
closes. `li_at` survives, the seat doesn't. The daemon keeps ONE browser OPEN:
`getProfileContext()` opens `.linkedin-profile` ONCE; the keep-alive (`RECRUITER_KEEPALIVE=1`
in `daemon-task.ps1`) re-asserts `/talent/home` every 2-3 min and never closes it.
Watch `daemon.task.log` for sustained `[keepalive] /talent OK … warm`.

If it walls every few min DESPITE the open browser → contention (Fernanda using Recruiter in
parallel), not idle. See memory `project_recruiter_seat_keepalive`.

**Why the seat used to wall "overnight" (root-caused 2026-07-03):** the host laptop is
**powered off every night** (evening shutdowns ~17:15, sometimes a 03:15 Windows-Update
restart; boot ~08:08 — see the System event log, id 1074/6005). The shutdown kills the
daemon's Chrome, and the seat cookies are SESSION-scoped — our Playwright-launched profile
never wrote them to disk, so every boot started walled at `/uas/login-cap`. Fernanda's own
Chrome survives the same shutdown because a normal browser restores session cookies.
**Fix:** `persistSeatCookies` in `runtime-strategies/daemon-behavior.mjs` — after every warm
keepalive ping, the LinkedIn session cookies are re-written WITH a 7-day expiry so they
persist in the cookie DB and survive restarts (`login-talent.mjs` does the same right after
a successful sign-in). Local storage attribute only — nothing changes on the wire. Note:
the `session.restore_on_startup=1` Preferences approach does NOT work under
Playwright-launched Chrome (verified on throwaway profiles) — don't retry it.
Watch for `[keepalive] persisted N session cookie(s)` in `daemon.task.log`; after a nightly
shutdown the first morning ping should now be `OK — Recruiter seat warm`.

**Activation from a walled state (human-only):** the daemon must be DOWN during login
(its open browser holds the profile lock).
1. Physical screen → switch-user to `linkedin-bot`
2. Run `login-talent.bat`
3. Start the daemon — its +30s ping grabs the warm seat and holds it

**Session lives in `.linkedin-profile`** and persists. During S4U/login tasks keep the daemon
Disabled so it doesn't race for the profile. If `/talent` walls to `/uas/login-cap`,
re-establish with `login-talent.bat` as `linkedin-bot`.

**To see the daemon drive Talent in a VISIBLE browser:** the S4U daemon runs in session 0
(Chrome invisible). Run `run-daemon-visible.bat` on the `linkedin-bot` Desktop instead.
Stop/Disable the S4U task first so they don't race; re-enable after.

## Saving / restoring the session

Host scripts in `C:\Users\Public\extension\`:
- `backup-recruiter-session.ps1` → copies `.linkedin-profile` cookies + Local State to
  `.linkedin-profile-backup\<stamp>\` (+ `LATEST.txt`).
- `restore-recruiter-session.ps1 [-Stamp <stamp>]` → restores that cookie state (daemon
  must be Disabled / no Chrome on the profile). **DPAPI caveat:** restore only works on
  THIS host/user. If `/talent` still walls after restore, re-run `login-talent.bat`.

## Restarting the daemon task (finicky — read first)

Cost ~1h on 2026-06-05. `schtasks /End` orphans `node`; `taskkill /F /IM node.exe` then leaves
the **session-0 `powershell.exe` wrapper alive as a phantom**, and
`MultipleInstancesPolicy=IgnoreNew` makes every start request stick in "Queued".

**To restart:** kill BOTH `node.exe` AND the session-0 wrapper `powershell.exe`.

On-demand start of the S4U BootTrigger task only works at boot or while `linkedin-bot` is
interactively logged on — otherwise `schtasks /Run` / `Start-ScheduledTask` just QUEUE.

**Reliable starts:** reboot, or `run-daemon-visible.bat` in the interactive linkedin-bot session.

Daemon code path on the host: `C:\Users\Public\extension`, run by `daemon-task.ps1` via
`linkedin-bot-daemon` scheduled task. `findstr`/`where` over SSH need `cmd /c` or they
shell-mangle the path.
