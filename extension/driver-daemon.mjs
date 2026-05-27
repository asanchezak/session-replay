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
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROFILE_DIR = path.resolve(__dirname, ".linkedin-profile");

const BACKEND = process.env.BACKEND || "http://localhost:8081";
const API_KEY = process.env.API_KEY || "dev-api-key-change-in-production";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || "5000");

const HEADERS = { "X-API-Key": API_KEY, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base, spread) => base + Math.floor(Math.random() * spread);

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
  const r = await fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${init.method || "GET"} ${url} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function findPendingRun() {
  const list = await fetchJson(`${BACKEND}/v1/runs?limit=20&status=running`);
  const items = Array.isArray(list) ? list : list.items || [];
  for (const r of items) {
    if (!r.origin) continue;
    if (r.origin.event_kind !== "new_job_position") continue;
    if (Array.isArray(r.extracted_data) && r.extracted_data.length > 0) continue;
    if (r.current_step_index > 0) continue; // already being driven
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
  await fetchJson(`${BACKEND}/v1/runs/${runId}/step-result`, {
    method: "POST",
    body: JSON.stringify({ step_index: stepIndex, action_type: actionType, success: true }),
  });
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

const AI_SCHEMAS = {
  education: { type: "object", additionalProperties: false, properties: { education: { type: "array", items: { type: "object", additionalProperties: false, properties: { school: { type: "string" }, degree: { type: "string" }, field: { type: "string" }, dates: { type: "string" }, description: { type: "string" } }, required: ["school", "degree", "field", "dates", "description"] } } }, required: ["education"] },
  skills: { type: "object", additionalProperties: false, properties: { skills: { type: "array", items: { type: "string" } } }, required: ["skills"] },
  certifications: { type: "object", additionalProperties: false, properties: { certifications: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, issuer: { type: "string" }, issued: { type: "string" }, credential_id: { type: "string" } }, required: ["name", "issuer", "issued", "credential_id"] } } }, required: ["certifications"] },
  projects: { type: "object", additionalProperties: false, properties: { projects: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, dates: { type: "string" }, description: { type: "string" } }, required: ["name", "dates", "description"] } } }, required: ["projects"] },
  courses: { type: "object", additionalProperties: false, properties: { courses: { type: "array", items: { type: "string" } } }, required: ["courses"] },
};
const AI_PROMPTS = {
  education: "Extract education entries from this LinkedIn /details/education/ section text. Copy verbatim.",
  skills: "Extract skill NAMES only. Skip filter tabs ('All','Industry Knowledge','Tools & Technologies','Interpersonal Skills','Languages','Other Skills') and skip company/job context.",
  certifications: "Extract certifications: name, issuer, issued date.",
  projects: "Extract projects: name, dates, description.",
  courses: "Extract course names as a list of strings.",
};

async function aiExtract(section, rawText) {
  if (!OPENAI_API_KEY || !rawText || rawText.length < 12) return null;
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Extract structured LinkedIn profile data. Output strict JSON. Copy values verbatim." },
          { role: "user", content: `${AI_PROMPTS[section]}\n\n--- Input ---\n${rawText.slice(0, 5000)}` },
        ],
        response_format: { type: "json_schema", json_schema: { name: section, schema: AI_SCHEMAS[section], strict: true } },
        temperature: 0,
      }),
    });
    const b = await r.json();
    if (!r.ok) { console.warn(`[ai] ${section} HTTP ${r.status}`); return null; }
    return JSON.parse(b.choices[0].message.content);
  } catch (err) { console.warn(`[ai] ${section} err`, err.message); return null; }
}

async function scrapeProfileFull(page, url) {
  const top = await scrapeProfileTopCard(page, url);
  const expItems = await scrapeExperienceItems(page, url);
  const eduText = await scrapeSubpageText(page, url, "education");
  const skillsText = await scrapeSubpageText(page, url, "skills");
  const certsText = await scrapeSubpageText(page, url, "certifications");
  const projText = await scrapeSubpageText(page, url, "projects");
  const coursesText = await scrapeSubpageText(page, url, "courses");
  const [edu, skills, certs, proj, courses] = await Promise.all([
    aiExtract("education", eduText),
    aiExtract("skills", skillsText),
    aiExtract("certifications", certsText),
    aiExtract("projects", projText),
    aiExtract("courses", coursesText),
  ]);
  return {
    page_title: top.full_name ? `${top.full_name} | LinkedIn` : "",
    full_name: top.full_name || "",
    headline: top.headline || "",
    location: top.location || "",
    about: top.about || "",
    experience: parseExperienceItems(expItems),
    education: edu?.education || [],
    skills: skills?.skills || [],
    certifications: certs?.certifications || [],
    projects: proj?.projects || [],
    courses: courses?.courses || [],
  };
}

// ── Run driver ──────────────────────────────────────────────────────────────

async function driveRun(run) {
  const runId = run.id;
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
      if (action === "navigate") {
        const target = step._for_each_item || value;
        if (/^https?:/.test(target)) {
          await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
          await sleep(jitter(2500, 1500));
        }
        await reportStepResult(runId, idx, "navigate");
      } else if (action === "extract") {
        const data = await scrapeProfileFull(page, page.url());
        console.log(`  step ${idx}: "${data.full_name}" headline="${(data.headline || "").slice(0, 60)}" edu=${data.education.length} skills=${data.skills.length} certs=${data.certifications.length}`);
        await postExtraction(runId, idx, page.url(), data);
        await reportStepResult(runId, idx, "extract");
      } else if (action === "noise_break") {
        await sleep(jitter(2000, 2000));
        await humanScroll(page, 2);
        await reportStepResult(runId, idx, "noise_break");
      } else {
        await reportStepResult(runId, idx, action || "noop");
      }
      cur = await getRun(runId);
    }
    console.log(`  done: status=${cur.status} step=${cur.current_step_index}/${cur.total_steps}`);
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ── Main poll loop ──────────────────────────────────────────────────────────

console.log(`[daemon] polling ${BACKEND}/v1/runs every ${POLL_INTERVAL_MS}ms`);
console.log(`[daemon] watching for runs with origin.event_kind=new_job_position`);

while (true) {
  try {
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
