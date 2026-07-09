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
- **Pre-flight — check the seat is warm:**
  - **PREFERRED (free, no run, never touches the account):** `GET /v1/daemon/status` →
    the `fernanda` worker's `seat_warm` (`true`=warm, `false`=walled, `null`=unknown/keepalive
    off) + `seat_checked_at`. The daemon's keepalive computes this every ~2-3 min and now
    reports it in its heartbeat. The dashboard `DaemonStatusPill` shows "Seat walled · re-login"
    when it's false.
  - **Active probe (only when you need a live check):** run workflow `7246989f` "Open Talent
    Home" (read-only) on `fernanda`. As of 2026-07-07 it asserts warmth via a
    `recruiter_hot_reload_probe` step, so `completed` = warm and **`failed` = walled** (the
    daemon's `assertNoBlocker` trips on `/uas/login-cap`). ⚠️ Do NOT trust the OLD behavior:
    before this fix the run `completed` even on the login wall (its step-shot was a 27 KB
    `login-cap` page vs ~1.86 MB for a warm home) — a false "warm".

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

## Reply-scanner v2 — reads reply text + AI intent classification (2026-07-07)

The inbox reply-scanner (hot module `extension/runtime-strategies/daemon-behavior.mjs`,
`scanInboxReplies`) now reads the reply TEXT of candidates we messaged and the backend
AI-classifies each reply into `interested` / `not_interested` / `maybe_later` / `unclear`
(one batched OpenAI call, `backend/services/reply_intent_service.py`); the category +
raw body land on the Odoo `linkedin.lead` (`reply_category` badge, inbound
`linkedin.lead.message.ai_category`, akcr `/akcr/api/lead_replied` v2).

- **Watchlist-gated thread opens.** Before scanning, the daemon GETs
  `GET /v1/recruiter/reply-watchlist` (backend → akcr `POST /akcr/api/lead_watchlist`):
  leads with `outreach_status in (messaged, responded)` and no pending removal. Only
  UNREAD conversations whose participant name (diacritic/case-insensitive) matches the
  watchlist are OPENED — max `THREAD_OPEN_BUDGET`=5 per scan — by a humanized click on
  `a[data-test-conversation-card]` inside the matching
  `[data-test-conversation-card-container][data-test-conversation-urn=…]`. A classified
  `not_interested` (or manual `rejected`) flips `outreach_status` → the lead leaves the
  watchlist domain → that person's thread is never opened again. Non-watchlist unread
  cards are reported NAME-ONLY exactly as v1 (never opened). Watchlist fetch failure ⇒
  the whole scan degrades to v1 (name-only, zero opens).
- **Message body selector** (pinned from a live DOM capture 2026-07-07):
  `[data-test-rich-message-body]` inside each `[data-test-message-list-item]`
  (`innerText`; `<br>` → newlines). Consecutive messages from one sender only carry
  `[data-test-message-sender-name]` on the FIRST → effective senders are carried forward,
  then the TRAILING consecutive inbound run (sender ≠ "Benavides") is joined with `\n` as
  the reply body (`readOpenThreadReply`). The auto-opened thread's body is captured for
  free (no click).
- **Read-receipt tradeoff (accepted, user-confirmed):** opening a thread marks it read
  (candidate sees "seen"; Fernanda loses that unread dot). Only watchlist candidates,
  ≤5/scan; the recruiter's reply queue lives in Odoo (full text + category) from here on.
- **Offline-queue property:** replies stay UNREAD on LinkedIn while the host is off;
  `lastReplyScanAt` resets on boot/hot-reload → the FIRST warm tick after recovery scans
  and drains everything. The scan only runs on a warm seat.
- **Second-reply support:** akcr dedups inbound messages by exact normalized body (not
  "any inbound exists"), so a `maybe_later` candidate replying again later is recorded and
  re-classified. `conversation_urn` is stored on the lead at first match and used FIRST for
  matching (pins duplicate names).
- **AI failure ⇒ `unclear`** (never blocks the push; the lead still flips `responded`).
  Gotcha fixed on the way: `ai/client.py` `generate()` crashed on valid JSON-ARRAY
  responses (confidence auto-parse assumed a dict).
- **Verify:** simulated —
  `curl -X POST $BACKEND/v1/recruiter/inbox-replies -H "X-API-Key: …" -d '{"replies":[{"name":"…","body":"…"}]}'`
  → response `classified: N`; watchlist — `curl $BACKEND/v1/recruiter/reply-watchlist`.
  Known caveat: reply-scan targets ENDPOINTS[0] (DEV→qaodoo) only; candidates messaged
  from PROD/morsoft campaigns come back `lead_not_found` on qaodoo.
