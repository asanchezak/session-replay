# LinkedIn anti-bot measures — source of truth

This is the living record of how the LinkedIn scraping pipeline avoids being
flagged as a bot, **why** each measure exists, and what's still open. Update it
whenever the anti-bot posture changes so the next session doesn't re-discover
this the hard way.

> **Incident (2026-05-28):** a LinkedIn account was flagged. Root-cause analysis
> found three problems, all fixed in the change documented here. See
> *Changelog* at the bottom.

---

## 1. Two execution paths — the daemon is production

There are **two** code paths that can drive LinkedIn, and they are different
runtimes. Keep their behavior in sync via the shared modules below.

| | Production scraper | Chrome extension |
|---|---|---|
| Entry | `extension/driver-daemon.mjs` (launchd LaunchAgent) | `extension/src/background/service-worker.ts` |
| Drives via | Playwright, real Chrome (`channel:"chrome"`), **directly** | MV3 + `chrome.debugger`/CDP, in the user's browser |
| Trusted clicks | `page.mouse.*` (already `isTrusted:true`) | needs CDP `dispatchMouseClick` |

**The 2026-05-28 flag happened because V2 anti-bot work (commits `371d96a`,
`597bec0`) was added only to the extension and never ported to the daemon.** The
daemon was still doing mechanical, fixed-order deep-links. It now has parity.

### Shared modules (single source of truth — both runtimes import these)
- `extension/src/shared/stealth.mjs` — the minimal `STEALTH_INIT` (fingerprint).
- `extension/src/behavior/stealth-core.mjs` — pure math: `bezierPath`,
  `mulberry32`, `pickDwellMs`, `shuffleInPlace`, `cryptoRandom`,
  `LINKEDIN_DETAIL_SECTIONS`.
- `extension/src/behavior/page-nav.mjs` — `createPageNav()`: bezier mouse,
  "Show all" trusted clicks, seeded scroll, Show-all section discovery (daemon).
- `extension/src/behavior/blocker-detect.mjs` — `detectChallengeInPage`,
  `isBlockerUrl` (daemon wall detection).
- `extension/src/behavior/account-state.mjs` — `createAccountStateStore()`:
  per-account budget + circuit breaker + working hours.

---

## 2. Fingerprint posture — spoof ONLY what automation breaks

**Principle:** we run the *real* Chrome binary on the *real* M1 Mac against a
*real* aged profile. The native fingerprint is already a perfect, internally
consistent human. Every value we hardcode replaces a correct native value with a
guessed one and risks a cross-checkable contradiction.

`STEALTH_INIT` (`src/shared/stealth.mjs`) patches **only**:
1. `navigator.webdriver → undefined` (the one thing Playwright flips to `true`).
2. `navigator.permissions.query` notifications → `"default"`.
3. `Function.prototype.toString` proxy so the one patched fn reports `[native code]`.

**Deliberately NOT spoofed** (left native — this is the fix, not an omission):
- **WebGL renderer/vendor** — the old code forced `"Intel Iris OpenGL Engine"` /
  `"Intel Inc."` on an Apple-Silicon Mac. The real value is
  `ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, …)` / `Google Inc. (Apple)`.
  A Mac UA + Intel GPU is a trivial contradiction — **worse than no spoof**.
- `hardwareConcurrency` (real M1 Pro = 10, was faked to 8), `deviceMemory`
  (natively absent on Mac Chrome, was faked to 8), `navigator.languages`,
  `navigator.plugins`/`mimeTypes`, `window.chrome.runtime`,
  `Notification.permission`.
- **User-Agent / Sec-CH-UA** — never overridden (a manual UA without matching
  Client Hints is itself a contradiction).

Verified headed on this machine: renderer = `ANGLE (Apple, … Apple M1 Pro …)`,
cores = 10, deviceMemory absent, webdriver undefined.

**Rule for future edits:** never hardcode GPU / CPU / memory / locale. This is a
real M1 — let Chrome report native. If you must run on a different machine, the
values must match *that* machine.

---

## 3. Behavioral posture — look human, keep full extraction

Per product decision, **full per-profile extraction is preserved** — we visit
every requested section for every profile. We only humanize *how*:

- **Click "Show all", don't deep-link.** `getShowAllSections` finds which
  `/details/<section>/` pages have an in-page "Show all" anchor; we travel the
  cursor along a bezier path and do a trusted click (`clickSectionLink`).
  Sections without an anchor (inline content) fall back to `page.goto` so no
  data is lost.
- **Single visit per section.** Old code `goto`'d each subpage 2–3× (once per
  extraction helper). Now each section is visited once and both the structured
  items and raw text are read from that one page.
- **Shuffled section order** (`shuffleInPlace`, seeded per profile) — no fixed
  experience→education→skills sequence.
- **Seeded, varied cadence** — scroll counts (`humanScrollSeeded`), dwell times
  (`pickDwellMs`, beta-skewed 3–10s/section), per-profile RNG seeded from the
  URL ⊕ wall-clock (so the same profile isn't replayed identically).
- **Humanized opening** — feed warm-up, then search page 2 reached by clicking
  the "Next" pagination control (goto fallback), not `?page=2` deep-link.
- **Noise navigations** — the daemon honors the backend's noise contract
  (`_noise_kind` / `_noise_seed` / `delay_before_ms` from `expand_for_each`):
  `search_bounce` / `feed_scroll` / `profile_hover` / `idle_scroll`.

---

## 4. Operational posture — throttle over time, pause when warned

State lives in `extension/.linkedin-budget.json` (gitignored), keyed by the
Chrome profile dir. Logic in `account-state.mjs`.

- **Mid-run blocker detection on EVERY navigation.** `safeGoto` wraps all
  navigation: page-load count → URL check (`isBlockerUrl`) → DOM probe
  (`detectChallengeInPage`: captcha / login_form / two_factor). On a wall it
  throws `BlockerError`; the daemon **pauses the run (cursor NOT advanced)** and
  trips the circuit breaker. (Previously it logged the error, marked the step a
  success, and kept clicking around inside the wall — the worst signal.)
- **Circuit breaker** (account-wide, persisted). Hard ladder 4h→12h→24h→48h;
  soft ladder 1h→4h; resets after 24h clean. While open, the poll loop skips
  driving and heartbeats `circuit_open`.
- **Daily/hourly budget** (env-tunable; defaults ~80 profile views/day, ~18/hr,
  ~30 searches/day, ~500 page loads/day). On exhaustion the run **pauses to
  resume next window** — never drops candidates.
- **Working hours** (default Mon–Fri 08:00–19:00 local) + **inter-run cooldown**
  (default 20–40 min jitter). No back-to-back runs; nothing at 3am.
- **Volume clamp** — webhook `candidate_count` clamped to ≤ 8 (was 25).

### Env knobs (daemon)
`MAX_PROFILE_VIEWS_DAY`, `MAX_PROFILE_VIEWS_HOUR`, `MAX_SEARCHES_DAY`,
`MAX_PAGE_LOADS_DAY`, `WORK_START_HOUR`, `WORK_END_HOUR`, `WORK_DAYS`,
`RESPECT_WORKING_HOURS` (set `0` to disable), `BASE_COOLDOWN_MS`,
`COOLDOWN_JITTER_MS`.

### `.linkedin-budget.json` shape
```json
{
  "account_id": "<basename of profile dir>",
  "windows": { "2026-05-28": { "profile_views": 3, "searches": 1, "page_loads": 22 },
               "hour:2026-05-28T14": { "profile_views": 2, "page_loads": 14 } },
  "circuit": { "state": "closed", "open_until": 0, "consecutive_trips": 0,
               "last_trip_at": 0, "last_trip_kind": null }
}
```
To force the daemon to resume after a manual fix, delete this file (or set
`circuit.state="closed"`, `open_until:0`).

---

## 5. Tests

- `extension/tests/test_stealth_core.test.ts` — pure behavior math (vitest).
- `extension/tests/test_account_state.test.ts` — budget windows, circuit ladder,
  working hours, persistence (vitest, injected clock).
- `extension/e2e/stealth-coverage.spec.ts` — fingerprint consistency; asserts no
  Intel-on-Apple lie, native Apple GPU when headed.
- `extension/e2e/blocker-detect.spec.ts` — wall detection on fixture pages.
- `extension/e2e/section-navigation.spec.ts` — proves a TRUSTED "Show all" click
  (not a deep-link), full-section coverage, seed-varied order.

Run: `cd extension && npx vitest run && npx playwright test e2e/stealth-coverage.spec.ts e2e/blocker-detect.spec.ts e2e/section-navigation.spec.ts`.

---

## 6. Known weaknesses & next ideas (backlog)

- **IP / ASN reputation is not addressed in code.** A perfect browser
  fingerprint from a datacenter/VPN IP is still a strong flag. Run from a
  residential IP, geo-consistent with the account's locale/timezone, stable per
  account. This is likely the next biggest lever.
- **No soft-rate-limit detection yet** beyond the wall types. LinkedIn often
  degrades (empty results, silent redirect to `/feed/`) before a hard wall —
  `safeGoto` has the hooks but the soft-signal classification is minimal.
- **Single account / single profile dir.** Multi-account rotation is *not*
  recommended as a remedy (it tends to get more accounts flagged, especially
  from the same IP/device). If ever added, model "account" as profile dir + its
  own IP + its own `.linkedin-budget.json`; the sidecar design is already
  per-account-keyed.
- **`unexpected_modal` not treated as a hard blocker** by the daemon (the
  extension does). Intentional — LinkedIn shows benign modals — but worth
  revisiting if false-negatives appear.
- **WebGL positive-Apple assertion only runs headed.** Headless CI falls back to
  SwiftShader; the test skips the positive check there but still forbids the
  Intel lie.

---

## Changelog

- **2026-05-28** — Account-flag response. (1) Removed the Intel-on-Apple WebGL
  lie + all counterproductive spoofs; consolidated 4 divergent `STEALTH_INIT`
  copies into `src/shared/stealth.mjs`. (2) Ported the extension's V2 behavior
  into the daemon: "Show all" trusted clicks, bezier mouse, seeded cadence,
  shuffled section order, single-visit-per-section, noise contract. (3) Added
  mid-run blocker detection → pause (not plow), circuit breaker, per-account
  budget, working hours, inter-run cooldown; lowered the webhook candidate clamp
  25→8. Full per-profile extraction preserved throughout.
