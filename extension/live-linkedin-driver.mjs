/**
 * Live LinkedIn driver — drives the LinkedIn People Search workflow honestly.
 *
 * Earlier versions of this file POSTed extractions with phony step indices
 * (10, 11) and never advanced the workflow's current_step_index — the
 * dashboard then showed "completed" with 0/7 steps done. This version
 * walks the workflow plan step by step, reporting step-result to the
 * backend for each, expanding the for_each, and POSTing extractions
 * at the real step indices. The dashboard timeline + intents go green.
 *
 * Bypasses the Chrome extension (Chrome 148 dropped --load-extension) by
 * driving real Chrome with a snapshot of the user's Profile 4 (cookies,
 * history, IndexedDB, Local Storage) plus a stealth init bundle.
 *
 * Run:
 *   node live-linkedin-driver.mjs
 *
 * Env:
 *   CONNECTOR_ID, JOB_ID, JOB_TITLE, PROFILE_LIMIT, BACKEND, API_KEY
 */
import { chromium } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROFILE_DIR = path.resolve(__dirname, ".linkedin-profile");

// Load OpenAI key from backend/.env (the same one Easy Recruit uses).
// LinkedIn's /details/<section>/ pages outside experience render entries as
// <div>s with hashed class names and no clean structural attributes —
// regex/DOM parsing is brittle. Run the cleaned section textContent through
// gpt-4o-mini with JSON Schema strict mode to extract structured records.
function loadOpenAIKey() {
  try {
    const envText = fs.readFileSync(path.resolve(__dirname, "..", "backend", ".env"), "utf-8");
    const m = envText.match(/^AI_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return process.env.LINKEDIN_AI_KEY || "";
}
const OPENAI_API_KEY = loadOpenAIKey();

const BACKEND = process.env.BACKEND || "http://localhost:8081";
const API_KEY = process.env.API_KEY || "dev-api-key-change-in-production";
const CONNECTOR_ID = process.env.CONNECTOR_ID || "5dd56944-daee-4674-9ca5-3b55a67ea1a4";
const JOB_ID = Number(process.env.JOB_ID || "4");
const JOB_TITLE = process.env.JOB_TITLE || "Software Engineer";
const PROFILE_LIMIT = Number(process.env.PROFILE_LIMIT || "2");

const HEADERS = { "X-API-Key": API_KEY, "Content-Type": "application/json" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base, spread) => base + Math.floor(Math.random() * spread);

// ── Backend API ─────────────────────────────────────────────────────────────

async function postOdooWebhook() {
  const payload = {
    job_id: JOB_ID, name: JOB_TITLE, job_title: JOB_TITLE,
    job_description: `Live E2E test driver for job ${JOB_ID}.`,
  };
  const r = await fetch(`${BACKEND}/v1/webhooks/incoming/odoo/${CONNECTOR_ID}`, {
    method: "POST", headers: HEADERS, body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`webhook POST failed: ${r.status} ${await r.text()}`);
  const body = await r.json();
  if (!body.triggered_runs?.length) {
    throw new Error(`no runs triggered: ${JSON.stringify(body)}`);
  }
  return body.triggered_runs[0];
}

async function postExtraction(runId, stepIndex, profileUrl, dataObj) {
  const r = await fetch(`${BACKEND}/v1/runs/${runId}/extraction`, {
    method: "POST", headers: HEADERS,
    body: JSON.stringify({ step_index: stepIndex, data: [dataObj], url: profileUrl }),
  });
  if (!r.ok) throw new Error(`extraction POST failed: ${r.status} ${await r.text()}`);
}

async function reportStepResult(runId, stepIndex, actionType, success = true) {
  const r = await fetch(`${BACKEND}/v1/runs/${runId}/step-result`, {
    method: "POST", headers: HEADERS,
    body: JSON.stringify({
      step_index: stepIndex,
      action_type: actionType,
      success,
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`step-result POST failed step=${stepIndex}: ${r.status} ${text}`);
  }
  return r.json();
}

async function expandForEach(runId, stepIndex) {
  const r = await fetch(`${BACKEND}/v1/runs/${runId}/expand-for-each`, {
    method: "POST", headers: HEADERS,
    body: JSON.stringify({ step_index: stepIndex }),
  });
  if (!r.ok) throw new Error(`expand-for-each failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function getRun(runId) {
  const r = await fetch(`${BACKEND}/v1/runs/${runId}`, { headers: HEADERS });
  if (!r.ok) throw new Error(`get run failed: ${r.status}`);
  return r.json();
}

async function getWorkflowSteps(workflowId) {
  const r = await fetch(`${BACKEND}/v1/workflows/${workflowId}`, { headers: HEADERS });
  if (!r.ok) throw new Error(`get workflow failed: ${r.status}`);
  return r.json();
}

// ── Stealth init script ─────────────────────────────────────────────────────

const STEALTH_INIT = () => {
  try {
    const nativeToString = Function.prototype.toString;
    const toStringMap = new WeakMap();
    const proxiedToString = new Proxy(nativeToString, {
      apply(t, thisArg, args) {
        const c = toStringMap.get(thisArg);
        if (c) return c;
        return Reflect.apply(t, thisArg, args);
      },
    });
    Function.prototype.toString = proxiedToString;
    toStringMap.set(proxiedToString, "function toString() { [native code] }");
    const mask = (fn, name) => (toStringMap.set(fn, `function ${name}() { [native code] }`), fn);
    try { Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true }); } catch {}
    try {
      const pluginNames = ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer", "Microsoft Edge PDF Viewer", "WebKit built-in PDF"];
      const fake = pluginNames.map((name) => ({ name, filename: "internal-pdf-viewer", description: "Portable Document Format", length: 1, 0: { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" } }));
      const proxy = new Proxy(fake, { get(t, p) { if (p === "length") return t.length; if (p === "item") return (i) => t[i]; if (p === "namedItem") return (n) => t.find((q) => q.name === n); if (typeof p === "string" && /^\d+$/.test(p)) return t[Number(p)]; return Reflect.get(t, p); } });
      Object.defineProperty(navigator, "plugins", { get: () => proxy, configurable: true });
      Object.defineProperty(navigator, "mimeTypes", { get: () => [{ type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" }], configurable: true });
    } catch {}
    try { Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"], configurable: true }); } catch {}
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
      if (typeof WebGL2RenderingContext !== "undefined") {
        const o2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = mask(function (p) { if (p === 37445) return "Intel Inc."; if (p === 37446) return "Intel Iris OpenGL Engine"; return o2.call(this, p); }, "getParameter");
      }
    } catch {}
    try { if (typeof Notification !== "undefined") Object.defineProperty(Notification, "permission", { get: () => "default", configurable: true }); } catch {}
    try { Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8, configurable: true }); } catch {}
    try { Object.defineProperty(navigator, "deviceMemory", { get: () => 8, configurable: true }); } catch {}
  } catch (err) { console.warn("[stealth] init error:", err); }
};

// ── Page interactions ───────────────────────────────────────────────────────

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
      else if (href.startsWith("/in/")) {
        out.add(`https://www.linkedin.com${href.split("?")[0].split("#")[0]}`.replace(/\/$/, ""));
      }
    });
    return Array.from(out);
  });
  return urls.filter((u) => /linkedin\.com\/in\/[A-Za-z0-9_\-%\.]+$/.test(u));
}

async function scrapeProfileTopCard(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  try {
    await page.waitForSelector('[data-view-name="profile-top-card"], section[componentkey*="Topcard"]',
      { timeout: 20000, state: "attached" });
  } catch {}
  await sleep(jitter(2500, 1500));
  await humanScroll(page, 7);
  try {
    await page.waitForSelector('[data-view-name="profile-card-about"]',
      { timeout: 6000, state: "attached" });
  } catch {}
  await sleep(jitter(1500, 1000));

  return await page.evaluate(() => {
    const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
    const txt = (el) => clean(el?.textContent || "");

    const topCard =
      document.querySelector('[data-view-name="profile-top-card"]') ||
      document.querySelector('section[componentkey*="Topcard"]');

    let full_name = "";
    if (topCard) {
      const h2 = topCard.querySelector("h2");
      if (h2) full_name = txt(h2);
    }
    if (!full_name) {
      const NAV = /^\d|notification|notificaci|history|historial|recent|opciones|gente|peopl|advert|publici/i;
      full_name = Array.from(document.querySelectorAll("h2"))
        .map((h) => txt(h))
        .find((t) => t.length >= 3 && t.length <= 80 && !NAV.test(t)) || "";
    }

    const DEGREE_RE = /^[·•]?\s*\d+(?:er|º|st|nd|rd|th)\s*$/;
    let headline = "";
    if (topCard) {
      const leafPs = Array.from(topCard.querySelectorAll("p")).filter((p) => p.children.length === 0);
      for (const p of leafPs) {
        const t = clean(p.textContent);
        if (!t || t === full_name || DEGREE_RE.test(t) || /^[·•]/.test(t)) continue;
        if (t.length < 5 || t.length > 250) continue;
        headline = t;
        break;
      }
    }

    let about = "";
    const aboutEl = document.querySelector('[data-view-name="profile-card-about"]');
    if (aboutEl) about = clean(aboutEl.textContent);
    if (!about) {
      const want = ["about", "acerca de", "sobre"];
      const h2 = Array.from(document.querySelectorAll("h2")).find(
        (h) => want.includes((h.textContent || "").trim().toLowerCase()),
      );
      if (h2) {
        const sec = h2.closest("section") || h2.parentElement;
        if (sec) about = clean(sec.textContent);
      }
    }
    about = about.replace(/^(About|Acerca de|Sobre)(?:\s*\1)?/i, "").trim().slice(0, 4000);

    let location = "";
    if (topCard) {
      const leafPs = Array.from(topCard.querySelectorAll("p")).filter((p) => p.children.length === 0);
      for (const p of leafPs) {
        const t = clean(p.textContent);
        if (!t || t === full_name || t === headline) continue;
        if (DEGREE_RE.test(t)) continue;
        if (/Area|Region|City|Metropolitan|País|Country|Greater/i.test(t)) { location = t; break; }
      }
    }
    return { full_name, headline, about, location };
  });
}

// Return raw structured items from a /details/<section>/ subpage.
// Each item is { paras: [...], desc: "..." } — the parser per-section
// turns these into typed records.
async function scrapeDetailsSubpageRaw(page, profileBase, section) {
  const url = `${profileBase.replace(/\/$/, "")}/details/${section}/`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch {
    return [];
  }
  await sleep(jitter(2500, 1200));
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 700);
    await sleep(jitter(450, 300));
  }
  await sleep(jitter(1500, 800));

  return await page.evaluate(() => {
    const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
    const main = document.querySelector("main") || document.body;

    // Pick the content <ul>: largest by total text, skipping nav/tablist.
    const candidates = Array.from(main.querySelectorAll("ul"))
      .filter((ul) => !ul.closest("nav") && ul.getAttribute("role") !== "tablist");
    let bestUl = null;
    let bestScore = 0;
    candidates.forEach((ul) => {
      const direct = Array.from(ul.children).filter((c) => c.tagName === "LI");
      if (direct.length === 0) return;
      const total = direct.reduce((acc, li) => acc + (li.textContent || "").length, 0);
      if (total > bestScore) { bestScore = total; bestUl = ul; }
    });
    if (!bestUl) return [];

    const items = Array.from(bestUl.children).filter((c) => c.tagName === "LI");
    return items.map((li) => {
      // Leaf p/h3/div text in order — these are the structured field rows
      // (title, employment_type, dates for experience; school, degree, dates for education).
      const paras = Array.from(li.querySelectorAll("p, h3, h4, div"))
        .filter((e) => e.children.length === 0)
        .map((e) => clean(e.textContent))
        .filter((t) => t.length > 0 && t.length < 800);
      // Description: the single big span (when present).
      const spans = Array.from(li.querySelectorAll("span"))
        .filter((s) => s.children.length === 0)
        .map((s) => clean(s.textContent))
        .filter(Boolean);
      const desc = spans.find((s) => s.length > 40) || "";
      // Deduplicate paras preserving order.
      const seen = new Set();
      const uniqParas = [];
      for (const p of paras) {
        if (seen.has(p)) continue;
        seen.add(p);
        uniqParas.push(p);
      }
      return { paras: uniqParas, desc };
    });
  });
}

// ── Per-section parsers ─────────────────────────────────────────────────────

const DATE_LINE_RE =
  /\b(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s*\d{4}|(?:Present|Actualidad|Currently|Actualmente)|\b\d{4}\s*-\s*\d{4}\b/i;
const EMPLOYMENT_TYPE_RE =
  /\b(?:Full[- ]time|Part[- ]time|Contract|Freelance|Self[- ]employed|Internship|Apprenticeship|Temporary|Volunteer|Jornada completa|Jornada parcial|Contrato|Aut[óo]nomo|Pr[áa]cticas|Trabajo temporal|Voluntariado)\b/i;

function parseExperienceItems(items) {
  const out = [];
  for (const it of items) {
    const paras = it.paras || [];
    if (paras.length === 0) continue;
    const title = paras[0] || "";
    let dates = "";
    let employment_type = "";
    let company = "";
    for (let i = 1; i < paras.length; i++) {
      const t = paras[i];
      if (!dates && DATE_LINE_RE.test(t)) dates = t;
      else if (!employment_type && EMPLOYMENT_TYPE_RE.test(t)) employment_type = t;
      else if (!company) company = t;
    }
    out.push({
      title, company, employment_type, dates,
      duration: "", location: "",
      description: (it.desc || "").slice(0, 1500),
    });
    if (out.length >= 12) break;
  }
  return out;
}

function parseEducationItems(items) {
  const out = [];
  for (const it of items) {
    const paras = it.paras || [];
    if (paras.length === 0) continue;
    const school = paras[0] || "";
    let degree = "";
    let field = "";
    let dates = "";
    for (let i = 1; i < paras.length; i++) {
      const t = paras[i];
      if (!dates && DATE_LINE_RE.test(t)) dates = t;
      else if (!degree && /degree|bachelor|master|maestr|licenc|engineering|ingenier|grado|título/i.test(t)) degree = t;
      else if (!field) field = t;
    }
    out.push({ school, degree, field, dates, description: (it.desc || "").slice(0, 600) });
    if (out.length >= 8) break;
  }
  return out;
}

function parseSkillsItems(items) {
  const out = [];
  for (const it of items) {
    const paras = it.paras || [];
    const first = (paras[0] || it.desc || "").trim();
    if (!first || first.length > 80) continue;
    out.push(first);
    if (out.length >= 40) break;
  }
  return out;
}

function parseCertificationItems(items) {
  const out = [];
  for (const it of items) {
    const paras = it.paras || [];
    if (paras.length === 0) continue;
    const name = paras[0] || "";
    let issuer = "";
    let issued = "";
    for (let i = 1; i < paras.length; i++) {
      const t = paras[i];
      if (!issued && DATE_LINE_RE.test(t)) issued = t;
      else if (!issuer) issuer = t;
    }
    out.push({ name, issuer, issued, credential_id: "" });
    if (out.length >= 12) break;
  }
  return out;
}

// Get cleaned textContent of a /details/<section>/ subpage with ads/footer
// stripped, language heading removed, and "Nothing to see for now" detected
// as empty. Returns "" if the section is genuinely empty.
async function scrapeSubpageText(page, profileBase, section) {
  const url = `${profileBase.replace(/\/$/, "")}/details/${section}/`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch { return ""; }
  await sleep(jitter(2500, 1200));
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, 700);
    await sleep(jitter(400, 300));
  }
  await sleep(jitter(1500, 800));

  return await page.evaluate((sec) => {
    const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
    const main = document.querySelector("main") || document.body;
    let text = clean(main.textContent || "");
    const adIdx = text.search(/\bAd Options\b/i);
    if (adIdx > 0) text = text.slice(0, adIdx);
    if (/Nothing to see for now|Nothing here yet|a[uú]n no/i.test(text)) return "";
    const STRIP = {
      experience: /^(Experience|Experiencia)\s*/i,
      education: /^(Education|Educaci[oó]n|Formaci[oó]n)\s*/i,
      skills: /^(Skills|Habilidades|Aptitudes)\s*(?:All\s*Industry Knowledge\s*Tools & Technologies\s*Interpersonal Skills\s*(?:Languages\s*)?Other Skills\s*)?/i,
      certifications: /^(Licenses\s*&\s*certifications|Licencias y certificaciones)\s*/i,
      projects: /^(Projects|Proyectos)\s*/i,
      courses: /^(Courses|Cursos)\s*/i,
      honors: /^(Honors\s*&\s*awards|Honores)\s*/i,
    };
    if (STRIP[sec]) text = text.replace(STRIP[sec], "");
    return text.trim();
  }, section);
}

const AI_SCHEMAS = {
  education: {
    type: "object", additionalProperties: false,
    properties: {
      education: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            school: { type: "string" }, degree: { type: "string" },
            field: { type: "string" }, dates: { type: "string" },
            description: { type: "string" },
          },
          required: ["school", "degree", "field", "dates", "description"],
        },
      },
    },
    required: ["education"],
  },
  skills: {
    type: "object", additionalProperties: false,
    properties: { skills: { type: "array", items: { type: "string" } } },
    required: ["skills"],
  },
  certifications: {
    type: "object", additionalProperties: false,
    properties: {
      certifications: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            name: { type: "string" }, issuer: { type: "string" },
            issued: { type: "string" }, credential_id: { type: "string" },
          },
          required: ["name", "issuer", "issued", "credential_id"],
        },
      },
    },
    required: ["certifications"],
  },
  projects: {
    type: "object", additionalProperties: false,
    properties: {
      projects: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            name: { type: "string" }, dates: { type: "string" },
            description: { type: "string" },
          },
          required: ["name", "dates", "description"],
        },
      },
    },
    required: ["projects"],
  },
  courses: {
    type: "object", additionalProperties: false,
    properties: { courses: { type: "array", items: { type: "string" } } },
    required: ["courses"],
  },
};

const AI_PROMPTS = {
  education:
    "Extract education entries from this LinkedIn /details/education/ section text. " +
    "Copy values verbatim. School is the institution name. Degree is the degree type " +
    "(e.g. 'Bachelor of Science', 'Master of Business Administration', 'Licenciatura'). " +
    "Field is the field of study (e.g. 'Computer Science', 'Mathematics'). Dates is the " +
    "year range (e.g. '2018 – 2022'). Description carries any extra notes if present, " +
    "otherwise empty string.",
  skills:
    "Extract the candidate's skill NAMES from this LinkedIn /details/skills/ text. " +
    "Skills are typically Title Case nouns or short phrases of 1-4 words such as " +
    "'Python', 'Distributed Systems', 'Project Management', 'Drupal'. Filter the text — " +
    "DO NOT include filter tab labels ('All', 'Industry Knowledge', 'Tools & Technologies', " +
    "'Interpersonal Skills', 'Languages', 'Other Skills'). DO NOT include the context " +
    "(company names, job titles like 'Senior Software Engineer at GFT Technologies') " +
    "that follows each skill — those describe where the skill was used, not the skill " +
    "itself. Return just the skill names.",
  certifications:
    "Extract certification entries from this LinkedIn /details/certifications/ text. " +
    "Each entry has a name (e.g. 'AWS Certified Solutions Architect'), an issuer " +
    "(e.g. 'Amazon Web Services'), an issued date (e.g. 'Issued Jan 2023' or 'Jan 2023'), " +
    "and optionally a credential_id. If the section reads 'Nothing to see for now', return " +
    "an empty array.",
  projects:
    "Extract project entries from this LinkedIn /details/projects/ text. Each entry " +
    "has a name (the project's title), dates (e.g. 'Apr 2025 – Present'), and a " +
    "description (the bullet list / paragraph that follows).",
  courses:
    "Extract course names from this LinkedIn /details/courses/ text. Return a flat list " +
    "of strings, one per course title (include the instructor / institution in parens if " +
    "present, exactly as written).",
};

async function aiExtractSection(section, rawText) {
  if (!OPENAI_API_KEY) {
    console.warn(`[ai] no OPENAI key; ${section} extraction skipped`);
    return null;
  }
  if (!rawText || rawText.length < 12) return null;
  const schema = AI_SCHEMAS[section];
  const prompt = AI_PROMPTS[section];
  if (!schema || !prompt) return null;
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You extract structured LinkedIn profile data from raw page text. Output strict JSON that matches the schema. Copy values verbatim from the input; do not invent fields." },
          { role: "user", content: `${prompt}\n\n--- Input text ---\n${rawText.slice(0, 5000)}` },
        ],
        response_format: { type: "json_schema", json_schema: { name: section, schema, strict: true } },
        temperature: 0,
      }),
    });
    const body = await r.json();
    if (!r.ok) {
      console.warn(`[ai] ${section} HTTP ${r.status}: ${body.error?.message || JSON.stringify(body).slice(0, 200)}`);
      return null;
    }
    return JSON.parse(body.choices[0].message.content);
  } catch (err) {
    console.warn(`[ai] ${section} error:`, err.message);
    return null;
  }
}

async function scrapeProfileFull(page, url) {
  const top = await scrapeProfileTopCard(page, url);

  // Experience: UL-based, structural parser works.
  const expItems = await scrapeDetailsSubpageRaw(page, url, "experience");

  // Other sections render as <div> structures with hashed classes — get raw
  // textContent and let an LLM extract structured records.
  const eduText = await scrapeSubpageText(page, url, "education");
  const skillsText = await scrapeSubpageText(page, url, "skills");
  const certsText = await scrapeSubpageText(page, url, "certifications");
  const projText = await scrapeSubpageText(page, url, "projects");
  const coursesText = await scrapeSubpageText(page, url, "courses");

  const [eduJson, skillsJson, certsJson, projJson, coursesJson] = await Promise.all([
    aiExtractSection("education", eduText),
    aiExtractSection("skills", skillsText),
    aiExtractSection("certifications", certsText),
    aiExtractSection("projects", projText),
    aiExtractSection("courses", coursesText),
  ]);

  return {
    page_title: top.full_name ? `${top.full_name} | LinkedIn` : "",
    full_name: top.full_name || "",
    headline: top.headline || "",
    location: top.location || "",
    about: top.about || "",
    experience: parseExperienceItems(expItems),
    education: (eduJson && eduJson.education) || [],
    skills: (skillsJson && skillsJson.skills) || [],
    certifications: (certsJson && certsJson.certifications) || [],
    projects: (projJson && projJson.projects) || [],
    courses: (coursesJson && coursesJson.courses) || [],
  };
}

// ── Workflow step driver ────────────────────────────────────────────────────

async function waitForChallengeClear(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    await sleep(3000);
    const cur = page.url();
    if (cur !== last) { console.log("  url ->", cur); last = cur; }
    if (!/checkpoint|login|authwall/i.test(cur)) return true;
  }
  return false;
}

// ── Main ────────────────────────────────────────────────────────────────────

const runId = await postOdooWebhook();
console.log(`Webhook fired. Run: ${runId}`);

const run = await getRun(runId);
const workflowId = run.workflow_id;
console.log(`Workflow: ${workflowId}, total_steps=${run.total_steps}`);

const wf = await getWorkflowSteps(workflowId);
const wfSteps = wf.steps || [];

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome", headless: false,
  viewport: { width: 1440, height: 900 },
  args: [
    "--no-sandbox", "--disable-blink-features=AutomationControlled",
    "--no-first-run", "--no-default-browser-check",
    "--disable-features=ChromeWhatsNewUI", "--profile-directory=Default",
  ],
  ignoreDefaultArgs: ["--enable-automation"],
});
await ctx.addInitScript(STEALTH_INIT);

const searchUrl =
  `https://www.linkedin.com/search/results/people/` +
  `?keywords=${encodeURIComponent(JOB_TITLE)}&origin=SWITCH_SEARCH_VERTICAL`;
const searchUrlPage2 = `${searchUrl}&page=2`;

try {
  let page = ctx.pages()[0] || (await ctx.newPage());

  // Step 0 — navigate /feed/ (session warm-up)
  console.log("step 0: navigate /feed/");
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(jitter(2500, 1500));
  if (/checkpoint|login|authwall/i.test(page.url())) {
    console.log("Challenge — solve in browser within 15 min");
    if (!(await waitForChallengeClear(page, 15 * 60_000))) {
      throw new Error(`Challenge not cleared: ${page.url()}`);
    }
  }
  await reportStepResult(runId, 0, "navigate");

  // Step 1 — noise_break (idle scroll)
  console.log("step 1: noise_break");
  await humanScroll(page, 4);
  await reportStepResult(runId, 1, "noise_break");

  // Step 2 — navigate search URL
  console.log("step 2: navigate search");
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(jitter(3000, 1500));
  await reportStepResult(runId, 2, "navigate");

  // Step 3 — extract profile URLs from page 1
  console.log("step 3: extract page 1 URLs");
  const page1Urls = await scrapeSearchProfileUrls(page);
  console.log(`  page1: ${page1Urls.length} URLs`);
  await postExtraction(runId, 3, page.url(), {
    page_title: await page.title(),
    url: page.url(),
    profile_urls: page1Urls,
  });
  await reportStepResult(runId, 3, "extract");

  // Step 4 — navigate to search page 2
  console.log("step 4: navigate search page 2");
  await page.goto(searchUrlPage2, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(jitter(3000, 1500));
  await reportStepResult(runId, 4, "navigate");

  // Step 5 — extract profile URLs from page 2
  console.log("step 5: extract page 2 URLs");
  const page2Urls = await scrapeSearchProfileUrls(page);
  console.log(`  page2: ${page2Urls.length} URLs`);
  await postExtraction(runId, 5, page.url(), {
    page_title: await page.title(),
    url: page.url(),
    profile_urls: page2Urls,
  });
  await reportStepResult(runId, 5, "extract");

  // Step 6 — for_each: expand into per-profile inner steps, then drive them
  console.log("step 6: expand for_each");
  const expansion = await expandForEach(runId, 6);
  console.log(`  expansion: ${expansion.iterations} iterations`);
  // Report the for_each step itself as done — backend bumps current_step_index to 7.
  await reportStepResult(runId, 6, "for_each");

  // Re-fetch run state to see the new total_steps + expanded steps.
  let cur = await getRun(runId);
  console.log(`  new total_steps=${cur.total_steps}, starting iteration drive`);
  const expandedSteps =
    (cur.workflow_snapshot && cur.workflow_snapshot.steps) || expansion.steps || [];

  // Walk every step from current_step_index forward.
  while (cur.current_step_index < cur.total_steps && cur.status === "running") {
    const idx = cur.current_step_index;
    const step = expandedSteps[idx] || {};
    const action = String(step.action_type || "");
    const value = String(step.value || "");
    console.log(`step ${idx}: ${action} ${value.slice(0, 80)}`);

    if (action === "navigate") {
      const target = step._for_each_item || value;
      if (/^https?:/.test(target)) {
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(jitter(2500, 1500));
      }
      await reportStepResult(runId, idx, "navigate");
    } else if (action === "extract") {
      const profileUrl = page.url();
      // Re-scrape on the current profile page — this also visits the
      // /details/ subpages internally before returning the dossier.
      const data = await scrapeProfileFull(page, profileUrl);
      console.log(
        `  -> "${data.full_name}" | "${(data.headline || "").slice(0, 80)}" | ` +
        `about=${(data.about || "").length}ch exp=${data.experience.length} ` +
        `edu=${data.education.length} skills=${data.skills.length} certs=${data.certifications.length}`
      );
      await postExtraction(runId, idx, profileUrl, data);
      await reportStepResult(runId, idx, "extract");
    } else if (action === "noise_break") {
      await sleep(jitter(2000, 2000));
      await humanScroll(page, 2);
      await reportStepResult(runId, idx, "noise_break");
    } else {
      // Unknown — best-effort: skip with success so the run can complete.
      console.log(`  unhandled action_type='${action}', marking success`);
      await reportStepResult(runId, idx, action || "noop");
    }

    cur = await getRun(runId);
  }

  console.log(`Final status: ${cur.status} (step ${cur.current_step_index}/${cur.total_steps})`);
} finally {
  await ctx.close().catch(() => {});
}

console.log("");
console.log(`Run page: http://localhost:5173/runs/${runId}`);
console.log(`Verify Odoo:`);
console.log(`  psql -h localhost -U odoo -d morsoft -c "SELECT id, partner_name, linkedin, easy_recruit_status FROM hr_applicant WHERE job_id=${JOB_ID} ORDER BY id DESC LIMIT 5;"`);
