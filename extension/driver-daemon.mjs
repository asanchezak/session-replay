/**
 * Driver daemon — long-running process that closes the option-A loop.
 *
 * Polls the backend for `running` runs whose origin.event_kind is
 * "new_job_position" and whose extracted_data is still empty (i.e. nobody
 * has driven them yet). For each pending run, opens real Chrome with the
 * staged .linkedin-profile and drives the workflow steps just like the
 * one-shot driver. After one run finishes, polls again.
 *
 * Run alongside Chrome (extension installed or not). Each test cycle:
 *
 *   1. POST a webhook payload {job_id, job_title, candidate_count} to
 *      /v1/webhooks/incoming/odoo/{connector_id}
 *   2. Backend creates the run with origin metadata
 *   3. This daemon picks it up and drives Chrome
 *   4. Run completes → push hook fires → Odoo applicants created
 *
 * Stop with Ctrl-C. No state on disk; restart anytime.
 */
import { chromium } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { defaultEmptyValue, readExtractShapes, readExtractStrategy, shapeToPrompt, shapeToSchema } from "./driver-shapes.mjs";
import { STEALTH_INIT } from "./src/shared/stealth.mjs";
import { OVERLAY_INIT } from "./src/shared/overlay-init.mjs";
import {
  mulberry32,
  pickDwellMs,
  pickNoiseDwellMs,
  pickNoiseScrollTicks,
  shuffleInPlace,
} from "./src/behavior/stealth-core.mjs";
import { createAccountStateStore } from "./src/behavior/account-state.mjs";
import { detectChallengeInPage, isBlockerUrl } from "./src/behavior/blocker-detect.mjs";
import { createPageNav } from "./src/behavior/page-nav.mjs";
import {
  parseExperienceItems, parseSkillItems, parseEducationItems,
  parseCertificationItems, parseProjectItems, parseSimpleListItems,
} from "./src/behavior/profile-parsers.mjs";
import { experienceParasCore, sectionListItemsCore, subpageTextCore } from "./src/behavior/profile-dom.mjs";
import { prepareConnectNoteDialog, NOTE_TEXTAREA_SELECTOR } from "./src/behavior/connect-compose-core.mjs";
import { PHASE_A_VERBS, resolveLocator, clickResolved, typeResolved } from "./src/behavior/selector-resolve.mjs";
import { evaluateSuccessCondition, successConditionInputs } from "./src/behavior/step-interpreter.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROFILE_DIR = path.resolve(__dirname, ".linkedin-profile");

const BACKEND = process.env.BACKEND || "http://localhost:8081";
const API_KEY = process.env.API_KEY || "dev-api-key-change-in-production";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || "5000");
// Browser viewport. Default 1440x900 matches a real Mac display. On a
// non-interactive Windows session the OS reports a small generic screen
// (e.g. 1280x720), so a 1440x900 viewport would be LARGER than screen —
// physically impossible on a real monitor and a fingerprint tell. Set
// VIEWPORT_WIDTH/HEIGHT ≤ the session's screen there (with room for chrome).
const VIEWPORT_WIDTH = Number(process.env.VIEWPORT_WIDTH || "1440");
const VIEWPORT_HEIGHT = Number(process.env.VIEWPORT_HEIGHT || "900");
// Run watchdog: if a single run takes longer than this, the daemon captures the
// page state (URL/title/HTML/console/screenshot) and aborts cleanly instead of
// hanging silently. Critical for remote hosts (Fernanda's Mac) where there is no
// shell to inspect a stuck Chrome. Tune via RUN_WATCHDOG_MS.
const RUN_WATCHDOG_MS = Number(process.env.RUN_WATCHDOG_MS || "240000");
// Phase C ship-dark switch. OFF (default): the lead flow runs the hardcoded
// steps-0-5 preamble (byte-for-byte unchanged). ON: the daemon instead drives
// steps 0-5 from the backend plan via the generic loop (linkedin_people_search
// + linkedin_search_people extract strategy). The ON path has intentionally
// different-but-humanized timing and MUST be diffed on a burner/test account
// before being enabled in production — see plan Phase C + project memory.
const GENERIC_PREAMBLE = process.env.DAEMON_GENERIC_PREAMBLE === "1";
const DEBUG_DIR = path.resolve(__dirname, ".debug");
const WORKER_ID = process.env.WORKER_ID || `${os.hostname()}-${process.pid}`;
// Routing identity: this daemon only claims runs whose origin.target_operator
// matches OPERATOR_ID. Each operator's machine sets its own (e.g. "andrey");
// the LinkedIn host sets "fernanda". Empty = claims only untargeted... see
// findPendingRun (we require an explicit match to avoid misrouting).
const OPERATOR_ID = process.env.OPERATOR_ID || "";

const HEADERS = { "X-API-Key": API_KEY, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base, spread) => base + Math.floor(Math.random() * spread);
let drivingRunId = null;

function isTransientBackendError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("fetch failed")
    || msg.includes("ECONNRESET")
    || msg.includes("ECONNREFUSED")
    || msg.includes("ETIMEDOUT")
    || msg.includes("ENOTFOUND")
    || msg.includes("network")
  );
}

async function withBackendRetry(label, fn, attempts = 5) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientBackendError(err) || attempt === attempts) break;
      const delayMs = Math.min(5000, 500 * 2 ** (attempt - 1));
      console.warn(`[backend retry] ${label} attempt ${attempt}/${attempts} failed: ${err.message || err}. Retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

function loadOpenAIKey() {
  try {
    const t = fs.readFileSync(path.resolve(__dirname, "..", "backend", ".env"), "utf-8");
    const m = t.match(/^AI_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return process.env.LINKEDIN_AI_KEY || "";
}
const OPENAI_API_KEY = loadOpenAIKey();

// ── Backend client ──────────────────────────────────────────────────────────

async function fetchJson(url, init = {}) {
  const r = await withBackendRetry(
    `${init.method || "GET"} ${url}`,
    () => fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers || {}) } }),
  );
  if (!r.ok) throw new Error(`${init.method || "GET"} ${url} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function postHeartbeat({ worker_id, polling, driving_run_id, circuit_open, circuit_reason, cooldown_until }) {
  await fetchJson(`${BACKEND}/v1/daemon/heartbeat`, {
    method: "POST",
    body: JSON.stringify({ worker_id, polling, driving_run_id, circuit_open, circuit_reason, cooldown_until, operator_id: OPERATOR_ID }),
  });
}

// Pause a run on the backend (mirrors the extension's apiClient.pauseRun). Used
// when a LinkedIn wall is detected mid-run or the daily budget is exhausted, so
// the run stops cleanly (cursor NOT advanced) instead of plowing through.
async function pauseRun(runId, reason, stepIndex) {
  try {
    await fetchJson(`${BACKEND}/v1/runs/${runId}/pause`, {
      method: "POST",
      body: JSON.stringify({ reason, step_index: stepIndex }),
    });
    console.log(`[daemon] paused run ${runId} @ step ${stepIndex}: ${reason}`);
  } catch (err) {
    console.error(`[daemon] pauseRun ${runId} failed:`, err.message?.slice(0, 200));
  }
}

// Atomically claim a QUEUED run (QUEUED→RUNNING) before driving it. The backend
// takes SELECT … FOR UPDATE on the row, so a lost race (run already claimed)
// comes back 409 — return false and let the next poll pick a different run.
// Returns true only when this daemon now owns the run.
async function claimRun(runId) {
  try {
    await fetchJson(`${BACKEND}/v1/runs/${runId}/start`, { method: "POST" });
    return true;
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("→ 409")) {
      console.log(`[daemon] claim lost for ${runId} (already claimed) — skipping`);
    } else {
      console.error(`[daemon] claim ${runId} failed:`, msg.slice(0, 200));
    }
    return false;
  }
}

// Find the next daemon-owned run to drive.
//
// Primary source is QUEUED runs, which must be claimed atomically via
// POST /runs/{id}/start. As a recovery path, also consider RUNNING/RECOVERING
// runs for the same daemon-owned flows: a manual /agent/{id}/resume or
// supervisor recovery can legitimately leave the backend in RUNNING while no
// browser is actively driving. In that case the daemon must re-attach and
// continue from current_step_index instead of waiting forever.
async function findPendingRun() {
  const statuses = ["queued", "running", "recovering"];
  const buckets = await Promise.all(
    statuses.map((status) => fetchJson(`${BACKEND}/v1/runs?limit=50&status=${status}`)),
  );
  const items = buckets.flatMap((list) => (Array.isArray(list) ? list : list.items || []));
  const watched = items.filter((r) => {
    if (!r.origin) return false;
    // Webhook/reconciler-driven LinkedIn flows (by event_kind) AND any run the
    // extension explicitly enqueued for the daemon (execution_target=="daemon").
    const isWatched = r.origin.event_kind === "new_job_position"
      || r.origin.event_kind === "linkedin_lead_search"
      || r.origin.execution_target === "daemon";
    if (!isWatched) return false;
    // Operator routing: only claim runs targeted at THIS daemon's operator.
    // LinkedIn flows are pinned to the LinkedIn operator (e.g. "fernanda");
    // dashboard runs are pinned to the requesting operator. A mismatch (incl.
    // an untargeted run when this daemon has an OPERATOR_ID) is left for the
    // owning daemon to claim.
    if ((r.origin.target_operator || "") !== OPERATOR_ID) return false;
    if (Array.isArray(r.extracted_data) && r.extracted_data.length > 0) return false;
    if (r.status === "queued" && r.current_step_index > 0) return false;
    return true;
  });
  if (watched.length === 0) return null;
  // Oldest first (FIFO). The list endpoint orders created_at DESC, so sort
  // ascending here and take the head.
  watched.sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    return ta - tb;
  });
  return watched[0];
}

// ── Blocker detection (detect on EVERY navigation; pause, don't plow) ────────

// Distinct error so callers can tell a LinkedIn wall apart from a transient
// network failure. Carries the blocker kind for circuit-breaker bookkeeping.
class BlockerError extends Error {
  constructor(blockerType, soft = false) {
    super(`LinkedIn blocker: ${blockerType}`);
    this.name = "BlockerError";
    this.blockerType = blockerType;
    this.soft = soft;
  }
}

// detectChallengeInPage / isBlockerUrl are imported from
// ./src/behavior/blocker-detect.mjs (unit-tested against fixture pages).

// Throw BlockerError if the current page is a wall. Checks URL patterns first
// (cheap), then the DOM. Used after every navigation.
async function assertNoBlocker(page, label) {
  let url = "";
  try { url = page.url(); } catch {}
  if (isBlockerUrl(url)) throw new BlockerError("checkpoint");
  const dom = await detectChallengeInPage(page);
  if (dom) throw new BlockerError(dom.type);
}

// Single navigation helper: goto → record page-load → blocker check. Replaces
// every raw page.goto in the daemon so a wall on ANY navigation pauses the run.
// ── Per-step screenshots (QA visibility) ─────────────────────────────────────
// The host runs Chrome in a non-interactive session with NO viewable desktop,
// so screenshots posted to the backend are the only way to *see* what the bot
// saw. Every navigation (safeGoto) uploads a PNG as an artifact, viewable in the
// dashboard (GET /v1/runs/{id}/artifacts → /v1/artifacts/{id}). Non-fatal and
// gated by STEP_SHOTS (default on); a screenshot must never break a live scrape.
const STEP_SHOTS = process.env.STEP_SHOTS !== "0";
const STEP_SHOT_SETTLE_MS = Number(process.env.STEP_SHOT_SETTLE_MS || "700");
let navSeq = 0;
function resetStepShots() { navSeq = 0; }
async function uploadStepShot(page, label) {
  if (!STEP_SHOTS || !drivingRunId) return;
  const seq = navSeq++;
  try {
    if (STEP_SHOT_SETTLE_MS > 0) await page.waitForTimeout(STEP_SHOT_SETTLE_MS).catch(() => {});
    // Drop the "automation running" overlay so the capture shows the real page,
    // not our dark backdrop; it auto-re-shows on the next document, and we also
    // re-show it explicitly below.
    await page.evaluate(() => window.__sr_overlay__ && window.__sr_overlay__.hide()).catch(() => {});
    const buf = await Promise.race([
      Promise.resolve().then(() => page.screenshot({ fullPage: false })).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 6000)),
    ]);
    await page.evaluate(() => window.__sr_overlay__ && window.__sr_overlay__.show(0, 0, "", "Automatización en curso — no interactúes")).catch(() => {});
    if (!buf) return;
    const safeLabel = (label || "page").replace(/[^a-z0-9._:-]/gi, "_");
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type: "image/png" }), `${String(seq).padStart(2, "0")}-${safeLabel}.png`);
    const url = `${BACKEND}/v1/runs/${drivingRunId}/artifacts?step_index=${seq}&artifact_type=page_capture`;
    await fetch(url, { method: "POST", headers: { "X-API-Key": API_KEY }, body: fd });
    dbg(`[STEP SHOT] seq=${seq} label="${label}" ${buf.length}B`);
  } catch (e) { dbg(`step shot failed: ${e.message || e}`); }
}

// ── Hardcoded-flow manifest (legibility) ─────────────────────────────────────
// The daemon's preamble flow is hardcoded (not a recorded workflow), so we emit
// a human-readable manifest of the steps it WILL run, as a flow_manifest JSON
// artifact. The dashboard renders it so a reviewer can see what the daemon does
// at each step — and map it to the per-step screenshots (same indices/labels).
function buildFlowManifest(isLeadRun, jobTitle) {
  const steps = [
    { index: 0, action: "navigate", label: "feed",
      desc: "Calentamiento: abre el feed de LinkedIn (un usuario real no entra en frío a la búsqueda)." },
    { index: 1, action: "noise_break", label: "idle",
      desc: "Ruido humano: scroll variado + pausa de lectura (el cursor no se congela)." },
    { index: 2, action: "navigate", label: "search-p1",
      desc: `Búsqueda de personas, página 1: tipea "${jobTitle}" en el buscador global y aplica el filtro People.` },
    { index: 3, action: "extract", label: "scrape-p1",
      desc: isLeadRun
        ? "Extrae nombre + headline + URL de perfil de los resultados de la página 1."
        : "Extrae las URLs de perfil (/in/) de la página 1." },
    { index: 4, action: "navigate", label: "search-p2",
      desc: "Navega a la página 2 de resultados." },
    { index: 5, action: "extract", label: "scrape-p2",
      desc: isLeadRun
        ? "Extrae nombre + headline + URL de la página 2; el run completa (NO visita perfiles)."
        : "Extrae las URLs de perfil de la página 2." },
  ];
  if (!isLeadRun) {
    steps.push({ index: 6, action: "for_each", label: "candidates",
      desc: "Por cada candidato: visita el perfil y scrapea sus secciones (about, experiencia, skills, educación, certificaciones), luego hace push a Odoo." });
  }
  return { flow: isLeadRun ? "linkedin_lead_search" : "new_job_position", job_title: jobTitle, hardcoded: true, steps };
}

async function uploadFlowManifest(runId, manifest) {
  try {
    const fd = new FormData();
    fd.append("file", new Blob([JSON.stringify(manifest)], { type: "application/json" }), "flow_manifest.json");
    await fetch(`${BACKEND}/v1/runs/${runId}/artifacts?artifact_type=flow_manifest`, {
      method: "POST", headers: { "X-API-Key": API_KEY }, body: fd,
    });
    dbg(`[FLOW MANIFEST] ${manifest.steps.length} steps uploaded`);
  } catch (e) { dbg(`flow manifest upload failed: ${e.message || e}`); }
}

// Fetch the user's browser cookies (uploaded by the extension as a session_cookies
// artifact when "Load browser session" is ON) and DELETE the artifact immediately
// so the session tokens live only seconds in the backend. Retries briefly because
// the daemon may claim the queued run a beat before the extension's upload lands.
async function loadAndConsumeSessionCookies(runId) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const list = await fetchJson(`${BACKEND}/v1/runs/${runId}/artifacts`);
      const arr = Array.isArray(list) ? list : (list.items || []);
      const meta = arr.find((a) => a.artifact_type === "session_cookies");
      if (meta) {
        const res = await fetch(`${BACKEND}/v1/artifacts/${meta.id}`, { headers: { "X-API-Key": API_KEY } });
        const cookies = await res.json();
        await fetch(`${BACKEND}/v1/artifacts/${meta.id}`, { method: "DELETE", headers: { "X-API-Key": API_KEY } }).catch(() => {});
        return Array.isArray(cookies) ? cookies : [];
      }
    } catch (e) { dbg(`session cookies fetch failed: ${e.message || e}`); }
    await sleep(1000);
  }
  dbg("[SESSION] no session_cookies artifact found — running unauthenticated");
  return [];
}

async function safeGoto(page, url, label) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  recordPageLoad();
  await assertNoBlocker(page, label);
  await uploadStepShot(page, label).catch(() => {});
}

// ── Per-account budget + circuit breaker (gitignored sidecar) ────────────────
//
// State lives in extension/.linkedin-budget.json, keyed by the profile dir;
// logic is in ./src/behavior/account-state.mjs (unit-tested separately).

const WORK_START_HOUR = Number(process.env.WORK_START_HOUR || "8");
const WORK_END_HOUR = Number(process.env.WORK_END_HOUR || "19");
const WORK_DAYS = (process.env.WORK_DAYS || "1,2,3,4,5").split(",").map((s) => Number(s.trim()));
const BASE_COOLDOWN_MS = Number(process.env.BASE_COOLDOWN_MS || `${20 * 60_000}`);
const COOLDOWN_JITTER_MS = Number(process.env.COOLDOWN_JITTER_MS || `${20 * 60_000}`);

const account = createAccountStateStore({
  file: path.resolve(__dirname, ".linkedin-budget.json"),
  accountId: path.basename(PROFILE_DIR),
  limits: {
    profileViewsPerDay: Number(process.env.MAX_PROFILE_VIEWS_DAY || "80"),
    profileViewsPerHour: Number(process.env.MAX_PROFILE_VIEWS_HOUR || "18"),
    searchesPerDay: Number(process.env.MAX_SEARCHES_DAY || "30"),
    pageLoadsPerDay: Number(process.env.MAX_PAGE_LOADS_DAY || "500"),
  },
  work: { startHour: WORK_START_HOUR, endHour: WORK_END_HOUR, days: WORK_DAYS, enabled: process.env.RESPECT_WORKING_HOURS !== "0" },
});

// Thin wrappers so call sites stay terse + sidecar I/O errors don't crash the
// daemon (a budget write failure must never abort a live scrape).
function recordPageLoad() { try { account.recordPageLoad(); } catch (e) { console.error("[budget]", e.message); } }
function recordProfileView() { try { account.recordProfileView(); } catch (e) { console.error("[budget]", e.message); } }
function recordSearch() { try { account.recordSearch(); } catch (e) { console.error("[budget]", e.message); } }
function budgetExhaustedReason() { try { return account.budgetExhaustedReason(); } catch { return null; } }
function circuitOpen() { try { return account.circuitOpen(); } catch { return false; } }
function isWithinWorkingHours() { try { return account.isWithinWorkingHours(); } catch { return true; } }

// Circuit detail for the heartbeat so the dashboard can show *why* the account
// is in cooldown and until when, not just a boolean.
function circuitInfo() {
  try {
    const c = account.circuit();
    const open = account.circuitOpen();
    return {
      circuit_open: open,
      circuit_reason: open ? (c.last_trip_kind || null) : null,
      cooldown_until: open && c.open_until ? new Date(c.open_until).toISOString() : null,
    };
  } catch {
    return { circuit_open: false, circuit_reason: null, cooldown_until: null };
  }
}

function tripCircuit(kind, soft = false) {
  try {
    const c = account.tripCircuit(kind, soft);
    const hrs = (c.cooldown_ms / 3600_000).toFixed(0);
    console.error(`[CIRCUIT OPEN] account=${path.basename(PROFILE_DIR)} kind=${kind} soft=${soft} trips=${c.consecutive_trips} cooldown=${hrs}h until=${new Date(c.open_until).toISOString()}`);
    if (c.consecutive_trips >= 4) console.error(`[CIRCUIT OPEN] !! ${c.consecutive_trips} consecutive trips — needs manual review of this account`);
  } catch (e) {
    console.error("[circuit] trip failed:", e.message);
  }
}

let nextRunNotBefore = 0;

async function getRun(runId) {
  return fetchJson(`${BACKEND}/v1/runs/${runId}`);
}

async function getWorkflow(workflowId) {
  return fetchJson(`${BACKEND}/v1/workflows/${workflowId}`);
}

async function postExtraction(runId, stepIndex, profileUrl, data) {
  await fetchJson(`${BACKEND}/v1/runs/${runId}/extraction`, {
    method: "POST",
    body: JSON.stringify({ step_index: stepIndex, data: [data], url: profileUrl }),
  });
}

async function reportStepResult(runId, stepIndex, actionType) {
  try {
    await fetchJson(`${BACKEND}/v1/runs/${runId}/step-result`, {
      method: "POST",
      body: JSON.stringify({ step_index: stepIndex, action_type: actionType, success: true }),
    });
  } catch (err) {
    if (String(err).includes("409")) {
      const run = await getRun(runId).catch(() => null);
      if (run && (run.current_step_index > stepIndex || run.status === "completed")) {
        return;
      }
    }
    throw err;
  }
}

async function fetchMessageTargets(runId) {
  return fetchJson(`${BACKEND}/v1/runs/${runId}/message-targets`);
}

// Connection-Request-with-Note flow. LinkedIn gates direct Message
// behind 1st-degree / InMail; Connect with optional 300-char note is
// available on almost any profile. Open the modal, paste the rendered
// outreach text, do NOT click Send.
async function composeDraftInPage(page, message) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 200)).catch(() => {});
    await page.waitForSelector(
      '[data-view-name="profile-top-card"], section[componentkey*="Topcard"], main h1, main h2',
      { timeout: 35000 },
    );
  } catch {
    return { ok: false, reason: "top_card_not_found" };
  }
  const trimmed = (message || "").slice(0, 300);
  // Shared canonical in-page logic (connect → dialog → note textarea → focus+clear).
  // The note is typed below with real keystroke timing so LinkedIn sees genuine
  // keydown/input events rather than a one-shot value set.
  const result = await page.evaluate(prepareConnectNoteDialog);

  if (result && result.ok && result.ready) {
    const ta = page.locator(NOTE_TEXTAREA_SELECTOR).first();
    await ta.click({ timeout: 3000 }).catch(() => { /* keep in-page focus */ });
    await typeHumanLike(page, trimmed);
    await sleep(200 + Math.floor(Math.random() * 300));
  }
  return result;
}

async function expandForEach(runId, stepIndex) {
  return fetchJson(`${BACKEND}/v1/runs/${runId}/expand-for-each`, {
    method: "POST",
    body: JSON.stringify({ step_index: stepIndex }),
  });
}

// ── Stealth init ────────────────────────────────────────────────────────────
// STEALTH_INIT now lives in ./src/shared/stealth.mjs (minimal, consistent set
// for a real Chrome on this machine). See that module for the rationale.

// ── Human-input primitives (Playwright `page.mouse.*` → trusted events) ──────
// Bezier mouse travel, trusted "Show all" clicks, seeded scrolling, and
// Show-all section discovery live in ./src/behavior/page-nav.mjs (unit-tested
// against fixture pages). One factory instance holds the per-page cursor state.
const { moveMouseAlongBezier, clickSectionLink, humanScrollSeeded, getShowAllSections } = createPageNav();

// Type text into the currently-focused element one character at a time with
// human-ish inter-key jitter (40-160ms), so LinkedIn sees real keystroke
// timing instead of an instantaneous value injection. `page.keyboard.type`
// dispatches trusted key events. Used for the search box and the connect note.
async function typeHumanLike(page, text, rand = Math.random) {
  for (const ch of text) {
    try { await page.keyboard.type(ch); } catch { /* ignore */ }
    await sleep(40 + Math.floor(rand() * 120));
  }
}

// A "reading" dwell that, instead of freezing the cursor for the whole period,
// breaks the wait into chunks interleaved with occasional micro mouse moves and
// stray scrolls — what a person idly does while reading a section. Total wall
// time ≈ `ms`.
async function dwellWithJitter(page, ms, rand) {
  let remaining = Math.max(0, ms | 0);
  while (remaining > 0) {
    const chunk = Math.min(remaining, 700 + Math.floor(rand() * 1500));
    await sleep(chunk);
    remaining -= chunk;
    if (remaining <= 0) break;
    const r = rand();
    if (r < 0.5) {
      try { await moveMouseAlongBezier(page, { x: 400 + rand() * 500, y: 250 + rand() * 350 }, rand); } catch { /* ignore */ }
    } else if (r < 0.7) {
      try { await page.mouse.wheel(0, (rand() > 0.5 ? 1 : -1) * (80 + Math.floor(rand() * 160))); } catch { /* ignore */ }
    }
  }
}

async function scrapeSearchProfileUrls(page) {
  await page.waitForSelector('a[href*="/in/"]', { timeout: 30000 }).catch(() => {});
  await humanScrollSeeded(page, 3 + Math.floor(Math.random() * 3), Math.random);
  const urls = await page.evaluate(() => {
    const out = new Set();
    document.querySelectorAll('a[href*="/in/"]').forEach((a) => {
      const href = a.getAttribute("href") || "";
      const m = href.match(/https?:\/\/[^"' ]*linkedin\.com\/in\/[^?#"' ]+/);
      if (m) out.add(m[0].replace(/\/$/, ""));
      else if (href.startsWith("/in/")) out.add(`https://www.linkedin.com${href.split("?")[0].split("#")[0]}`.replace(/\/$/, ""));
    });
    return Array.from(out);
  });
  return urls.filter((u) => /linkedin\.com\/in\/[A-Za-z0-9_\-%\.]+$/.test(u));
}

// Lead-sourcing variant: pull { name, headline, profile_url } per search-result
// without visiting any profile. LinkedIn renders the people-search list in two
// shapes depending on how you arrived:
//   (A) typed search / cold load → `[data-view-name="people-search-result"]`
//       cards, each wrapping the result avatar <img alt="Full Name"> + <p>
//       lines: "Name • Nº", headline, location, "Actual: …", followers,
//       "<X> es contacto en común".
//   (B) in-session navigation (e.g. page 2 reached while already in the SPA) →
//       NO people-search-result cards, but `search-result-lockup-title` +
//       `search-result-social-proof-insight` (the mutual-connection line) and
//       the same result avatars.
// Both shapes have ONE result avatar per person whose `alt` is the clean name,
// wrapped by the profile link. Mutual-connection links live inside the
// social-proof element (and have no result avatar). So we anchor on result
// avatars and skip anything inside social-proof — layout-agnostic and free of
// the mutual-connection noise.
async function scrapeSearchPeople(page) {
  // Wait for results (cards OR lockups OR any /in/ link), then let the count
  // stabilize so a mid-render snapshot doesn't miss half the page.
  await page.waitForSelector(
    '[data-view-name="people-search-result"], [data-view-name="search-result-lockup-title"], a[href*="/in/"]',
    { timeout: 20000 },
  ).catch(() => {});
  let prev = -1, stable = 0;
  for (let i = 0; i < 10; i++) {
    const n = await page.evaluate(() =>
      document.querySelectorAll('[data-view-name="people-search-result"], [data-view-name="search-result-lockup-title"]').length
    ).catch(() => 0);
    if (n > 0 && n === prev) { if (++stable >= 2) break; } else { stable = 0; }
    prev = n;
    await sleep(700);
  }
  await humanScrollSeeded(page, 3 + Math.floor(Math.random() * 3), Math.random);
  const people = await page.evaluate(() => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const PROFILE_RE = /linkedin\.com\/in\/[A-Za-z0-9_\-%\.]+/;
    const canon = (href) => {
      const m = (href || "").match(/https?:\/\/[^"' ]*linkedin\.com\/in\/[^?#"' ]+/);
      let u = m ? m[0] : ((href || "").startsWith("/in/")
        ? `https://www.linkedin.com${href.split("?")[0].split("#")[0]}` : "");
      return u.replace(/\/$/, "");
    };
    // "Jane Doe • 2º" -> "Jane Doe"; also strips a trailing bare degree badge
    // and any " busca empleo" / "is hiring"-style suffix LinkedIn appends.
    const nameOf = (s) => clean(s)
      .split("•")[0]
      .replace(/\s*\d+(º|°|st|nd|rd|th)\s*$/i, "")
      .replace(/\s+(busca empleo|is hiring|está contratando|is open to work|open to work|disponible para trabajar|abierto a trabajar|#\w+).*$/i, "")
      .trim();
    const isMeta = (t) =>
      !t
      || /(contacto en común|mutual connection|in common)/i.test(t)
      || /seguidor|\bfollowers?\b/i.test(t)
      || /^(conectar|connect|seguir|follow|mensaje|message|guardar|save|pendiente|pending)$/i.test(t)
      || /^(actual|anterior|current|past)\s*:/i.test(t)
      || /•\s*\d+\s*(º|°|st|nd|rd|th)/i.test(t);
    const looksLikeLocation = (t) =>
      /,\s*[^,]+,/.test(t) && !/\bat\b|@|\||engineer|developer|manager|ingenier|desarroll|specialist|lead|architect|consultant|analyst|designer|scientist/i.test(t);
    const inSocialProof = (el) =>
      !!(el && el.closest && el.closest('[data-view-name="search-result-social-proof-insight"]'));

    const seen = new Set();
    const out = [];
    const headlineFrom = (root, name) => {
      const lines = Array.from(root.querySelectorAll("p, span"))
        .map((e) => clean(e.textContent)).filter(Boolean);
      for (const t of lines) {
        if (nameOf(t) === name) continue;
        if (isMeta(t) || looksLikeLocation(t)) continue;
        return t;
      }
      return "";
    };

    // Primary: explicit result cards (page 1 / cold load) — richest structure.
    const addCard = (card) => {
      const link = card.querySelector('a[href*="/in/"]');
      if (!link) return;
      const url = canon(link.getAttribute("href") || "");
      if (!url || !PROFILE_RE.test(url) || seen.has(url)) return;
      const ps = Array.from(card.querySelectorAll("p")).map((p) => clean(p.textContent)).filter(Boolean);
      let name = nameOf(clean(card.querySelector("img")?.getAttribute("alt") || ""));
      if (!name && ps[0]) name = nameOf(ps[0]);
      if (!name) return;
      let headline = "";
      for (let i = 1; i < ps.length; i++) {
        const t = ps[i];
        if (nameOf(t) === name || isMeta(t) || looksLikeLocation(t)) continue;
        headline = t; break;
      }
      seen.add(url);
      out.push({ name, headline, profile_url: url });
    };

    const cards = Array.from(document.querySelectorAll('[data-view-name="people-search-result"]'));
    if (cards.length) {
      cards.forEach(addCard);
      return out;
    }

    // Secondary (layout B / DOM drift): anchor on result avatars. The result
    // avatar's alt is the full name and it is wrapped by the profile link;
    // mutual-connection avatars/links sit inside the social-proof element.
    document.querySelectorAll('img[alt]').forEach((img) => {
      const alt = clean(img.getAttribute("alt"));
      if (!alt || inSocialProof(img)) return;
      const link = img.closest('a[href*="/in/"]')
        || (img.parentElement && img.parentElement.querySelector('a[href*="/in/"]'));
      if (!link || inSocialProof(link)) return;
      const url = canon(link.getAttribute("href") || "");
      if (!url || !PROFILE_RE.test(url) || seen.has(url)) return;
      const name = nameOf(alt);
      if (!name) return;
      // Climb to the result container (holds avatar link + a couple <p> lines).
      let root = link;
      for (let i = 0; i < 6 && root.parentElement; i++) {
        root = root.parentElement;
        if (root.querySelectorAll("p").length >= 2) break;
      }
      seen.add(url);
      out.push({ name, headline: headlineFrom(root, name), profile_url: url });
    });
    return out;
  });
  return people;
}

async function scrapeProfileTopCard(page, url, rand = Math.random) {
  // The `navigate` step usually already landed us on the profile; only goto if
  // we're not already there (avoids a redundant double-load of the main page,
  // itself a bot tell). safeGoto is used so a wall here still pauses the run.
  const base = url.replace(/\/$/, "");
  if (!page.url().replace(/\/$/, "").startsWith(base)) {
    await safeGoto(page, url, "topcard");
  }
  try { await page.waitForSelector('[data-view-name="profile-top-card"], section[componentkey*="Topcard"]', { timeout: 20000, state: "attached" }); } catch {}
  await sleep(jitter(2500, 1500));
  await humanScrollSeeded(page, 2 + Math.floor(rand() * 3), rand);
  try { await page.waitForSelector('[data-view-name="profile-card-about"]', { timeout: 6000, state: "attached" }); } catch {}
  await sleep(jitter(1500, 1000));

  return await page.evaluate(() => {
    const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
    const txt = (el) => clean(el?.textContent || "");
    const topCard = document.querySelector('[data-view-name="profile-top-card"]') || document.querySelector('section[componentkey*="Topcard"]');
    let full_name = "";
    if (topCard) { const h2 = topCard.querySelector("h2"); if (h2) full_name = txt(h2); }
    const DEGREE_RE = /^[·•]?\s*\d+(?:er|º|st|nd|rd|th)\s*$/;
    let headline = "";
    if (topCard) {
      const ps = Array.from(topCard.querySelectorAll("p")).filter((p) => p.children.length === 0);
      for (const p of ps) {
        const t = clean(p.textContent);
        if (!t || t === full_name || DEGREE_RE.test(t) || /^[·•]/.test(t)) continue;
        if (t.length < 5 || t.length > 250) continue;
        headline = t; break;
      }
    }
    let about = "";
    const aboutEl = document.querySelector('[data-view-name="profile-card-about"]');
    if (aboutEl) about = clean(aboutEl.textContent);
    about = about.replace(/^(About|Acerca de|Sobre)(?:\s*\1)?/i, "").trim().slice(0, 4000);
    let location = "";
    if (topCard) {
      const ps = Array.from(topCard.querySelectorAll("p")).filter((p) => p.children.length === 0);
      for (const p of ps) {
        const t = clean(p.textContent);
        if (!t || t === full_name || t === headline || DEGREE_RE.test(t)) continue;
        if (/Area|Region|City|Metropolitan|País|Country|Greater/i.test(t)) { location = t; break; }
      }
    }
    return { full_name, headline, about, location };
  });
}

// Extract the experience paras/desc from the CURRENT page (the
// /details/experience/ subpage). Navigation is handled by visitSection.
async function extractExperienceParas(page) {
  return await page.evaluate(experienceParasCore);
}

// Extract structured list items from the CURRENT page (a /details/<section>/
// subpage). Navigation is handled by visitSection.
async function extractSectionListItems(page) {
  return await page.evaluate(sectionListItemsCore);
}

// Extract raw section text from the CURRENT page (a /details/<section>/
// subpage) for AI extraction. Navigation is handled by visitSection.
async function extractSubpageText(page, section) {
  return await page.evaluate(subpageTextCore, section);
}

async function aiExtractByShape(shape, rawText) {
  if (!OPENAI_API_KEY || !rawText || rawText.length < 12) return null;
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Extract structured LinkedIn profile data. Output strict JSON. Copy values verbatim." },
          { role: "user", content: `${shapeToPrompt(shape)}\n\n--- Input ---\n${rawText.slice(0, 5000)}` },
        ],
        response_format: { type: "json_schema", json_schema: { name: shape.key, schema: shapeToSchema(shape), strict: true } },
        temperature: 0,
      }),
    });
    const b = await r.json();
    if (!r.ok) { console.warn(`[ai] ${shape.key} HTTP ${r.status}`); return null; }
    return JSON.parse(b.choices[0].message.content);
  } catch (err) { console.warn(`[ai] ${shape.key} err`, err.message); return null; }
}

function defaultProfileShapes() {
  return [
    { key: "about", label: "About", kind: "scalar", item_keys: null },
    { key: "experience", label: "Experience", kind: "record_list", item_keys: ["title", "company", "employment_type", "dates", "duration", "location", "description"] },
    { key: "education", label: "Education", kind: "record_list", item_keys: ["school", "degree", "field", "dates"] },
    { key: "skills", label: "Skills", kind: "string_list", item_keys: null, extract_hints: "Extract skill names only. Skip filter tabs and company/job context." },
    { key: "certifications", label: "Certifications", kind: "record_list", item_keys: ["name", "issuer", "issued"] },
    { key: "projects", label: "Projects", kind: "record_list", item_keys: ["name", "dates", "description"] },
    { key: "courses", label: "Courses", kind: "string_list", item_keys: null },
    { key: "languages", label: "Languages", kind: "string_list", item_keys: null },
  ];
}

// Deterministic 32-bit string hash → PRNG seed.
function seedFromString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Navigate to ONE /details/<section>/ subpage like a human — preferring a
// trusted click on the in-page "Show all" anchor (bezier mouse travel), with a
// page.goto fallback when the anchor isn't present — then extract everything
// that subpage offers in a SINGLE visit (list items + raw text, plus the
// experience paras for the experience page). Replaces the old per-extraction
// goto's that visited the same subpage 2-3×. Throws BlockerError up if a wall
// is hit. Returns empty data on transient nav failure (full extraction is
// best-effort per section, matching prior behavior).
async function visitSection(page, profileBase, section, rand, showAllSet) {
  const slug = (profileBase.match(/\/in\/([^/]+)/) || [])[1] || "";
  const sectionPath = `/in/${slug}/details/${section}/`;
  const sectionUrl = `${profileBase.replace(/\/$/, "")}/details/${section}/`;
  const empty = { listItems: [], rawText: "", expParas: [] };

  // Short jittered "read, then click" pause.
  await sleep(600 + Math.floor(rand() * 1400));

  let navigated = false;
  if (showAllSet.has(sectionPath)) {
    const clicked = await clickSectionLink(page, sectionPath, rand);
    if (clicked) {
      await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
      await sleep(800 + Math.floor(rand() * 800));
      // Confirm the click actually landed on the section page; if a blocker
      // intercepted, detect it here too.
      await assertNoBlocker(page, `section-click:${section}`);
      if (new RegExp(`/details/${section}/?`).test(page.url())) navigated = true;
    }
  }
  if (!navigated) {
    try {
      await safeGoto(page, sectionUrl, `section:${section}`);
    } catch (err) {
      if (err instanceof BlockerError) throw err;
      return empty;
    }
  }

  await sleep(1500 + Math.floor(rand() * 1500));
  await humanScrollSeeded(page, 1 + Math.floor(rand() * 3), rand);

  const listItems = await extractSectionListItems(page).catch(() => []);
  const rawText = await extractSubpageText(page, section).catch(() => "");
  const expParas = section === "experience"
    ? await extractExperienceParas(page).catch(() => [])
    : [];

  // Reading dwell — broken up with micro mouse moves / stray scrolls so the
  // cursor isn't frozen, which is what a person reading a section looks like.
  await dwellWithJitter(page, pickDwellMs(3000, 10000, rand), rand);
  return { listItems, rawText, expParas };
}

async function scrapeProfileFull(page, url, extractShapes = []) {
  // Per-profile seed mixes the URL with wall-clock so the same profile isn't
  // replayed with an identical behavior signature across runs.
  const rand = mulberry32((seedFromString(url) ^ (Date.now() & 0xffffffff)) >>> 0);

  const top = await scrapeProfileTopCard(page, url, rand);
  const requestedShapes = extractShapes.length > 0 ? extractShapes : defaultProfileShapes();
  const result = {
    page_title: top.full_name ? `${top.full_name} | LinkedIn` : "",
    full_name: top.full_name || "",
    headline: top.headline || "",
    location: top.location || "",
    about: top.about || "",
  };

  // Which /details/<section>/ subpages we need (full extraction — every
  // requested section, deduped). about/full_name/headline/location come from
  // the top card and need no subpage.
  const TOPCARD_KEYS = new Set(["about", "full_name", "headline", "location"]);
  const neededSections = [...new Set(
    requestedShapes
      .map((s) => s?.key)
      .filter((k) => k && !TOPCARD_KEYS.has(k))
      .map((k) => (k === "top_skills" ? "skills" : k)),
  )];

  // Inspect the loaded profile for which sections expose a "Show all" anchor,
  // then visit each needed section ONCE, in a shuffled order (a real recruiter
  // doesn't open sections in a fixed sequence).
  const showAll = await getShowAllSections(page, url);
  const visitOrder = shuffleInPlace([...neededSections], rand);
  const sectionData = new Map();
  for (const section of visitOrder) {
    sectionData.set(section, await visitSection(page, url, section, rand, showAll));
  }

  for (const shape of requestedShapes) {
    if (!shape?.key) continue;
    if (shape.key === "about") { result.about = top.about || defaultEmptyValue(shape); continue; }
    if (shape.key === "full_name") { result.full_name = top.full_name || defaultEmptyValue(shape); continue; }
    if (shape.key === "headline") { result.headline = top.headline || defaultEmptyValue(shape); continue; }
    if (shape.key === "location") { result.location = top.location || defaultEmptyValue(shape); continue; }

    const sectionKey = shape.key === "top_skills" ? "skills" : shape.key;
    const data = sectionData.get(sectionKey) || { listItems: [], rawText: "", expParas: [] };

    if (shape.key === "experience") {
      const parsedExperience = parseExperienceItems(data.expParas);
      if (parsedExperience.length > 0) {
        result.experience = parsedExperience;
      } else {
        result.experience = parseExperienceItems(
          data.listItems.map((item) => ({ paras: item.texts || [], desc: "" })),
        );
      }
      continue;
    }

    const parsed = await aiExtractByShape(shape, data.rawText);
    if (parsed?.[shape.key]) { result[shape.key] = parsed[shape.key]; continue; }

    if (sectionKey === "skills") { result[shape.key] = parseSkillItems(data.listItems); continue; }
    if (sectionKey === "education") { result[shape.key] = parseEducationItems(data.listItems); continue; }
    if (sectionKey === "certifications") { result[shape.key] = parseCertificationItems(data.listItems); continue; }
    if (sectionKey === "projects") { result[shape.key] = parseProjectItems(data.listItems); continue; }
    if (sectionKey === "courses" || sectionKey === "languages") { result[shape.key] = parseSimpleListItems(data.listItems); continue; }
    result[shape.key] = defaultEmptyValue(shape);
  }
  return result;
}

// Generic-schema extract strategy: pull the requested shapes out of the CURRENT
// page's text via the same per-shape AI extractor scrapeProfileFull uses — but
// with NO LinkedIn structure (no /details/ subpage navigation, no top-card, no
// site-specific parsers). For a recorded non-profile extract step where the page
// already holds the data. Empty shapes → just page_title + url.
async function scrapeGenericByShapes(page, url, extractShapes = []) {
  const pageText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  const result = {
    page_title: await page.title().catch(() => ""),
    url,
  };
  for (const shape of extractShapes) {
    if (!shape?.key) continue;
    const parsed = await aiExtractByShape(shape, pageText);
    result[shape.key] = parsed && parsed[shape.key] != null ? parsed[shape.key] : defaultEmptyValue(shape);
  }
  return result;
}

// ── Run driver ──────────────────────────────────────────────────────────────

// Reach the People search results the way a human does: click the global
// search box, type the query with keystroke timing, press Enter, then click the
// "People" filter pill (bezier travel + trusted click). Deep-links to the
// people-results URL as a fallback if any step fails or we don't end up on a
// people page, so the pipeline never breaks. Returns the URL we landed on.
// Throws BlockerError up if a wall is hit (handled by the outer driveRun catch).
async function navigateToPeopleSearch(page, jobTitle, deepLinkUrl, rand) {
  const onPeople = () => /\/search\/results\/people/.test(page.url());
  try {
    // 1. Focus the global typeahead search box and type the query like a person.
    const box = page.locator(
      'input.search-global-typeahead__input, input[aria-label="Search" i], input[placeholder="Search" i], input[aria-label="Buscar" i], input[placeholder="Buscar" i]',
    ).first();
    await box.click({ timeout: 8000 });
    await sleep(300 + Math.floor(rand() * 500));
    // Clear any pre-filled text, then type with keystroke timing.
    try {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.press("Backspace");
    } catch { /* ignore */ }
    await typeHumanLike(page, jobTitle, rand);
    await sleep(300 + Math.floor(rand() * 600));
    await page.keyboard.press("Enter");
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
    recordPageLoad();
    await assertNoBlocker(page, "search-typed");
    await sleep(jitter(2000, 1500));

    // 2. Narrow to People by clicking the filter pill (a real in-page click,
    //    not a deep-link). Enter from the typeahead lands on /search/results/all/.
    if (!onPeople()) {
      const target = await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const isPeople = (t) => /^(people|personas)$/i.test((t || "").trim());
        const el = Array.from(document.querySelectorAll('button, a[role="button"], a'))
          .find((e) => isPeople(e.innerText || e.textContent)
            || /\/search\/results\/people/.test(e.getAttribute("href") || ""));
        if (!el) return null;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(400);
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      if (target) {
        await moveMouseAlongBezier(page, target, rand);
        await sleep(80 + Math.floor(rand() * 140));
        await page.mouse.click(target.x, target.y);
        await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
        recordPageLoad();
        await assertNoBlocker(page, "search-people-filter");
        await sleep(jitter(1500, 1200));
      }
    }
    if (onPeople()) return page.url();
  } catch (err) {
    if (err instanceof BlockerError) throw err;
    // Any non-blocker failure (selector drift, timeout): fall back to the
    // deep-link so extraction can still proceed.
  }
  await safeGoto(page, deepLinkUrl, "search-p1-fallback");
  return deepLinkUrl;
}

// Click a search-results "Next" pagination control like a human (bezier travel
// + trusted click) instead of deep-linking ?page=2. Returns false → goto fallback.
async function clickPaginationNext(page, rand) {
  try {
    const target = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const btn = document.querySelector(
        'button[aria-label="Next"], button[aria-label="Siguiente"], a[aria-label="Next"], a[aria-label="Siguiente"]',
      );
      if (!btn) return null;
      btn.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(500);
      const r = btn.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (!target) return false;
    await moveMouseAlongBezier(page, target, rand);
    await sleep(80 + Math.floor(rand() * 140));
    await page.mouse.click(target.x, target.y);
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
    recordPageLoad();
    await assertNoBlocker(page, "search-next");
    return true;
  } catch (err) {
    if (err instanceof BlockerError) throw err;
    return false;
  }
}

// Noise navigation between profiles — honors the backend's noise contract
// (_noise_kind / _noise_seed). Mirrors the extension's executeNoiseBreak.
async function executeNoiseBreakDaemon(page, kind, seed, lastSearchUrl, seenPool) {
  const rand = mulberry32((Number(seed) >>> 0) || 1);
  const nav = async (url) => {
    if (!url) return;
    await safeGoto(page, url, `noise:${kind}`);
  };
  // Scroll-tick / dwell formulas live in pickNoiseScrollTicks / pickNoiseDwellMs
  // (stealth-core.mjs) — moved verbatim, called in the SAME position so the
  // rand-draw order is byte-for-byte identical (seed-equivalence-tested). Noise
  // URLs stay runtime: the backend can't know lastSearchUrl / seenPool, only the
  // static feed URL (so feed_scroll's URL is the one candidate for data-driving,
  // not worth a contract change — see plan's Phase B caveat).
  switch (kind) {
    case "search_bounce": {
      if (lastSearchUrl) {
        await nav(lastSearchUrl);
        await humanScrollSeeded(page, pickNoiseScrollTicks(kind, true, rand), rand);
        await sleep(pickNoiseDwellMs(kind, true, rand));
        return;
      }
      await humanScrollSeeded(page, pickNoiseScrollTicks(kind, false, rand), rand);
      await sleep(pickNoiseDwellMs(kind, false, rand));
      return;
    }
    case "feed_scroll": {
      await nav("https://www.linkedin.com/feed/");
      await humanScrollSeeded(page, pickNoiseScrollTicks(kind, false, rand), rand);
      await sleep(pickNoiseDwellMs(kind, false, rand));
      return;
    }
    case "profile_hover": {
      const candidate = seenPool.length ? seenPool[Math.floor(rand() * seenPool.length)] : null;
      if (candidate) {
        await nav(candidate);
        await humanScrollSeeded(page, pickNoiseScrollTicks(kind, true, rand), rand);
        await sleep(pickNoiseDwellMs(kind, true, rand));
        return;
      }
      await humanScrollSeeded(page, pickNoiseScrollTicks(kind, false, rand), rand);
      await sleep(pickNoiseDwellMs(kind, false, rand));
      return;
    }
    case "idle_scroll":
    default: {
      await humanScrollSeeded(page, pickNoiseScrollTicks(kind, false, rand), rand);
      await sleep(pickNoiseDwellMs(kind, false, rand));
      return;
    }
  }
}

// Playwright adapter for the shared success-condition predicate: fetch ONLY the
// page values this condition type needs, then delegate the comparison to the
// shared evaluateSuccessCondition (same logic the extension's replay.ts uses).
// Best-effort: a failed/unknown condition never throws.
async function checkSuccessConditionDaemon(page, step, target) {
  const cond = step && step.success_condition;
  if (!cond || typeof cond !== "object" || !cond.type) return { ok: true };
  const need = successConditionInputs(cond);
  const values = {};
  try {
    if (need.includes("pageText")) {
      values.pageText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    }
    if (need.includes("currentUrl")) {
      values.currentUrl = page.url();
    }
    if (need.includes("inputValue")) {
      if (target && target.handle) {
        values.inputValue = await target.handle.inputValue().catch(async () => {
          return await target.handle.textContent().catch(() => null);
        });
      } else {
        values.inputValue = null;
      }
    }
    if (need.includes("selectorFound")) {
      const sel = String(cond.selector || "");
      if (sel) {
        const loc = (sel.startsWith("/") || sel.startsWith("(")) ? page.locator(`xpath=${sel}`) : page.locator(sel);
        values.selectorFound = await loc.count().then((c) => c > 0).catch(() => false);
      } else {
        values.selectorFound = !!target;
      }
    }
  } catch { /* best-effort: fall through to evaluate with whatever we gathered */ }
  return evaluateSuccessCondition(cond, values);
}

// Pause the run on a detected wall + trip the account circuit breaker.
async function handleBlocker(runId, err, stepIndex) {
  console.error(`[daemon] blocker "${err.blockerType}" at step ${stepIndex} — pausing run, NOT advancing`);
  await pauseRun(runId, `Blocking: ${err.blockerType}`, stepIndex);
  tripCircuit(err.blockerType, err.soft);
}

// Timestamped debug logger — goes to the daemon log (operator can tail/VNC it).
function dbg(msg) {
  console.log(`[dbg ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// Snapshot the page when a step stalls or errors. Writes full artifacts locally
// (.debug/<runId>/ — for the on-site operator via VNC) AND posts a compact record
// to the backend so it's retrievable over Tailscale with no shell access:
//   GET /v1/runs/<runId>/events?event_type=debug
async function captureDebug(page, runId, stepIndex, reason, consoleBuf = []) {
  // Each sub-op is raced against a short timeout: the page may be unresponsive
  // (that's often WHY we're capturing), and page.content()/screenshot can hang.
  const race = (p, ms, fallback) =>
    Promise.race([
      Promise.resolve().then(() => p).catch(() => fallback),
      new Promise((r) => setTimeout(() => r(fallback), ms)),
    ]);
  let url = "";
  try { url = page.url(); } catch { /* page may be closed */ }
  const title = await race(page.title(), 4000, "");
  const html = (await race(page.content(), 5000, "")).slice(0, 20000);
  let shotPath = "";
  try {
    const dir = path.join(DEBUG_DIR, runId);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.join(dir, `step${stepIndex}-${stamp}`);
    const buf = await race(page.screenshot({ fullPage: false }), 6000, null);
    if (buf) { fs.writeFileSync(`${base}.png`, buf); shotPath = `${base}.png`; }
    fs.writeFileSync(`${base}.html`, html);
    fs.writeFileSync(`${base}.json`, JSON.stringify({ url, title, reason, console: consoleBuf.slice(-50) }, null, 2));
  } catch (e) { dbg(`captureDebug local write failed: ${e.message || e}`); }
  dbg(`[DEBUG CAPTURE] step=${stepIndex} reason="${reason}" url=${url} title="${title}" html=${html.length}B shot=${shotPath || "none"} console=${consoleBuf.length}`);
  try {
    await fetchJson(`${BACKEND}/v1/runs/${runId}/debug`, {
      method: "POST",
      body: JSON.stringify({
        step_index: stepIndex,
        reason,
        url,
        title,
        html_excerpt: html.slice(0, 8000),
        console: consoleBuf.slice(-50),
        screenshot_path: shotPath,
      }),
    });
  } catch (e) { dbg(`captureDebug backend POST failed: ${e.message || e}`); }
}

async function driveRun(run) {
  const runId = run.id;
  drivingRunId = runId;
  resetStepShots();
  // QA execution options (default: live, no cap). max_candidates caps how many
  // profiles a test run actually scrapes so a test doesn't burn the shared
  // budget; remaining candidate steps just advance the cursor without page loads.
  const execOpts = run.origin?.execution_options || {};
  const maxCandidates = (typeof execOpts.max_candidates === "number" && execOpts.max_candidates >= 0)
    ? execOpts.max_candidates
    : null;
  const isTestRun = execOpts.mode === "test";
  // Lead-sourcing flow: collect name+headline+profile_url from the first 2
  // search pages and stop — NO profile visits, NO for_each. The run
  // auto-completes when step 5 advances the cursor to total_steps (6).
  const isLeadRun = run.origin?.event_kind === "linkedin_lead_search";
  // Per-workflow execution mode (threaded through run.origin from the workflow).
  // "generic" → drive the plan via the generic loop; "hardcoded" → the bespoke
  // steps-0-5 preamble. The DAEMON_GENERIC_PREAMBLE env flag stays a global
  // force-on override. Missing mode → falsy → hardcoded (safe, matches today).
  const useGeneric = run.origin?.execution_mode === "generic" || GENERIC_PREAMBLE;
  // A user-initiated generic (non-LinkedIn) run from the dashboard "Run": it runs
  // in a CLEAN browser context (not the LinkedIn profile) and may load the user's
  // browser session via injected cookies (execution_options.load_session).
  const _ek = run.origin?.event_kind;
  const userGenericRun = run.origin?.execution_target === "daemon"
    && run.origin?.execution_mode === "generic"
    && _ek !== "new_job_position" && _ek !== "linkedin_lead_search";
  const loadSession = !!run.origin?.execution_options?.load_session;
  let profileExtractCount = 0;
  if (maxCandidates !== null || isTestRun) {
    console.log(`[daemon] run ${runId} options: mode=${execOpts.mode || "live"} max_candidates=${maxCandidates ?? "∞"}`);
  }
  const jobTitle = run.origin?.job_payload?.job_title || "Software Engineer";
  const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(jobTitle)}&origin=SWITCH_SEARCH_VERTICAL`;
  const searchUrlP2 = `${searchUrl}&page=2`;

  console.log(`\n[daemon] driving run ${runId} for "${jobTitle}"`);
  // Emit a manifest of the hardcoded preamble so the dashboard can show what the
  // daemon does at each step (the generic path drives a real plan, so skip it).
  if (!useGeneric) await uploadFlowManifest(runId, buildFlowManifest(isLeadRun, jobTitle)).catch(() => {});

  // LinkedIn runs reuse the staged, logged-in profile (PROFILE_DIR). A user
  // generic run gets a CLEAN, ephemeral context ("") so it doesn't touch the
  // LinkedIn session; its auth (if any) comes from injected browser cookies.
  const contextDir = userGenericRun ? "" : PROFILE_DIR;
  const ctx = await chromium.launchPersistentContext(contextDir, {
    channel: "chrome", headless: false, viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", "--disable-features=ChromeWhatsNewUI", "--profile-directory=Default"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  // NOTE: the daemon is UNCONDITIONALLY protected. It deliberately ignores the
  // per-workflow `config.anti_bot` toggle (which gates the extension path only):
  // this is the high-risk LinkedIn-recruitment path that got flagged, so its
  // fingerprint stealth + circuit breaker + budget must never be disableable.
  // Do not "wire up the flag here for consistency".
  await ctx.addInitScript(STEALTH_INIT);
  // "Automation running" overlay on every page (visual deterrent so a human
  // watching the daemon's Chrome doesn't click). pointer-events:none → does not
  // block the daemon's own clicks. Hidden during screenshots (uploadStepShot).
  await ctx.addInitScript(OVERLAY_INIT);

  // "Load browser session" (dashboard toggle): inject the user's cookies (read by
  // the extension, shipped as a session_cookies artifact) so the generic run is
  // authenticated as the user. Consume-once: the daemon deletes the artifact right
  // after reading so the session tokens are short-lived in the backend.
  if (loadSession) {
    const cookies = await loadAndConsumeSessionCookies(runId);
    if (cookies.length) {
      try { await ctx.addCookies(cookies); dbg(`[SESSION] injected ${cookies.length} cookies`); }
      catch (e) { dbg(`addCookies failed: ${e.message || e}`); }
    }
  }

  // Run-scoped RNG for the opening sequence + a pool of seen profile URLs for
  // noise decoys + the last search URL for search_bounce noise.
  const orand = mulberry32((seedFromString(runId) ^ (Date.now() & 0xffffffff)) >>> 0);
  const seenPool = [];
  let lastSearchUrl = searchUrl;
  let blocked = false;
  let lastIdx = 0;
  let page = null;
  let watchdogFired = false;
  let watchdog = null;
  const consoleBuf = [];
  let mark = "start";

  try {
    page = ctx.pages()[0] || (await ctx.newPage());

    // Ring-buffer page console errors/warnings so debug snapshots include them.
    page.on("console", (m) => { const t = m.type(); if (t === "error" || t === "warning") { consoleBuf.push(`[${t}] ${m.text()}`.slice(0, 300)); if (consoleBuf.length > 80) consoleBuf.shift(); } });
    page.on("pageerror", (e) => { consoleBuf.push(`[pageerror] ${e.message}`.slice(0, 300)); if (consoleBuf.length > 80) consoleBuf.shift(); });
    // Watchdog: if the run stalls past RUN_WATCHDOG_MS, snapshot the page and
    // abort cleanly (closing ctx makes in-flight awaits reject → caught below).
    watchdog = setTimeout(async () => {
      watchdogFired = true;
      dbg(`[WATCHDOG] run ${runId} exceeded ${RUN_WATCHDOG_MS}ms at "${mark}" (step ~${lastIdx}) — capturing + aborting`);
      await captureDebug(page, runId, lastIdx, `watchdog-timeout ${RUN_WATCHDOG_MS}ms at ${mark}`, consoleBuf).catch(() => {});
      await ctx.close().catch(() => {});
    }, RUN_WATCHDOG_MS);

    // Phase C ship-dark: when DAEMON_GENERIC_PREAMBLE is ON, skip the hardcoded
    // steps-0-5 preamble (and the imperative expandForEach) below and let the
    // generic loop drive the whole plan from the snapshot — lead via
    // linkedin_people_search + linkedin_search_people, applicant additionally via
    // linkedin_paginate_next + linkedin_search_urls + a for_each step arm. OFF
    // (default) → the preamble + imperative expansion run exactly as before.
    let expansion = null;
    if (!useGeneric) {
    // step 0 — feed warm-up (real users don't deep-link cold to search).
    await safeGoto(page, "https://www.linkedin.com/feed/", "feed");
    await sleep(jitter(2500, 1500));
    await reportStepResult(runId, 0, "navigate");

    // step 1 — idle noise: varied scroll + read dwell (cursor not frozen).
    await humanScrollSeeded(page, 2 + Math.floor(orand() * 3), orand);
    await dwellWithJitter(page, pickDwellMs(3000, 9000, orand), orand);
    await reportStepResult(runId, 1, "noise_break");

    // step 2 — search page 1: type the query into the global search box and
    // click the People filter like a human (deep-link fallback inside).
    lastIdx = 2; mark = "search-nav"; dbg(`step2 navigate people search for "${jobTitle}"`);
    lastSearchUrl = await navigateToPeopleSearch(page, jobTitle, searchUrl, orand);
    recordSearch();
    await sleep(jitter(3000, 1500));
    // search page 1 is reached by typing + the People filter (not safeGoto), so
    // capture it explicitly — otherwise the gallery would skip the page-1 view.
    await uploadStepShot(page, "search-p1").catch(() => {});
    await reportStepResult(runId, 2, "navigate");

    if (isLeadRun) {
      lastIdx = 3; mark = "scrape-page1"; dbg(`step3 scrape page1 url=${page.url()}`);
      const people1 = await scrapeSearchPeople(page);
      seenPool.push(...people1.map((p) => p.profile_url));
      dbg(`step3 scraped ${people1.length} people`);
      console.log(`  step 3: ${people1.length} people on page 1`);
      await postExtraction(runId, 3, page.url(), { page_title: await page.title(), url: page.url(), people: people1 });
    } else {
      const p1 = await scrapeSearchProfileUrls(page);
      seenPool.push(...p1);
      console.log(`  step 3: ${p1.length} URLs on page 1`);
      await postExtraction(runId, 3, page.url(), { page_title: await page.title(), url: page.url(), profile_urls: p1 });
    }
    await reportStepResult(runId, 3, "extract");

    // step 4 — page 2.
    if (isLeadRun) {
      // The lead scraper parses `data-view-name="people-search-result"` cards,
      // which only render on a full server-side load of `&page=2`. SPA "Next"
      // pagination renders page-2 results WITHOUT those cards, so the card
      // parser finds nothing and the fallback scrapes mutual-connection links.
      // Use a direct navigation here (still gated by safeGoto's blocker check).
      await safeGoto(page, searchUrlP2, "search-p2");
      await sleep(jitter(3000, 1500));
    } else {
      // Applicant flow only needs /in/ URLs — click "Next" like a human.
      const wentP2 = await clickPaginationNext(page, orand);
      if (!wentP2) {
        await safeGoto(page, searchUrlP2, "search-p2");
        await sleep(jitter(3000, 1500));
      }
    }
    lastSearchUrl = page.url();
    await reportStepResult(runId, 4, "navigate");

    if (isLeadRun) {
      lastIdx = 5; mark = "scrape-page2"; dbg(`step5 scrape page2 url=${page.url()}`);
      const people2 = await scrapeSearchPeople(page);
      seenPool.push(...people2.map((p) => p.profile_url));
      dbg(`step5 scraped ${people2.length} people`);
      console.log(`  step 5: ${people2.length} people on page 2`);
      await postExtraction(runId, 5, page.url(), { page_title: await page.title(), url: page.url(), people: people2 });
    } else {
      const p2 = await scrapeSearchProfileUrls(page);
      seenPool.push(...p2);
      console.log(`  step 5: ${p2.length} URLs on page 2`);
      await postExtraction(runId, 5, page.url(), { page_title: await page.title(), url: page.url(), profile_urls: p2 });
    }
    await reportStepResult(runId, 5, "extract");

    if (isLeadRun) {
      // Lead flow ends here: reporting step 5 advanced the cursor to 6 ==
      // total_steps, so the backend auto-completed the run and the lead push
      // hook fired. No for_each, no profile visits.
      const done = await getRun(runId);
      console.log(`  done (lead run): status=${done.status} step=${done.current_step_index}/${done.total_steps}`);
      return;
    }

    expansion = await expandForEach(runId, 6);
    console.log(`  step 6: for_each expanded into ${expansion.iterations} iterations`);
    await reportStepResult(runId, 6, "for_each");
    }

    let cur = await getRun(runId);
    // `let` (not const): an in-loop for_each arm (generic applicant path) grows
    // the snapshot, so we re-read steps from the freshly-fetched run each pass.
    let steps = (cur.workflow_snapshot && cur.workflow_snapshot.steps) || (expansion && expansion.steps) || [];

    while (cur.current_step_index < cur.total_steps && cur.status === "running") {
      const idx = cur.current_step_index;
      lastIdx = idx;
      steps = (cur.workflow_snapshot && cur.workflow_snapshot.steps) || (expansion && expansion.steps) || steps;
      const step = steps[idx] || {};
      const action = String(step.action_type || "");
      const value = String(step.value || "");
      try {
        // Honor the backend-computed inter-iteration pacing.
        if (typeof step.delay_before_ms === "number" && step.delay_before_ms > 0) {
          await sleep(step.delay_before_ms);
        }
        if (maxCandidates !== null && profileExtractCount >= maxCandidates
            && (action === "navigate" || action === "extract")) {
          // Cap reached: skip remaining candidate navigate/extract steps (no
          // page load, no scrape) and just advance the cursor so the run still
          // completes cleanly with exactly max_candidates profiles.
          await reportStepResult(runId, idx, action);
        } else if (action === "navigate") {
          const target = step._for_each_item || value;
          if (/^https?:/.test(target)) {
            await safeGoto(page, target, `navigate:${idx}`);
            // Settle on arrival with a bezier move + small scroll so the
            // cursor isn't frozen on a freshly-loaded profile.
            await moveMouseAlongBezier(page, { x: 500 + orand() * 400, y: 300 + orand() * 200 }, orand);
            await humanScrollSeeded(page, 1 + Math.floor(orand() * 2), orand);
            await sleep(jitter(2000, 1500));
          }
          await reportStepResult(runId, idx, "navigate");
        } else if (action === "extract") {
          // Pluggable extract strategy (Phase B): "linkedin_search_people" (lead
          // search-results scrape — NOT a profile view, so it skips the
          // profile-view budget gate + recordProfileView), else "generic_schema"
          // / "linkedin_profile" (default — a profile view, budget-gated).
          const shapes = readExtractShapes(step);
          const strategy = readExtractStrategy(step);
          if (strategy === "linkedin_search_people") {
            lastIdx = idx; mark = `search-scrape:${idx}`;
            const people = await scrapeSearchPeople(page);
            seenPool.push(...people.map((p) => p.profile_url));
            dbg(`step${idx} scraped ${people.length} people (search extract)`);
            console.log(`  step ${idx}: ${people.length} people (search extract)`);
            await postExtraction(runId, idx, page.url(), { page_title: await page.title(), url: page.url(), people });
            await reportStepResult(runId, idx, "extract");
          } else if (strategy === "linkedin_search_urls") {
            // Applicant search scrape: just the /in/ URLs the for_each iterates.
            // Not a profile view — no budget gate / recordProfileView.
            lastIdx = idx; mark = `search-urls:${idx}`;
            const urls = await scrapeSearchProfileUrls(page);
            seenPool.push(...urls);
            dbg(`step${idx} scraped ${urls.length} profile URLs (search extract)`);
            console.log(`  step ${idx}: ${urls.length} URLs (search extract)`);
            await postExtraction(runId, idx, page.url(), { page_title: await page.title(), url: page.url(), profile_urls: urls });
            await reportStepResult(runId, idx, "extract");
          } else {
            // Budget gate: pause-and-resume rather than drop candidates.
            const reason = budgetExhaustedReason();
            if (reason) {
              console.log(`  step ${idx}: budget exhausted (${reason}) — pausing run to resume next window`);
              await pauseRun(runId, reason, idx);
              blocked = true;
              break;
            }
            // Capture profile URL BEFORE scrapeProfileFull navigates through
            // /details/<section>/ subpages, otherwise page.url() returns the
            // last subpage instead of the canonical /in/<slug>/.
            const profileUrl = page.url().replace(/\/details\/.+$/, "").replace(/\/$/, "");
            const data = strategy === "generic_schema"
              ? await scrapeGenericByShapes(page, profileUrl, shapes)
              : await scrapeProfileFull(page, profileUrl, shapes);
            recordProfileView();
            if (strategy === "generic_schema") {
              console.log(`  step ${idx}: generic_schema extract "${data.page_title || ""}" keys=[${Object.keys(data).filter((k) => k !== "page_title" && k !== "url").join(",")}]`);
            } else {
              console.log(`  step ${idx}: "${data.full_name}" headline="${(data.headline || "").slice(0, 60)}" edu=${(data.education || []).length} skills=${(data.skills || []).length} certs=${(data.certifications || []).length}`);
            }
            await postExtraction(runId, idx, profileUrl, data);
            await reportStepResult(runId, idx, "extract");
            profileExtractCount += 1;
          }
        } else if (action === "linkedin_people_search") {
          // Humanized people-search navigation (typeahead + "People" pill click,
          // deep-link fallback) — the exact step-2 behavior, dispatched from the
          // plan instead of hardcoded. Used by the Phase C generic lead path.
          lastIdx = idx; mark = "search-nav";
          const deepLink = /^https?:/.test(value) ? value : searchUrl;
          dbg(`step${idx} linkedin_people_search for "${jobTitle}"`);
          lastSearchUrl = await navigateToPeopleSearch(page, jobTitle, deepLink, orand);
          recordSearch();
          await sleep(jitter(3000, 1500));
          await reportStepResult(runId, idx, "linkedin_people_search");
        } else if (action === "linkedin_paginate_next") {
          // Applicant page-2: click "Next" like a human, deep-link fallback —
          // the exact hardcoded step-4 behavior, dispatched from the plan.
          lastIdx = idx; mark = "paginate-next";
          const wentNext = await clickPaginationNext(page, orand);
          if (!wentNext) {
            const fallback = /^https?:/.test(value) ? value : searchUrlP2;
            await safeGoto(page, fallback, "search-p2");
            await sleep(jitter(3000, 1500));
          }
          lastSearchUrl = page.url();
          await reportStepResult(runId, idx, "linkedin_paginate_next");
        } else if (action === "for_each") {
          // Generic applicant path: expand the for_each in-loop (the legacy path
          // does this imperatively before the loop). expandForEach grows the
          // snapshot; the steps refresh at the loop top picks up the new steps.
          expansion = await expandForEach(runId, idx);
          console.log(`  step ${idx}: for_each expanded into ${expansion.iterations} iterations`);
          await reportStepResult(runId, idx, "for_each");
        } else if (action === "noise_break") {
          const kind = step._noise_kind || "idle_scroll";
          const seed = step._noise_seed != null ? step._noise_seed : Math.floor(Math.random() * 0xffffffff);
          await executeNoiseBreakDaemon(page, kind, seed, lastSearchUrl, seenPool);
          await reportStepResult(runId, idx, "noise_break");
        } else if (action === "open_message_drafts") {
          const payload = await fetchMessageTargets(runId);
          const targets = (payload && payload.targets) || [];
          console.log(`  step ${idx}: open_message_drafts — opening ${targets.length} candidate profile tab(s)`);
          let pacingMs = 1500;
          if (Array.isArray(step.methods)) {
            for (const m of step.methods) {
              if (m && typeof m.pacing_ms === "number") pacingMs = m.pacing_ms;
            }
          }
          for (let i = 0; i < targets.length; i++) {
            const t = targets[i];
            try {
              const profilePage = await ctx.newPage();
              await safeGoto(profilePage, t.profile_url, `message-draft:${i + 1}`);
              console.log(`    [${i + 1}/${targets.length}] opened ${t.name || t.profile_url}`);
            } catch (err) {
              console.log(`    [${i + 1}/${targets.length}] ${t.profile_url} -> error: ${err.message?.slice(0, 200)}`);
            }
            if (i < targets.length - 1 && pacingMs > 0) await sleep(pacingMs);
          }
          await reportStepResult(runId, idx, "open_message_drafts");
        } else if (PHASE_A_VERBS.has(action)) {
          // Generic interactive verbs (click/type) resolved from the recorded
          // selector_chain — the daemon's first plan-driven dispatch (mirrors the
          // extension's replay.ts executeStep: primary selector_chain, then ONE
          // level of methods[] fallback). Anti-bot: routes through the SAME
          // moveMouseAlongBezier (single shared cursor) + typeHumanLike the rest
          // of the daemon uses, seeded by the run RNG `orand`; nothing about HOW a
          // verb is timed changes. A thrown BlockerError propagates to the catch
          // below (pause without advancing). On NO resolution we soft-miss (log +
          // report success + advance): a step-result success:false would FAIL the
          // whole run (the backend has no per-step retry/heal), so best-effort
          // here matches the daemon's existing transient-error policy.
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
          for (const a of attempts) {
            const target = await resolveLocator(page, a.selector_chain);
            if (!target) continue;
            if (a.action_type === "type") {
              acted = await typeResolved(page, target, a.value, { moveMouseAlongBezier, typeHumanLike, orand });
            } else {
              acted = await clickResolved(page, target, { moveMouseAlongBezier, orand });
            }
            if (acted) { actedTarget = target; break; }
          }
          if (!acted) {
            console.log(`  step ${idx}: ${action} — no selector resolved (soft-miss, advancing)`);
          } else if (step.success_condition) {
            // Verify the recorded success condition via the SHARED predicate
            // (same logic as replay.ts). Soft: log on mismatch, still advance —
            // a step-result success:false would fail the whole run.
            const verdict = await checkSuccessConditionDaemon(page, step, actedTarget);
            if (!verdict.ok) console.log(`  step ${idx}: ${action} success_condition not met (${verdict.reason}) — soft, advancing`);
          }
          await reportStepResult(runId, idx, action);
        } else {
          await reportStepResult(runId, idx, action || "noop");
        }
      } catch (stepErr) {
        // A detected LinkedIn wall must NOT be plowed through: bubble it so the
        // outer handler pauses the run (cursor NOT advanced) and trips the
        // circuit breaker.
        if (stepErr instanceof BlockerError) throw stepErr;
        // Transient LinkedIn / network failures (e.g. ERR_INTERNET_DISCONNECTED,
        // navigation timeout) would otherwise pin the run in `running` forever
        // while the daemon crashes out. The workflow's for_each declares
        // inner_failure_policy=continue, so we mirror that here — log, report
        // the step as success (advancing the cursor) and keep going. The push
        // hook on COMPLETED only sees profiles that actually got extracted.
        console.error(`  step ${idx} (${action}) error: ${stepErr.message?.slice(0, 200)}`);
        try {
          await reportStepResult(runId, idx, action || "noop");
        } catch (advErr) {
          console.error(`  step ${idx} advance also failed:`, advErr.message);
          // If we can't even advance the cursor, the run is wedged; break out
          // and let the next poll cycle pick a fresh run.
          break;
        }
      }
      cur = await getRun(runId);
    }
    // Loop exits when the run leaves `running` — completed, or canceled by an
    // operator via POST /v1/runs/{id}/cancel. Detect cancellation explicitly so
    // it's not silently treated as a normal finish.
    if (cur.status === "canceled") {
      console.log(`  run ${runId} CANCELED by operator at step ${cur.current_step_index}/${cur.total_steps} — aborting drive`);
      blocked = true;
    }
    if (!blocked) console.log(`  done: status=${cur.status} step=${cur.current_step_index}/${cur.total_steps}`);
  } catch (err) {
    const msg = err?.message || String(err);
    if (watchdogFired || /Target.*closed|browser.*closed|context.*closed/i.test(msg)) {
      // The watchdog already captured the page; pause cleanly so a stall is a
      // diagnosable terminal state, never a silent hang.
      dbg(`run ${runId} aborted by watchdog at "${mark}" (step ${lastIdx})`);
      await pauseRun(runId, `watchdog: stalled at ${mark} (step ${lastIdx})`, lastIdx).catch(() => {});
      blocked = true;
    } else if (err instanceof BlockerError) {
      // Wall hit on the opening sequence or bubbled from the step loop. Pause
      // at the last step we were on (0 for the opening) and trip the circuit.
      await handleBlocker(runId, err, lastIdx);
      blocked = true;
    } else {
      // Unexpected error — snapshot the page before bubbling so it's diagnosable.
      if (page) await captureDebug(page, runId, lastIdx, `error: ${msg}`, consoleBuf).catch(() => {});
      throw err;
    }
  } finally {
    if (watchdog) clearTimeout(watchdog);
    drivingRunId = null;
    await ctx.close().catch(() => {});
  }
}

// ── Main poll loop ──────────────────────────────────────────────────────────

console.log(`[daemon] polling ${BACKEND}/v1/runs every ${POLL_INTERVAL_MS}ms`);
console.log(`[daemon] watching for runs with origin.event_kind in {new_job_position, linkedin_lead_search}`);

setInterval(() => {
  postHeartbeat({
    worker_id: WORKER_ID,
    polling: drivingRunId === null,
    driving_run_id: drivingRunId,
    ...circuitInfo(),
  }).catch((err) => {
    console.error("[daemon] heartbeat error:", err.message);
  });
}, POLL_INTERVAL_MS);

let lastSkipLog = "";
const skipLog = (msg) => { if (msg !== lastSkipLog) { console.log(`[daemon] ${msg}`); lastSkipLog = msg; } };

while (true) {
  try {
    await postHeartbeat({
      worker_id: WORKER_ID,
      polling: drivingRunId === null,
      driving_run_id: drivingRunId,
      ...circuitInfo(),
    });

    // Pick the pending run first so a user-initiated GENERIC daemon run (dashboard
    // "Run") can bypass the account-wide anti-bot gates — circuit / working-hours /
    // cooldown / budget exist to protect the shared LinkedIn account, NOT generic
    // non-LinkedIn runs the user explicitly launched.
    const run = await findPendingRun();
    const o = (run && run.origin) || {};
    const isUserGeneric = !!run
      && o.execution_target === "daemon"
      && o.execution_mode === "generic"
      && o.event_kind !== "new_job_position"
      && o.event_kind !== "linkedin_lead_search";

    if (!run) {
      // nothing pending — keep heart-beating
    } else if (!isUserGeneric && circuitOpen()) {
      const until = new Date(account.circuit().open_until).toISOString();
      skipLog(`circuit OPEN until ${until} — not driving`);
    } else if (!isUserGeneric && !isWithinWorkingHours()) {
      skipLog(`outside working hours (${WORK_START_HOUR}:00-${WORK_END_HOUR}:00, days ${WORK_DAYS.join(",")}) — not driving`);
    } else if (!isUserGeneric && Date.now() < nextRunNotBefore) {
      skipLog(`inter-run cooldown until ${new Date(nextRunNotBefore).toISOString()} — not driving`);
    } else {
      const reason = isUserGeneric ? null : budgetExhaustedReason();
      if (reason) {
        skipLog(`budget exhausted (${reason}) — deferring run ${run.id} to next window`);
      } else if (run.status === "queued" && !(await claimRun(run.id))) {
        // Couldn't claim (lost race / not in QUEUED). No drive, no cooldown —
        // just poll again and let the next pass pick a fresh run.
      } else {
        lastSkipLog = "";
        try {
          await driveRun(run);
        } catch (err) {
          console.error(`[daemon] driveRun ${run.id} failed:`, err.message);
        }
        // Inter-run cooldown with jitter so LinkedIn runs don't fire back-to-back.
        // User-initiated generic runs are exempt (no robotic-cadence concern).
        if (!isUserGeneric) {
          nextRunNotBefore = Date.now() + jitter(BASE_COOLDOWN_MS, COOLDOWN_JITTER_MS);
          console.log(`[daemon] next run not before ${new Date(nextRunNotBefore).toISOString()}`);
        }
      }
    }
  } catch (err) {
    console.error("[daemon] poll error:", err.message);
  }
  await sleep(POLL_INTERVAL_MS);
}
