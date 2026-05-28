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
import { defaultEmptyValue, readExtractShapes, shapeToPrompt, shapeToSchema } from "./driver-shapes.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROFILE_DIR = path.resolve(__dirname, ".linkedin-profile");

const BACKEND = process.env.BACKEND || "http://localhost:8081";
const API_KEY = process.env.API_KEY || "dev-api-key-change-in-production";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || "5000");
const WORKER_ID = process.env.WORKER_ID || `${os.hostname()}-${process.pid}`;

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

async function postHeartbeat({ worker_id, polling, driving_run_id }) {
  await fetchJson(`${BACKEND}/v1/daemon/heartbeat`, {
    method: "POST",
    body: JSON.stringify({ worker_id, polling, driving_run_id }),
  });
}

// Only pick runs that started within the last STALE_RUN_AGE_MS — keeps the
// daemon from chewing on a stale `running` row left over from a crashed prior
// session. 30 min is generous; the workflow's worst-case wall-clock at
// candidate_count=10 is ~20 min.
const STALE_RUN_AGE_MS = 30 * 60_000;

async function findPendingRun() {
  const list = await fetchJson(`${BACKEND}/v1/runs?limit=20&status=running`);
  const items = Array.isArray(list) ? list : list.items || [];
  const now = Date.now();
  for (const r of items) {
    if (!r.origin) continue;
    if (r.origin.event_kind !== "new_job_position") continue;
    if (Array.isArray(r.extracted_data) && r.extracted_data.length > 0) continue;
    if (r.current_step_index > 0) continue;
    const startedAt = r.started_at ? Date.parse(r.started_at) : (r.created_at ? Date.parse(r.created_at) : 0);
    if (startedAt && now - startedAt > STALE_RUN_AGE_MS) continue;
    return r;
  }
  return null;
}

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
  return page.evaluate(async (msg) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    function inGlobalNav(el) {
      if (el.closest('nav, header, #global-nav, .global-nav, [data-global-nav], [class*="global-nav"]')) return true;
      if (el.tagName === "A" && /\/messaging\//.test(el.getAttribute("href") || "")) return true;
      return false;
    }
    const topCard = document.querySelector('[data-view-name="profile-top-card"]');
    function findActionButton(tokens, scope) {
      if (!scope) return null;
      const aria = Array.from(scope.querySelectorAll("button[aria-label], a[aria-label]"));
      for (const el of aria) {
        if (inGlobalNav(el)) continue;
        const l = (el.getAttribute("aria-label") || "").toLowerCase().trim();
        if (!l) continue;
        for (const t of tokens) {
          if (l === t || l.startsWith(t + " ") || l.startsWith(t + "…") || l.includes(" " + t + " ")) return el;
        }
      }
      const others = Array.from(scope.querySelectorAll('button, a[role="button"], div[role="button"], li[role="menuitem"]'));
      for (const el of others) {
        if (inGlobalNav(el)) continue;
        const t = (el.innerText || el.textContent || "").trim().toLowerCase();
        if (!t) continue;
        for (const tok of tokens) {
          if (t === tok || t.startsWith(tok)) return el;
        }
      }
      return null;
    }
    function findInOpenMenus(tokens) {
      const menus = Array.from(document.querySelectorAll('[role="menu"], [aria-expanded="true"] + *, .artdeco-dropdown__content'));
      for (const m of menus) {
        const f = findActionButton(tokens, m);
        if (f) return f;
      }
      return null;
    }
    async function waitFor(fn, timeoutMs, poll = 200) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const v = fn();
        if (v) return v;
        await sleep(poll);
      }
      return null;
    }
    if (!topCard) return { ok: false, reason: "top_card_not_found" };
    const pendingTokens = ["pending", "pendiente", "invitation sent", "invitación enviada"];
    if (findActionButton(pendingTokens, topCard)) return { ok: false, reason: "already_pending" };

    const connectTokens = ["connect", "conectar", "invitar", "invite", "vincular"];
    const moreTokens = ["more", "más", "mas"];
    let connectBtn = findActionButton(connectTokens, topCard);
    if (!connectBtn) {
      const more = findActionButton(moreTokens, topCard);
      if (more) {
        try { more.scrollIntoView({ block: "center" }); more.click(); } catch {}
        await sleep(600);
        connectBtn = await waitFor(() => findInOpenMenus(connectTokens), 5000);
      }
    }
    if (!connectBtn) return { ok: false, reason: "no_connect_button" };
    try { connectBtn.scrollIntoView({ block: "center" }); connectBtn.click(); } catch {}
    const dialog = await waitFor(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      for (const d of dialogs) {
        const txt = (d.innerText || "").toLowerCase();
        if (/invit|connect|conectar|personaliz/.test(txt)) return d;
      }
      return null;
    }, 8000);
    if (!dialog) return { ok: false, reason: "connect_modal_did_not_open" };
    const addNote = Array.from(dialog.querySelectorAll('button, a[role="button"]')).find((b) => {
      const t = (b.innerText || b.textContent || "").trim().toLowerCase();
      return t.includes("add a note") || t.includes("añadir nota") || t.includes("personalizar") || t.includes("personalize");
    });
    if (addNote) { try { addNote.click(); } catch {} await sleep(400); }
    const textarea = await waitFor(() => dialog.querySelector(
      'textarea#custom-message, textarea[name="message"], textarea[aria-label*="message" i], textarea[aria-label*="nota" i], textarea'
    ), 6000);
    if (!textarea) return { ok: false, reason: "note_textarea_missing" };
    textarea.focus();
    textarea.value = "";
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(textarea, msg);
    else textarea.value = msg;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(200);
    return { ok: true };
  }, trimmed);
}

async function expandForEach(runId, stepIndex) {
  return fetchJson(`${BACKEND}/v1/runs/${runId}/expand-for-each`, {
    method: "POST",
    body: JSON.stringify({ step_index: stepIndex }),
  });
}

// ── Stealth init ────────────────────────────────────────────────────────────

const STEALTH_INIT = () => {
  try {
    const nativeToString = Function.prototype.toString;
    const toStringMap = new WeakMap();
    const proxiedToString = new Proxy(nativeToString, {
      apply(t, thisArg, args) { const c = toStringMap.get(thisArg); if (c) return c; return Reflect.apply(t, thisArg, args); },
    });
    Function.prototype.toString = proxiedToString;
    toStringMap.set(proxiedToString, "function toString() { [native code] }");
    const mask = (fn, name) => (toStringMap.set(fn, `function ${name}() { [native code] }`), fn);
    try { Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true }); } catch {}
    try { Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"], configurable: true }); } catch {}
    try { Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8, configurable: true }); } catch {}
    try { Object.defineProperty(navigator, "deviceMemory", { get: () => 8, configurable: true }); } catch {}
    try {
      const q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = mask(function query(p) {
        if (p && p.name === "notifications") return Promise.resolve({ state: "default", name: "notifications", onchange: null, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true });
        return q(p);
      }, "query");
    } catch {}
    try {
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.runtime) window.chrome.runtime = { OnInstalledReason: { CHROME_UPDATE: "chrome_update", INSTALL: "install", UPDATE: "update" } };
    } catch {}
    try {
      const orig = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = mask(function (p) { if (p === 37445) return "Intel Inc."; if (p === 37446) return "Intel Iris OpenGL Engine"; return orig.call(this, p); }, "getParameter");
    } catch {}
  } catch (err) { console.warn("[stealth] init error:", err); }
};

// ── Page interactions / scraping (mirror live-linkedin-driver) ──────────────

async function humanScroll(page, rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await page.mouse.wheel(0, 400 + Math.floor(Math.random() * 400));
    await sleep(jitter(600, 700));
  }
}

async function scrapeSearchProfileUrls(page) {
  await page.waitForSelector('a[href*="/in/"]', { timeout: 30000 }).catch(() => {});
  await humanScroll(page, 4);
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

async function scrapeProfileTopCard(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  try { await page.waitForSelector('[data-view-name="profile-top-card"], section[componentkey*="Topcard"]', { timeout: 20000, state: "attached" }); } catch {}
  await sleep(jitter(2500, 1500));
  await humanScroll(page, 7);
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

async function scrapeExperienceItems(page, base) {
  const url = `${base.replace(/\/$/, "")}/details/experience/`;
  try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }); } catch { return []; }
  await sleep(jitter(2500, 1200));
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 700); await sleep(jitter(450, 300)); }
  await sleep(jitter(1500, 800));
  return await page.evaluate(() => {
    const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
    const main = document.querySelector("main") || document.body;
    const candidates = Array.from(main.querySelectorAll("ul")).filter((ul) => !ul.closest("nav") && ul.getAttribute("role") !== "tablist");
    let best = null, score = 0;
    candidates.forEach((ul) => {
      const lis = Array.from(ul.children).filter((c) => c.tagName === "LI");
      if (!lis.length) return;
      const total = lis.reduce((a, li) => a + (li.textContent || "").length, 0);
      if (total > score) { score = total; best = ul; }
    });
    if (!best) return [];
    return Array.from(best.children).filter((c) => c.tagName === "LI").map((li) => {
      const paras = Array.from(li.querySelectorAll("p, h3, h4, div")).filter((e) => e.children.length === 0).map((e) => clean(e.textContent)).filter((t) => t.length > 0 && t.length < 800);
      const spans = Array.from(li.querySelectorAll("span")).filter((s) => s.children.length === 0).map((s) => clean(s.textContent)).filter(Boolean);
      const desc = spans.find((s) => s.length > 40) || "";
      const seen = new Set();
      const uniq = [];
      for (const p of paras) { if (!seen.has(p)) { seen.add(p); uniq.push(p); } }
      return { paras: uniq, desc };
    });
  });
}

const DATE_LINE_RE = /\b(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s*\d{4}|(?:Present|Actualidad|Currently|Actualmente)|\b\d{4}\s*-\s*\d{4}\b/i;
const EMPLOYMENT_TYPE_RE = /\b(?:Full[- ]time|Part[- ]time|Contract|Freelance|Self[- ]employed|Internship|Apprenticeship|Temporary|Volunteer|Jornada completa|Jornada parcial|Contrato|Aut[óo]nomo|Pr[áa]cticas|Trabajo temporal|Voluntariado)\b/i;
const IGNORED_SECTION_LINES = /^(show all|see all|mostrar todo|ver todo|skills|habilidades|aptitudes|education|educaci[oó]n|formaci[oó]n|licenses?\s*&\s*certifications|licencias y certificaciones|projects|proyectos|courses|cursos|languages|idiomas|all|industry knowledge|tools\s*&\s*technologies|interpersonal skills|other skills|more profiles for you|people you may know|personas que podr[íi]as conocer|conocimientos del sector|herramientas y tecnolog[íi]as|habilidades interpersonales|otras habilidades|·\s*\d+(st|nd|rd|th)?(\s*degree)?|\d+(st|nd|rd|th)?\s*(degree|grado)?\s*connection|conexi[oó]n\s*\d+(º|°)?|endorsed by|recomendado por|verified|verificado|premium|open to work|abierto a oportunidades)$/i;

function parseExperienceItems(items) {
  const out = [];
  for (const it of items) {
    const paras = it.paras || [];
    if (!paras.length) continue;
    const title = paras[0] || "";
    let dates = "", employment_type = "", company = "";
    for (let i = 1; i < paras.length; i++) {
      const t = paras[i];
      if (!dates && DATE_LINE_RE.test(t)) dates = t;
      else if (!employment_type && EMPLOYMENT_TYPE_RE.test(t)) employment_type = t;
      else if (!company) company = t;
    }
    out.push({ title, company, employment_type, dates, duration: "", location: "", description: (it.desc || "").slice(0, 1500) });
    if (out.length >= 12) break;
  }
  return out;
}

async function scrapeSectionListItems(page, profileBase, section) {
  const url = `${profileBase.replace(/\/$/, "")}/details/${section}/`;
  try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }); } catch { return []; }
  await sleep(jitter(2500, 1200));
  for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 700); await sleep(jitter(400, 300)); }
  await sleep(jitter(1500, 800));
  return await page.evaluate(() => {
    const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
    const leafTexts = (root) => {
      const nodes = Array.from(root.querySelectorAll("li, h3, h4, p, span, a, div"))
        .filter((el) => el.children.length === 0)
        .map((el) => clean(el.textContent))
        .filter((text) => text && text.length < 400);
      const uniq = [];
      const seen = new Set();
      for (const text of nodes) {
        if (seen.has(text)) continue;
        seen.add(text);
        uniq.push(text);
      }
      return uniq;
    };

    const main = document.querySelector("main") || document.body;
    const items = Array.from(main.querySelectorAll("li"))
      .filter((li) => !li.querySelector("li"))
      .map((li) => ({ texts: leafTexts(li) }))
      .filter((item) => item.texts.length > 0);
    if (items.length) return items;

    const blocks = Array.from(main.querySelectorAll("section, article"))
      .map((block) => ({ texts: leafTexts(block).slice(0, 8) }))
      .filter((item) => item.texts.length > 1);
    return blocks;
  });
}

function parseSkillItems(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const name = (item.texts || []).find((text) => !IGNORED_SECTION_LINES.test(text) && text.length <= 80);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 50) break;
  }
  return out;
}

function parseEducationItems(items) {
  const out = [];
  for (const item of items) {
    const texts = (item.texts || []).filter((text) => !IGNORED_SECTION_LINES.test(text));
    if (!texts.length) continue;
    const school = texts[0] || "";
    if (!school) continue;
    let degree = "";
    let field = "";
    let dates = "";
    for (const text of texts.slice(1)) {
      if (!dates && DATE_LINE_RE.test(text)) {
        dates = text;
        continue;
      }
      if (!degree) {
        degree = text;
        continue;
      }
      if (!field) field = text;
    }
    out.push({ school, degree, field, dates });
    if (out.length >= 12) break;
  }
  return out;
}

function parseCertificationItems(items) {
  const out = [];
  for (const item of items) {
    const texts = (item.texts || []).filter((text) => !IGNORED_SECTION_LINES.test(text));
    if (!texts.length) continue;
    const name = texts[0] || "";
    if (!name) continue;
    let issuer = "";
    let issued = "";
    for (const text of texts.slice(1)) {
      if (!issued && DATE_LINE_RE.test(text)) {
        issued = text;
        continue;
      }
      if (!issuer) issuer = text;
    }
    out.push({ name, issuer, issued });
    if (out.length >= 12) break;
  }
  return out;
}

function parseProjectItems(items) {
  const out = [];
  for (const item of items) {
    const texts = (item.texts || []).filter((text) => !IGNORED_SECTION_LINES.test(text));
    if (!texts.length) continue;
    const name = texts[0] || "";
    if (!name) continue;
    let dates = "";
    const descParts = [];
    for (const text of texts.slice(1)) {
      if (!dates && DATE_LINE_RE.test(text)) {
        dates = text;
        continue;
      }
      descParts.push(text);
    }
    out.push({ name, dates, description: descParts.join(" ").slice(0, 1500) });
    if (out.length >= 12) break;
  }
  return out;
}

function parseSimpleListItems(items, limit = 25) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const value = (item.texts || []).find((text) => !IGNORED_SECTION_LINES.test(text));
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

async function scrapeSubpageText(page, profileBase, section) {
  const url = `${profileBase.replace(/\/$/, "")}/details/${section}/`;
  try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }); } catch { return ""; }
  await sleep(jitter(2500, 1200));
  for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 700); await sleep(jitter(400, 300)); }
  await sleep(jitter(1500, 800));
  return await page.evaluate((sec) => {
    const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
    const main = document.querySelector("main") || document.body;
    let text = clean(main.textContent || "");
    const adIdx = text.search(/\bAd Options\b/i);
    if (adIdx > 0) text = text.slice(0, adIdx);
    if (/Nothing to see for now|Nothing here yet|a[uú]n no/i.test(text)) return "";
    const STRIP = {
      education: /^(Education|Educaci[oó]n|Formaci[oó]n)\s*/i,
      skills: /^(Skills|Habilidades|Aptitudes)\s*(?:All\s*Industry Knowledge\s*Tools & Technologies\s*Interpersonal Skills\s*(?:Languages\s*)?Other Skills\s*)?/i,
      certifications: /^(Licenses\s*&\s*certifications|Licencias y certificaciones)\s*/i,
      projects: /^(Projects|Proyectos)\s*/i,
      courses: /^(Courses|Cursos)\s*/i,
    };
    if (STRIP[sec]) text = text.replace(STRIP[sec], "");
    return text.trim();
  }, section);
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

async function scrapeProfileFull(page, url, extractShapes = []) {
  const top = await scrapeProfileTopCard(page, url);
  const requestedShapes = extractShapes.length > 0 ? extractShapes : defaultProfileShapes();
  const result = {
    page_title: top.full_name ? `${top.full_name} | LinkedIn` : "",
    full_name: top.full_name || "",
    headline: top.headline || "",
    location: top.location || "",
    about: top.about || "",
  };
  const subpageTextCache = new Map();
  const sectionItemsCache = new Map();
  for (const shape of requestedShapes) {
    if (!shape?.key) continue;
    if (shape.key === "about") {
      result.about = top.about || defaultEmptyValue(shape);
      continue;
    }
    if (shape.key === "experience") {
      const expItems = await scrapeExperienceItems(page, url);
      const parsedExperience = parseExperienceItems(expItems);
      if (parsedExperience.length > 0) {
        result.experience = parsedExperience;
      } else {
        const listItems = await scrapeSectionListItems(page, url, "experience");
        result.experience = parseExperienceItems(
          listItems.map((item) => ({ paras: item.texts || [], desc: "" })),
        );
      }
      continue;
    }
    if (shape.key === "full_name") {
      result.full_name = top.full_name || defaultEmptyValue(shape);
      continue;
    }
    if (shape.key === "headline") {
      result.headline = top.headline || defaultEmptyValue(shape);
      continue;
    }
    if (shape.key === "location") {
      result.location = top.location || defaultEmptyValue(shape);
      continue;
    }
    const sectionKey = shape.key === "top_skills" ? "skills" : shape.key;
    let sectionItems = sectionItemsCache.get(sectionKey);
    if (sectionItems === undefined) {
      sectionItems = await scrapeSectionListItems(page, url, sectionKey);
      sectionItemsCache.set(sectionKey, sectionItems);
    }
    let rawText = subpageTextCache.get(sectionKey);
    if (rawText === undefined) {
      rawText = await scrapeSubpageText(page, url, sectionKey);
      subpageTextCache.set(sectionKey, rawText);
    }
    const parsed = await aiExtractByShape(shape, rawText);
    if (parsed?.[shape.key]) {
      result[shape.key] = parsed[shape.key];
      continue;
    }
    if (sectionKey === "skills") {
      result[shape.key] = parseSkillItems(sectionItems);
      continue;
    }
    if (sectionKey === "education") {
      result[shape.key] = parseEducationItems(sectionItems);
      continue;
    }
    if (sectionKey === "certifications") {
      result[shape.key] = parseCertificationItems(sectionItems);
      continue;
    }
    if (sectionKey === "projects") {
      result[shape.key] = parseProjectItems(sectionItems);
      continue;
    }
    if (sectionKey === "courses" || sectionKey === "languages") {
      result[shape.key] = parseSimpleListItems(sectionItems);
      continue;
    }
    result[shape.key] = defaultEmptyValue(shape);
  }
  return result;
}

// ── Run driver ──────────────────────────────────────────────────────────────

async function driveRun(run) {
  const runId = run.id;
  drivingRunId = runId;
  const jobTitle = run.origin?.job_payload?.job_title || "Software Engineer";
  const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(jobTitle)}&origin=SWITCH_SEARCH_VERTICAL`;
  const searchUrlP2 = `${searchUrl}&page=2`;

  console.log(`\n[daemon] driving run ${runId} for "${jobTitle}"`);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome", headless: false, viewport: { width: 1440, height: 900 },
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", "--disable-features=ChromeWhatsNewUI", "--profile-directory=Default"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  await ctx.addInitScript(STEALTH_INIT);

  try {
    const page = ctx.pages()[0] || (await ctx.newPage());

    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(jitter(2500, 1500));
    if (/checkpoint|login|authwall/i.test(page.url())) throw new Error(`Challenge on /feed/: ${page.url()}`);
    await reportStepResult(runId, 0, "navigate");

    await humanScroll(page, 4);
    await reportStepResult(runId, 1, "noise_break");

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(jitter(3000, 1500));
    await reportStepResult(runId, 2, "navigate");

    const p1 = await scrapeSearchProfileUrls(page);
    console.log(`  step 3: ${p1.length} URLs on page 1`);
    await postExtraction(runId, 3, page.url(), { page_title: await page.title(), url: page.url(), profile_urls: p1 });
    await reportStepResult(runId, 3, "extract");

    await page.goto(searchUrlP2, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(jitter(3000, 1500));
    await reportStepResult(runId, 4, "navigate");

    const p2 = await scrapeSearchProfileUrls(page);
    console.log(`  step 5: ${p2.length} URLs on page 2`);
    await postExtraction(runId, 5, page.url(), { page_title: await page.title(), url: page.url(), profile_urls: p2 });
    await reportStepResult(runId, 5, "extract");

    const expansion = await expandForEach(runId, 6);
    console.log(`  step 6: for_each expanded into ${expansion.iterations} iterations`);
    await reportStepResult(runId, 6, "for_each");

    let cur = await getRun(runId);
    const steps = (cur.workflow_snapshot && cur.workflow_snapshot.steps) || expansion.steps || [];

    while (cur.current_step_index < cur.total_steps && cur.status === "running") {
      const idx = cur.current_step_index;
      const step = steps[idx] || {};
      const action = String(step.action_type || "");
      const value = String(step.value || "");
      try {
        if (action === "navigate") {
          const target = step._for_each_item || value;
          if (/^https?:/.test(target)) {
            await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
            await sleep(jitter(2500, 1500));
          }
          await reportStepResult(runId, idx, "navigate");
        } else if (action === "extract") {
          // Capture profile URL BEFORE scrapeProfileFull navigates through
          // /details/<section>/ subpages, otherwise page.url() returns the
          // last subpage instead of the canonical /in/<slug>/.
          const profileUrl = page.url().replace(/\/details\/.+$/, "").replace(/\/$/, "");
          const data = await scrapeProfileFull(page, profileUrl, readExtractShapes(step));
          console.log(`  step ${idx}: "${data.full_name}" headline="${(data.headline || "").slice(0, 60)}" edu=${data.education.length} skills=${data.skills.length} certs=${data.certifications.length}`);
          await postExtraction(runId, idx, profileUrl, data);
          await reportStepResult(runId, idx, "extract");
        } else if (action === "noise_break") {
          await sleep(jitter(2000, 2000));
          await humanScroll(page, 2);
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
              await profilePage.goto(t.profile_url, { waitUntil: "domcontentloaded", timeout: 60000 });
              console.log(`    [${i + 1}/${targets.length}] opened ${t.name || t.profile_url}`);
            } catch (err) {
              console.log(`    [${i + 1}/${targets.length}] ${t.profile_url} -> error: ${err.message?.slice(0, 200)}`);
            }
            if (i < targets.length - 1 && pacingMs > 0) await sleep(pacingMs);
          }
          await reportStepResult(runId, idx, "open_message_drafts");
        } else {
          await reportStepResult(runId, idx, action || "noop");
        }
      } catch (stepErr) {
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
    console.log(`  done: status=${cur.status} step=${cur.current_step_index}/${cur.total_steps}`);
  } finally {
    drivingRunId = null;
    await ctx.close().catch(() => {});
  }
}

// ── Main poll loop ──────────────────────────────────────────────────────────

console.log(`[daemon] polling ${BACKEND}/v1/runs every ${POLL_INTERVAL_MS}ms`);
console.log(`[daemon] watching for runs with origin.event_kind=new_job_position`);

setInterval(() => {
  postHeartbeat({
    worker_id: WORKER_ID,
    polling: drivingRunId === null,
    driving_run_id: drivingRunId,
  }).catch((err) => {
    console.error("[daemon] heartbeat error:", err.message);
  });
}, POLL_INTERVAL_MS);

while (true) {
  try {
    await postHeartbeat({
      worker_id: WORKER_ID,
      polling: drivingRunId === null,
      driving_run_id: drivingRunId,
    });
    const run = await findPendingRun();
    if (run) {
      try {
        await driveRun(run);
      } catch (err) {
        console.error(`[daemon] driveRun ${run.id} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error("[daemon] poll error:", err.message);
  }
  await sleep(POLL_INTERVAL_MS);
}
