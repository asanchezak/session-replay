// daemon-behavior.mjs — HOT-LOADED daemon decision logic.
//
// The daemon host (extension/driver-daemon.mjs) loads THIS file by file mtime on
// every poll tick (same mechanism as recruiter.mjs), so behavior changes apply by
// `scp`-ing this one file to the host — NO daemon restart, NO /talent re-login.
//
// Keep the HOST (driver-daemon.mjs) stable and put volatile decision logic here.
// Each exported function takes one `api` bag the host passes in:
//   api.helpers — low-level helpers (sleep, resolveLocator*, click/type, mouse, scroll, …)
//   api.io      — backend I/O (fetchJson, reportStepResult, failRun, pauseRun, postExtraction)
//   api.config  — env/config (OPERATOR_ID, BACKEND, viewport, RECRUITER_PING_*, …)
//   api.state   — mutable host state accessors (getWarmPage/setWarmPage, getProfileContext, …)
//
// Functions RETURN deltas; the host applies side effects it owns (failRun, set
// recruiterPingDue, …). Only `warmPage` is shared by reference via the setter.
//
// If this module fails to import OR a required export is missing, the host runs in
// a STRICT fail-safe: it does NOT claim/drive runs and does NOT keepalive — only
// polls + heartbeats + logs loudly — until a good module is synced. So a broken
// `scp` safely pauses work instead of running stale/degraded.

export const BEHAVIOR_VERSION = "2026-07-07-behavior-5-seat-gate";

// ── Seat-warmth gate state ───────────────────────────────────────────────────
// The daemon must NOT drive /talent runs on a cold/walled seat (they'd fail and
// be lost). keepAliveTick records the latest seat warmth here; pickPendingRun
// HOLDS seat-requiring runs in the queue until it's confirmed warm, then drains
// them. Module-level → persists across ticks (mtime-cached), resets on hot-reload
// (a fresh scp) and on a daemon restart. `keepaliveObserved` guards hosts where
// keepalive never runs (non-seat operators): the gate is a no-op there so runs
// aren't stranded.
let seatWarm = null;            // null=unknown; true/false after a keepalive ping
let keepaliveObserved = false;  // true once keepAliveTick has run at least once
let lastHeldLog = "";           // throttle the "holding N seat run(s)" log

// ── Reply-scanner ──────────────────────────────────────────────────────────
// Passive, read-only scan of the Recruiter messaging inbox: collect the candidates
// who REPLIED (conversations carrying an UNREAD badge = a new inbound message) and
// POST them to the backend, which flips the matching Odoo linkedin.lead to
// outreach_status='responded'. Runs inside keepAliveTick on its own slow cadence,
// reusing the ONE warm tab. NEVER opens a thread (that would mark it read and erase
// the human recruiter's unread cues). Matched by participant NAME — the inbox cards
// expose no /talent/profile/ link — so akcr matches name among 'messaged' leads.
// Land on the inbox FOLDER (list) without an /id/<thread> — navigating to bare
// /talent/inbox auto-opens the most-recent conversation, which sends a READ receipt
// (marks the freshest reply read → scanner misses it AND mutates the human's inbox).
const INBOX_URL = "https://www.linkedin.com/talent/inbox/0/main";
// The seat has multiple contracts → /talent/inbox lands on a contract-chooser. Pick
// the Recruiter contract (NOT the "Job Posting" one). Matched locale-proof by the
// account-specific contract name in data-live-test-contract-select.
const CONTRACT_MATCH = "Morsoft";
// The seat owner's name — a message whose sender is NOT this is INBOUND (a candidate
// reply). Substring match, robust to "María Fernanda Benavides" variants.
const SEAT_OWNER_MATCH = "Benavides";
// Scan cadence (tunable by scp — module-level, resets on hot-reload so re-syncing
// this file forces an immediate scan on the next warm tick).
const REPLY_SCAN_MS = 45 * 60_000;
let lastReplyScanAt = 0;

// Navigate the warm tab to the Recruiter inbox, clicking through the contract-chooser
// if it appears. Returns true if we believe we reached the inbox.
async function gotoInbox(page, h) {
  await page.goto(INBOX_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await h.sleep(2500);
  if (/contract-chooser/i.test(page.url())) {
    const sel = `button[data-test-contract-select][data-live-test-contract-select*="${CONTRACT_MATCH}" i]`;
    const target = h.resolveLocatorWithWait
      ? await h.resolveLocatorWithWait(page, [{ css: sel }], { timeoutMs: 8000 }).catch(() => null)
      : null;
    if (target && h.clickResolved) {
      await h.clickResolved(page, target, { moveMouseAlongBezier: h.moveMouseAlongBezier, orand: Math.random });
    } else {
      await page.click(sel, { timeout: 8000 }).catch(() => {});
    }
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await h.sleep(3000);
    console.log(`[inbox] picked '${CONTRACT_MATCH}' contract → ${page.url()}`);
  }
  return !/contract-chooser/i.test(page.url());
}

// Read-only scan: collect candidates who REPLIED and POST to the backend. Two signals:
//  (1) conversation cards with an UNREAD badge (a new inbound msg we haven't opened);
//  (2) the auto-opened (most-recent) thread — LinkedIn force-opens it on navigation
//      (clearing its unread badge), so detect inbound by its LAST message's sender NOT
//      being the seat owner. Together these catch the freshest reply + any older unread.
async function scanInboxReplies(page, api) {
  const h = api.helpers;
  const reached = await gotoInbox(page, h);
  if (!reached) { console.log("[reply-scan] could not reach inbox (contract chooser?)"); return 0; }
  await h.sleep(1500);
  const replies = await page.evaluate((SEAT_OWNER) => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const out = []; const seen = new Set();
    const add = (name, urn, via) => {
      name = clean(name);
      if (!name || name.includes(SEAT_OWNER) || seen.has(name)) return;
      seen.add(name); out.push({ name, conversation_urn: urn || "", via });
    };
    // (1) Unread conversation cards.
    for (const card of document.querySelectorAll("[data-test-conversation-card-container]")) {
      if (!card.querySelector("[data-test-unread-badge]")) continue;
      add(card.querySelector("[data-test-participant-name]")?.textContent,
          card.getAttribute("data-test-conversation-urn"), "unread");
    }
    // (2) Auto-opened thread: last message inbound (sender != seat owner) = a reply.
    const items = document.querySelectorAll("[data-test-message-list-item]");
    const last = items[items.length - 1];
    const lastSender = clean(last?.querySelector("[data-test-message-sender-name]")?.textContent);
    if (lastSender && !lastSender.includes(SEAT_OWNER)) add(lastSender, "", "open-thread");
    return out;
  }, SEAT_OWNER_MATCH).catch(() => []);
  if (!replies.length) { console.log("[reply-scan] no replies"); return 0; }
  try {
    const res = await api.io.fetchJson(`${api.config.BACKEND}/v1/recruiter/inbox-replies`, {
      method: "POST",
      body: JSON.stringify({ replies }),
    });
    console.log(`[reply-scan] reported ${replies.length} reply(ies) ${JSON.stringify(replies.map(r => r.name + ":" + r.via))} → ${JSON.stringify(res).slice(0, 200)}`);
  } catch (e) {
    console.log(`[reply-scan] POST failed: ${(e && e.message) || e}`);
  }
  return replies.length;
}

// ── pickPendingRun ───────────────────────────────────────────────────────────
// Decide which queued/running/recovering run THIS daemon should claim next. The
// host fetches the status buckets (stable I/O) and passes the flattened list.
//   runs: ExecutionRun[]  (already flattened across statuses)
//   api.config.OPERATOR_ID
// Returns the chosen run, or null.
export function pickPendingRun(runs, api) {
  const OPERATOR_ID = api.config.OPERATOR_ID;
  const items = Array.isArray(runs) ? runs : [];
  const watched = items.filter((r) => {
    if (!r.origin) return false;
    // Webhook/reconciler-driven LinkedIn flows (by event_kind) AND any run the
    // extension explicitly enqueued for the daemon (execution_target=="daemon").
    const isWatched = r.origin.event_kind === "new_job_position"
      || r.origin.event_kind === "linkedin_lead_search"
      || r.origin.execution_target === "daemon";
    if (!isWatched) return false;
    // Operator routing: only claim runs targeted at THIS daemon's operator.
    if ((r.origin.target_operator || "") !== OPERATOR_ID) return false;
    if (Array.isArray(r.extracted_data) && r.extracted_data.length > 0) return false;
    if (r.status === "queued" && r.current_step_index > 0) return false;
    return true;
  });
  if (watched.length === 0) return null;
  // Seat-warmth gate: HOLD runs that need the warm /talent seat until keepalive
  // has confirmed it's warm — otherwise driving them on a cold/walled seat fails
  // the run and loses the work. Only enforced once keepalive has actually run on
  // this host (keepaliveObserved); if keepalive is disabled the gate is a no-op so
  // runs aren't stranded. Generic dashboard runs don't need the seat → never held.
  const seatGateActive = keepaliveObserved && seatWarm !== true;
  const claimable = seatGateActive ? watched.filter((r) => !needsSeat(r)) : watched;
  if (claimable.length === 0) {
    if (seatGateActive) {
      const msg = `holding ${watched.length} seat run(s) — seat not warm (seatWarm=${seatWarm})`;
      if (msg !== lastHeldLog) { console.log(`[behavior] ${msg}`); lastHeldLog = msg; }
    }
    return null;
  }
  lastHeldLog = "";
  // Priority first (origin.priority, default 0 — higher wins), then FIFO by
  // created_at within a priority. Interactive pipeline/message runs stamp +10;
  // bulk cleanup (deferred-removal archives) stamp −10, so a flood of removals
  // can't starve an interactive run on this single-seat daemon.
  claimable.sort((a, b) => {
    const pa = (a.origin && a.origin.priority) || 0;
    const pb = (b.origin && b.origin.priority) || 0;
    if (pb !== pa) return pb - pa;
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    return ta - tb;
  });
  return claimable[0];
}

// A run that needs the warm /talent Recruiter seat to execute. Recruiter pipeline
// flows (by event_kind) + webhook/reconciler LinkedIn flows + any profile-using
// daemon run that isn't a generic dashboard run. Generic dashboard "Run" jobs
// (execution_mode==="generic", non-LinkedIn) do NOT need the seat.
function needsSeat(r) {
  const o = (r && r.origin) || {};
  const k = o.event_kind || "";
  if (k === "new_job_position" || k === "linkedin_lead_search") return true;
  if (k.startsWith("recruiter_")) return true;
  if (o.execution_target === "daemon" && o.execution_mode !== "generic") {
    const opts = o.execution_options || {};
    if (opts.use_profile) return true;
  }
  return false;
}

// ── driveGenericStep ─────────────────────────────────────────────────────────
// The generic interactive verb (click/type) hot path — used by ALL ~131
// workflows, not just recruiter. Resolves the recorded selector_chain (primary,
// then ONE level of methods[] fallback), acts via the SHARED humanized cursor /
// typing, then evaluates the checkpoint/success_condition verdict.
//
// Returns { acted: boolean, critFail: string|null }. The HOST owns the side
// effects: on critFail it captureDebug + failRun + breaks; otherwise it
// reportStepResult. On a non-checkpoint soft-miss the module logs and returns
// { acted:false, critFail:null } so the host advances (the backend has no
// per-step retry/heal — a success:false would FAIL the whole run).
export async function driveGenericStep({ step, page, idx, action, value, orand, api }) {
  const h = api.helpers;
  const attempts = [{ selector_chain: step.selector_chain, action_type: action, value }];
  if (Array.isArray(step.methods)) {
    for (const m of step.methods) {
      if (m && Array.isArray(m.selector_chain) && m.selector_chain.length) {
        attempts.push({
          selector_chain: m.selector_chain,
          action_type: m.action_type || action,
          value: m.value !== undefined ? String(m.value) : value,
        });
      }
    }
  }
  let acted = false;
  let actedTarget = null;
  for (let ai = 0; ai < attempts.length; ai++) {
    const a = attempts[ai];
    // Wait for the PRIMARY recorded selector to render (async /talent SPA) before
    // acting; fallback methods[] selectors are tried immediately.
    const target = ai === 0
      ? await h.resolveLocatorWithWait(page, a.selector_chain, { timeoutMs: api.config.STEP_RESOLVE_TIMEOUT_MS })
      : await h.resolveLocator(page, a.selector_chain);
    if (!target) continue;
    if (a.action_type === "type") {
      acted = await h.typeResolved(page, target, a.value, { moveMouseAlongBezier: h.moveMouseAlongBezier, typeHumanLike: h.typeHumanLike, orand });
    } else {
      acted = await h.clickResolved(page, target, { moveMouseAlongBezier: h.moveMouseAlongBezier, orand });
    }
    if (acted) { actedTarget = target; break; }
  }
  // A step flagged `checkpoint:true` is CRITICAL — if it doesn't act or its
  // success_condition fails, HARD-FAIL the run (visible + relaunchable) instead
  // of the default soft-miss/advance. Catches silent breakage like the locale
  // regression (a facet that never opened → empty search "completed").
  let critFail = null;
  if (!acted) {
    if (step.checkpoint) critFail = "no selector resolved";
    else console.log(`  step ${idx}: ${action} — no selector resolved (soft-miss, advancing)`);
  } else if (step.success_condition) {
    const verdict = await h.checkSuccessConditionDaemon(page, step, actedTarget);
    if (!verdict.ok) {
      if (step.checkpoint) critFail = `success_condition unmet (${verdict.reason})`;
      else console.log(`  step ${idx}: ${action} success_condition not met (${verdict.reason}) — soft, advancing`);
    }
  }
  return { acted, critFail };
}

// ── seat-cookie persistence ──────────────────────────────────────────────────
// The Recruiter /talent seat is held by SESSION-scoped cookies, which Chromium
// never writes to disk in our Playwright-launched profile — so every browser
// close (nightly host power-off, daemon restart) silently dropped the seat and
// the next boot was walled, while Fernanda's own Chrome (session-restore on)
// kept hers for weeks. Fix: after each warm ping, re-write the LinkedIn session
// cookies WITH an expiry so they live in the cookie DB as persistent cookies
// and survive restarts. Local-only storage attribute — nothing changes on the
// wire, so no fingerprint/anti-bot impact.
const SEAT_COOKIE_TTL_S = 7 * 86400;

// ── seat-cookie DIAGNOSTIC (2026-07-07) ──────────────────────────────────────
// The 7-day-expiry persist below is DEPLOYED and running yet the seat still walls
// on every nightly boot. Before building a heavier fix we need to know WHY: is a
// client cookie being dropped (fixable client-side) or is the seat gone server-side
// (no client trick helps)? These logs answer it on the next power-off cycle. They
// log cookie NAMES/domains/expiry/partition-flag only — NEVER values (no secrets).
let cookieInventoryLogged = false;  // once per module load ≈ once per boot
function linkedinCookieReport(all) {
  const li = all.filter((c) => String(c.domain || "").includes("linkedin.com"));
  const nowS = Date.now() / 1000;
  const fmt = (c) => {
    const sess = c.expires === -1 || c.expires == null;
    const part = c.partitionKey ? "P" : "-";
    const life = sess ? "session" : Math.round((c.expires - nowS) / 86400) + "d";
    return `${c.name}[${c.domain}${part}${life}]`;
  };
  return {
    total: li.length,
    sessionCt: li.filter((c) => c.expires === -1 || c.expires == null).length,
    partCt: li.filter((c) => c.partitionKey).length,
    list: li.map(fmt).join(" "),
  };
}

async function persistSeatCookies(ctx) {
  const all = await ctx.cookies();
  const sess = all.filter((c) =>
    c.expires === -1 && !c.partitionKey && String(c.domain || "").includes("linkedin.com"));
  // DIAGNOSTIC: which partitioned linkedin session cookies is the current filter SKIPPING?
  // If the seat cookie is partitioned (CHIPS), it's silently excluded → never persisted.
  const skippedPart = all.filter((c) =>
    c.expires === -1 && c.partitionKey && String(c.domain || "").includes("linkedin.com"));
  if (skippedPart.length)
    console.log(`[seat-diag] EXCLUDING ${skippedPart.length} partitioned session cookie(s): ${skippedPart.map((c) => c.name).join(",")}`);
  if (!sess.length) return 0;
  const exp = Math.floor(Date.now() / 1000) + SEAT_COOKIE_TTL_S;
  await ctx.addCookies(sess.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, expires: exp,
  })));
  console.log(`[seat-diag] rewrote ${sess.length} session cookie(s) → 7d: ${sess.map((c) => c.name).join(",")}`);
  return sess.length;
}

// ── keepAliveTick ────────────────────────────────────────────────────────────
// Read-only /talent/home ping that refreshes the Recruiter session so it doesn't
// lapse between runs. NEVER opens a fresh browser — reuses the parked /talent tab
// (warmPage) the host owns. Never trips the circuit breaker; a wall just flags
// that a fresh login is needed.
//
// Returns { warm: boolean, nextDueMs: number } — the host applies them
// (recruiterSessionWarm + recruiterPingDue). warmPage is shared by reference via
// api.state.setWarmPage.
export async function keepAliveTick(api) {
  const h = api.helpers;
  const cfg = api.config;
  let warm = null;
  let repliesPosted = 0;
  try {
    const ctx = await api.state.getProfileContext();
    let warmPage = api.state.getWarmPage();
    // Reuse (or re-establish) the parked /talent tab — NEVER open a fresh browser.
    // Keeping this ONE tab alive is what holds the seat: the Recruiter SPA keeps
    // polling LinkedIn's realtime endpoints exactly like an always-open browser.
    if (!warmPage || warmPage.isClosed()) {
      warmPage = (ctx.pages()[0] && !ctx.pages()[0].isClosed()) ? ctx.pages()[0] : await ctx.newPage();
      api.state.setWarmPage(warmPage);
    }
    // DIAGNOSTIC (decisive): on the FIRST ping after this module (re)loaded — i.e.
    // right after a nightly boot — snapshot the cookies BEFORE navigating, so we see
    // exactly what survived the power-off before /uas/login-cap can clear li_at. The
    // 15:50 walled inventory showed li_at/liap/li_a ALL absent — but that was mid-day
    // after hours of login-cap pings, not the true boot state. This pre-nav capture
    // is the one that settles client-side (auth cookie gone at boot → we can re-inject)
    // vs server-side (li_at present at boot but /talent still walls → unfixable).
    if (!cookieInventoryLogged) {
      try {
        const boot = await ctx.cookies();
        const rep = linkedinCookieReport(boot);
        const has = (n) => boot.some((c) => c.name === n && String(c.domain || "").includes("linkedin.com"));
        console.log(`[seat-diag] PRE-NAV boot inventory: li_at=${has("li_at")} liap=${has("liap")} li_a=${has("li_a")} JSESSIONID=${has("JSESSIONID")} total=${rep.total} session=${rep.sessionCt} partitioned=${rep.partCt} :: ${rep.list}`);
      } catch (e) { console.log(`[seat-diag] pre-nav inventory error: ${(e && e.message) || e}`); }
    }
    // Re-assert the session in the SAME tab: a real authenticated request every
    // couple of minutes refreshes the seat and surfaces a wall if one appeared.
    await warmPage.goto("https://www.linkedin.com/talent/home", { waitUntil: "domcontentloaded", timeout: 60000 });
    await warmPage.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await h.sleep(2500 + Math.random() * 2500);
    const url = warmPage.url();
    const walled = h.isBlockerUrl(url) || /\/uas\/login|login-cap/i.test(url);
    warm = !walled;
    // DIAGNOSTIC: on the FIRST ping after this module (re)loaded — i.e. right after
    // a nightly boot — and on every walled ping, log which linkedin cookies actually
    // survived the power-off. Walled+seat-cookie-present ⇒ server-side (unfixable
    // client-side); walled+seat-cookie-gone ⇒ client-side (persist/re-inject can fix).
    if (!cookieInventoryLogged || walled) {
      try {
        const rep = linkedinCookieReport(await ctx.cookies());
        console.log(`[seat-diag] cookie inventory (walled=${walled}): total=${rep.total} session=${rep.sessionCt} partitioned=${rep.partCt} :: ${rep.list}`);
      } catch (e) { console.log(`[seat-diag] inventory error: ${(e && e.message) || e}`); }
      cookieInventoryLogged = true;
    }
    if (walled) {
      const title = await warmPage.title().catch(() => "");
      const kind = /checkpoint|challenge|verif/i.test(url) ? "CHECKPOINT/CHALLENGE"
        : /login|uas/i.test(url) ? "LOGIN" : "OTHER";
      console.log(`[keepalive] /talent WALLED [${kind}] url=${url} title="${title}" — Recruiter seat lapsed. Browser stays OPEN.`);
    } else {
      await h.moveMouseAlongBezier(warmPage, { x: 400 + Math.random() * 400, y: 250 + Math.random() * 200 }, Math.random).catch(() => {});
      await h.humanScrollSeeded(warmPage, 1 + Math.floor(Math.random() * 2), Math.random).catch(() => {});
      console.log(`[keepalive] /talent OK — Recruiter seat warm (browser kept open)`);
      // Make the warm seat survive a browser restart (nightly host shutdown).
      try {
        const n = await persistSeatCookies(ctx);
        if (n) console.log(`[keepalive] persisted ${n} session cookie(s) → seat survives browser restarts`);
      } catch (e) { console.log(`[keepalive] cookie persist skipped: ${(e && e.message) || e}`); }
      // Reply-scan: on its own slow cadence (REPLY_SCAN_MS) OR on-demand when the Odoo
      // "Escanear respuestas" button requested one (newer than our last scan). Reuses
      // the warm tab; the next ping re-navigates to /talent/home.
      let manualReqMs = 0;
      try {
        const r = await api.io.fetchJson(`${cfg.BACKEND}/v1/recruiter/inbox-scan-requested`);
        manualReqMs = Math.round((r && r.requested_at ? r.requested_at : 0) * 1000);
      } catch { /* backend unreachable — fall back to cadence only */ }
      const cadenceDue = Date.now() - lastReplyScanAt >= REPLY_SCAN_MS;
      const manualDue = manualReqMs > lastReplyScanAt;
      if (cadenceDue || manualDue) {
        if (manualDue) console.log(`[reply-scan] manual trigger (Odoo button)`);
        lastReplyScanAt = Date.now();
        try { repliesPosted = await scanInboxReplies(warmPage, api); }
        catch (e) { console.log(`[reply-scan] error: ${(e && e.message) || e}`); }
      }
    }
  } catch (e) {
    console.log(`[keepalive] ping error: ${(e && e.message) || e}`);
  }
  // Record warmth for the seat gate (pickPendingRun). `warm` stays null if the
  // ping threw before determining a verdict — leave the prior known value in that
  // case so a transient ping error doesn't flip the gate to "unknown". Mark that
  // keepalive has run at least once so the gate becomes active on this host.
  keepaliveObserved = true;
  if (warm !== null) seatWarm = warm;
  // NO browser close — keeping it open is the whole point of the seat fix.
  // Cadence: when warm, ping again soon to stay ahead of the short idle window;
  // when walled, back off (pinging the login page won't help until a fresh login).
  const jit = (base, spread) => base + Math.floor(Math.random() * spread);
  const nextDueMs = warm === false
    ? Date.now() + jit(cfg.RECRUITER_PING_WALLED_BACKOFF_MS, 60_000)
    : Date.now() + jit((cfg.RECRUITER_PING_MIN_MS + cfg.RECRUITER_PING_MAX_MS) / 2, (cfg.RECRUITER_PING_MAX_MS - cfg.RECRUITER_PING_MIN_MS) / 2);
  return { warm, nextDueMs, repliesPosted };
}
