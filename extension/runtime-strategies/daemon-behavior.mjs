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

export const BEHAVIOR_VERSION = "2026-06-15-behavior-1";

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
  // Priority first (origin.priority, default 0 — higher wins), then FIFO by
  // created_at within a priority. Interactive pipeline/message runs stamp +10;
  // bulk cleanup (deferred-removal archives) stamp −10, so a flood of removals
  // can't starve an interactive run on this single-seat daemon.
  watched.sort((a, b) => {
    const pa = (a.origin && a.origin.priority) || 0;
    const pb = (b.origin && b.origin.priority) || 0;
    if (pb !== pa) return pb - pa;
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    return ta - tb;
  });
  return watched[0];
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
    // Re-assert the session in the SAME tab: a real authenticated request every
    // couple of minutes refreshes the seat and surfaces a wall if one appeared.
    await warmPage.goto("https://www.linkedin.com/talent/home", { waitUntil: "domcontentloaded", timeout: 60000 });
    await warmPage.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await h.sleep(2500 + Math.random() * 2500);
    const url = warmPage.url();
    const walled = h.isBlockerUrl(url) || /\/uas\/login|login-cap/i.test(url);
    warm = !walled;
    if (walled) {
      console.log(`[keepalive] /talent WALLED — Recruiter seat lapsed; needs a fresh login (login-talent.bat). Browser stays OPEN.`);
    } else {
      await h.moveMouseAlongBezier(warmPage, { x: 400 + Math.random() * 400, y: 250 + Math.random() * 200 }, Math.random).catch(() => {});
      await h.humanScrollSeeded(warmPage, 1 + Math.floor(Math.random() * 2), Math.random).catch(() => {});
      console.log(`[keepalive] /talent OK — Recruiter seat warm (browser kept open)`);
    }
  } catch (e) {
    console.log(`[keepalive] ping error: ${(e && e.message) || e}`);
  }
  // NO browser close — keeping it open is the whole point of the seat fix.
  // Cadence: when warm, ping again soon to stay ahead of the short idle window;
  // when walled, back off (pinging the login page won't help until a fresh login).
  const jit = (base, spread) => base + Math.floor(Math.random() * spread);
  const nextDueMs = warm === false
    ? Date.now() + jit(cfg.RECRUITER_PING_WALLED_BACKOFF_MS, 60_000)
    : Date.now() + jit((cfg.RECRUITER_PING_MIN_MS + cfg.RECRUITER_PING_MAX_MS) / 2, (cfg.RECRUITER_PING_MAX_MS - cfg.RECRUITER_PING_MIN_MS) / 2);
  return { warm, nextDueMs };
}
