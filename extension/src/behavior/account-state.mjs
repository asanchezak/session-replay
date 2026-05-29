/**
 * Per-account operational state for the LinkedIn driver daemon: a daily/hourly
 * request budget and a circuit breaker, persisted to a gitignored sidecar JSON
 * file keyed by the Chrome profile dir. Survives launchd restarts; no DB.
 *
 * Factored out of driver-daemon.mjs as an injectable store so the budget /
 * circuit / working-hours logic is unit-testable (the daemon itself runs a
 * top-level poll loop on import and can't be imported into a test).
 *
 * All time is taken from an injectable `now()` (defaults to Date.now) so tests
 * can pin the clock. Budget windows are keyed by LOCAL day/hour.
 */
import fs from "fs";

const DEFAULT_LIMITS = {
  profileViewsPerDay: 80,
  profileViewsPerHour: 18,
  searchesPerDay: 30,
  pageLoadsPerDay: 500,
};

// Hard-blocker cooldown ladder (login_form/captcha/checkpoint): 4h,12h,24h,48h.
const DEFAULT_HARD_LADDER_MS = [4, 12, 24, 48].map((h) => h * 3600_000);
// Soft-signal ladder (redirect/empty results): 1h, 4h, then folds into hard.
const DEFAULT_SOFT_LADDER_MS = [1, 4].map((h) => h * 3600_000);
const DEFAULT_CIRCUIT_RESET_MS = 24 * 3600_000;

const DEFAULT_WORK = {
  startHour: 8,
  endHour: 19,
  days: [1, 2, 3, 4, 5],
  enabled: true,
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

export function createAccountStateStore(opts = {}) {
  const file = opts.file;
  const accountId = opts.accountId;
  const now = opts.now || (() => Date.now());
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
  const hardLadder = opts.hardLadderMs || DEFAULT_HARD_LADDER_MS;
  const softLadder = opts.softLadderMs || DEFAULT_SOFT_LADDER_MS;
  const resetMs = opts.circuitResetMs || DEFAULT_CIRCUIT_RESET_MS;
  const work = { ...DEFAULT_WORK, ...(opts.work || {}) };

  const emptyCircuit = () => ({
    state: "closed",
    open_until: 0,
    consecutive_trips: 0,
    last_trip_at: 0,
    last_trip_kind: null,
  });

  function dayKey(ms = now()) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function hourKey(ms = now()) {
    const d = new Date(ms);
    return `hour:${dayKey(ms)}T${pad2(d.getHours())}`;
  }

  function load() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(file, "utf-8")); } catch {}
    if (!raw || raw.account_id !== accountId) {
      raw = { account_id: accountId, windows: {}, circuit: emptyCircuit() };
    }
    if (!raw.windows) raw.windows = {};
    if (!raw.circuit) raw.circuit = emptyCircuit();
    // Prune windows older than 48h. Both key shapes embed YYYY-MM-DD in their
    // first 10 chars after the optional "hour:" prefix.
    const cutoff = now() - 48 * 3600_000;
    for (const k of Object.keys(raw.windows)) {
      const datePart = (k.startsWith("hour:") ? k.slice(5) : k).slice(0, 10);
      const ts = Date.parse(`${datePart}T00:00`);
      if (Number.isFinite(ts) && ts < cutoff) delete raw.windows[k];
    }
    return raw;
  }

  function save(state) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  function bump(field, n = 1) {
    const state = load();
    for (const key of [dayKey(), hourKey()]) {
      state.windows[key] = state.windows[key] || {};
      state.windows[key][field] = (state.windows[key][field] || 0) + n;
    }
    save(state);
  }

  function recordPageLoad() { bump("page_loads"); }
  function recordProfileView() { bump("profile_views"); }
  function recordSearch() { bump("searches"); }

  // null if there's headroom, else a string reason. Used to gate run-start and
  // to stop mid-run (pause-and-resume — never drops data).
  function budgetExhaustedReason() {
    const state = load();
    const day = state.windows[dayKey()] || {};
    const hour = state.windows[hourKey()] || {};
    if ((day.profile_views || 0) >= limits.profileViewsPerDay) return "daily_profile_view_budget";
    if ((hour.profile_views || 0) >= limits.profileViewsPerHour) return "hourly_profile_view_budget";
    if ((day.searches || 0) >= limits.searchesPerDay) return "daily_search_budget";
    if ((day.page_loads || 0) >= limits.pageLoadsPerDay) return "daily_page_load_budget";
    return null;
  }

  // Open the circuit for an escalating cooldown. Returns the chosen state.
  function tripCircuit(kind, soft = false) {
    const state = load();
    const c = state.circuit;
    if (c.last_trip_at && now() - c.last_trip_at > resetMs) c.consecutive_trips = 0;
    c.consecutive_trips += 1;
    const ladder = soft ? softLadder : hardLadder;
    const idx = Math.min(c.consecutive_trips - 1, ladder.length - 1);
    const cooldown = ladder[idx];
    c.state = "open";
    c.open_until = now() + cooldown;
    c.last_trip_at = now();
    c.last_trip_kind = kind;
    save(state);
    return { ...c, cooldown_ms: cooldown };
  }

  function circuit() {
    return load().circuit;
  }

  function circuitOpen() {
    const c = circuit();
    return c.state === "open" && now() < (c.open_until || 0);
  }

  function isWithinWorkingHours(ms = now()) {
    if (!work.enabled) return true;
    const d = new Date(ms);
    if (!work.days.includes(d.getDay())) return false;
    const h = d.getHours();
    return h >= work.startHour && h < work.endHour;
  }

  return {
    load, save, dayKey, hourKey,
    recordPageLoad, recordProfileView, recordSearch,
    budgetExhaustedReason, tripCircuit, circuit, circuitOpen,
    isWithinWorkingHours,
    limits, work,
  };
}
