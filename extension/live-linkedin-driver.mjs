/**
 * Live LinkedIn driver — end-to-end test of the new-job webhook → applicant
 * push integration, using the user's REAL Chrome Profile 4 snapshot for max
 * anti-bot resistance (logged-in cookies, aged history, real fingerprint).
 *
 * Workflow:
 *   1) Fire the new_job_position webhook → backend creates a run with origin
 *   2) Launch real Chrome 148 with the staged Profile 4 snapshot + stealth
 *      init script (defeats navigator.webdriver, plugin/WebGL/permission
 *      fingerprints).
 *   3) Warm up on /feed/ with human-like scrolling.
 *   4) Search /search/results/people/?keywords=… and scrape profile URLs.
 *   5) Visit the top N profiles, extract name/headline/about/experience.
 *   6) POST each extraction to the run with the profile URL.
 *   7) Complete the run → terminal hook pushes to Odoo.
 *
 * Prerequisites:
 *   - Run prepare-stealth-profile.mjs first to stage extension/.linkedin-profile
 *   - Backend on localhost:8081 (make dev-backend)
 *   - Local Odoo on localhost:8070
 *
 * Run:
 *   node live-linkedin-driver.mjs
 *
 * Env overrides:
 *   CONNECTOR_ID, JOB_ID, JOB_TITLE, PROFILE_LIMIT
 */
import { chromium } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROFILE_DIR = path.resolve(__dirname, ".linkedin-profile");

const BACKEND = process.env.BACKEND || "http://localhost:8081";
const API_KEY = process.env.API_KEY || "dev-api-key-change-in-production";
const CONNECTOR_ID = process.env.CONNECTOR_ID || "5dd56944-daee-4674-9ca5-3b55a67ea1a4";
const JOB_ID = Number(process.env.JOB_ID || "4");
const JOB_TITLE = process.env.JOB_TITLE || "Software Engineer";
const PROFILE_LIMIT = Number(process.env.PROFILE_LIMIT || "2");

const HEADERS = { "X-API-Key": API_KEY, "Content-Type": "application/json" };

// Human-ish jittered delay.
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function jitter(baseMs, spreadMs) {
  return baseMs + Math.floor(Math.random() * spreadMs);
}

// ── Backend API ─────────────────────────────────────────────────────────────

async function postOdooWebhook() {
  const payload = {
    job_id: JOB_ID,
    name: JOB_TITLE,
    job_title: JOB_TITLE,
    job_description: `Live E2E test driver for job ${JOB_ID}.`,
  };
  const r = await fetch(`${BACKEND}/v1/webhooks/incoming/odoo/${CONNECTOR_ID}`, {
    method: "POST", headers: HEADERS, body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`webhook POST failed: ${r.status} ${await r.text()}`);
  const body = await r.json();
  if (!body.triggered_runs?.length) {
    throw new Error(`webhook fired but no runs triggered: ${JSON.stringify(body)}`);
  }
  return body.triggered_runs[0];
}

async function postExtraction(runId, stepIndex, profileUrl, data) {
  const r = await fetch(`${BACKEND}/v1/runs/${runId}/extraction`, {
    method: "POST", headers: HEADERS,
    body: JSON.stringify({ step_index: stepIndex, data: [data], url: profileUrl }),
  });
  if (!r.ok) throw new Error(`extraction POST failed: ${r.status} ${await r.text()}`);
}

async function completeRun(runId) {
  const r = await fetch(`${BACKEND}/v1/runs/${runId}/complete`, {
    method: "POST", headers: HEADERS,
  });
  if (!r.ok) throw new Error(`complete failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// ── Stealth init script (mirrors fixtures.ts; runs in every page) ───────────

const STEALTH_INIT = () => {
  try {
    // Function.prototype.toString — native-shape masking
    const nativeToString = Function.prototype.toString;
    const toStringMap = new WeakMap();
    const proxiedToString = new Proxy(nativeToString, {
      apply(target, thisArg, args) {
        const canned = toStringMap.get(thisArg);
        if (canned) return canned;
        return Reflect.apply(target, thisArg, args);
      },
    });
    Function.prototype.toString = proxiedToString;
    toStringMap.set(proxiedToString, "function toString() { [native code] }");
    const maskNative = (fn, name) => {
      toStringMap.set(fn, `function ${name}() { [native code] }`);
      return fn;
    };

    // navigator.webdriver
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true });
    } catch { /* */ }

    // navigator.plugins
    const pluginNames = ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer", "Microsoft Edge PDF Viewer", "WebKit built-in PDF"];
    const fakePlugins = pluginNames.map((name) => ({
      name, filename: "internal-pdf-viewer", description: "Portable Document Format", length: 1,
      0: { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
    }));
    const pluginArrayProxy = new Proxy(fakePlugins, {
      get(target, prop) {
        if (prop === "length") return target.length;
        if (prop === "item") return (i) => target[i];
        if (prop === "namedItem") return (n) => target.find((p) => p.name === n);
        if (typeof prop === "string" && /^\d+$/.test(prop)) return target[Number(prop)];
        return Reflect.get(target, prop);
      },
    });
    try {
      Object.defineProperty(navigator, "plugins", { get: () => pluginArrayProxy, configurable: true });
      Object.defineProperty(navigator, "mimeTypes", {
        get: () => [{ type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" }],
        configurable: true,
      });
    } catch { /* */ }

    // navigator.languages
    try {
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"], configurable: true });
    } catch { /* */ }

    // navigator.permissions.query — notifications stays "default"
    try {
      const originalQuery = navigator.permissions.query.bind(navigator.permissions);
      const patchedQuery = function query(p) {
        if (p && p.name === "notifications") {
          return Promise.resolve({
            state: "default", name: "notifications", onchange: null,
            addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
          });
        }
        return originalQuery(p);
      };
      navigator.permissions.query = maskNative(patchedQuery, "query");
    } catch { /* */ }

    // window.chrome.runtime — real Chrome has this; headless / unbranded chromium doesn't
    try {
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.runtime) {
        window.chrome.runtime = {
          OnInstalledReason: { CHROME_UPDATE: "chrome_update", INSTALL: "install", SHARED_MODULE_UPDATE: "shared_module_update", UPDATE: "update" },
          OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
          PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
          PlatformOs: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" },
          RequestUpdateCheckStatus: { NO_UPDATE: "no_update", THROTTLED: "throttled", UPDATE_AVAILABLE: "update_available" },
        };
      }
    } catch { /* */ }

    // WebGL UNMASKED_VENDOR / UNMASKED_RENDERER
    try {
      const origGetParameter = WebGLRenderingContext.prototype.getParameter;
      const patchedGetParameter = function getParameter(p) {
        if (p === 37445) return "Intel Inc.";
        if (p === 37446) return "Intel Iris OpenGL Engine";
        return origGetParameter.call(this, p);
      };
      WebGLRenderingContext.prototype.getParameter = maskNative(patchedGetParameter, "getParameter");
      if (typeof WebGL2RenderingContext !== "undefined") {
        const origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
        const patchedGetParameter2 = function getParameter(p) {
          if (p === 37445) return "Intel Inc.";
          if (p === 37446) return "Intel Iris OpenGL Engine";
          return origGetParameter2.call(this, p);
        };
        WebGL2RenderingContext.prototype.getParameter = maskNative(patchedGetParameter2, "getParameter");
      }
    } catch { /* */ }

    // Notification.permission stays "default"
    try {
      if (typeof Notification !== "undefined") {
        Object.defineProperty(Notification, "permission", { get: () => "default", configurable: true });
      }
    } catch { /* */ }

    // hardwareConcurrency / deviceMemory
    try { Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8, configurable: true }); } catch { /* */ }
    try { Object.defineProperty(navigator, "deviceMemory", { get: () => 8, configurable: true }); } catch { /* */ }
  } catch (err) {
    console.warn("[stealth] init script error:", err);
  }
};

// ── LinkedIn scrapers ────────────────────────────────────────────────────────

async function humanScroll(page, rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await page.mouse.wheel(0, 400 + Math.floor(Math.random() * 400));
    await sleep(jitter(700, 800));
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

// Extract top-card data (name + headline + about) from a profile main page.
async function scrapeProfileTopCard(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  try {
    await page.waitForSelector(
      '[data-view-name="profile-top-card"], section[componentkey*="Topcard"]',
      { timeout: 20000, state: "attached" },
    );
  } catch {}
  await sleep(jitter(2500, 1500));
  await humanScroll(page, 7);
  // Wait for about card OR a few seconds, whichever first.
  try {
    await page.waitForSelector('[data-view-name="profile-card-about"]', {
      timeout: 6000, state: "attached",
    });
  } catch {}
  await sleep(jitter(1500, 1000));

  return await page.evaluate(() => {
    const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
    const txt = (el) => clean(el?.textContent || "");

    const topCard =
      document.querySelector('[data-view-name="profile-top-card"]') ||
      document.querySelector('section[componentkey*="Topcard"]');

    // Name = h2 inside top card (LinkedIn moved this out of h1 in 2025).
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

    // Headline = first leaf <p> in top-card that's not a degree-badge.
    // Degree badges look like "· 1er", "• 2º", "· 3rd", etc.
    const DEGREE_RE = /^[·•]?\s*\d+(?:er|º|st|nd|rd|th)\s*$/;
    let headline = "";
    if (topCard) {
      const leafPs = Array.from(topCard.querySelectorAll("p")).filter(
        (p) => p.children.length === 0,
      );
      for (const p of leafPs) {
        const t = clean(p.textContent);
        if (!t || t === full_name) continue;
        if (DEGREE_RE.test(t)) continue;
        if (t.length < 5 || t.length > 250) continue;
        if (/^[·•]/.test(t)) continue;
        headline = t;
        break;
      }
    }

    // About text. Try the dedicated profile-card-about section, fall back to
    // matching an h2 with heading text in en/es and reading its parent section.
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
    // Strip the leading section title ("About"/"Acerca de") possibly
    // duplicated for screen-reader twin.
    about = about
      .replace(/^(About|Acerca de|Sobre)(?:\s*\1)?/i, "")
      .trim()
      .slice(0, 4000);

    // Location: line 4-5 in the topcard leaf list, after the company/school chips.
    let location = "";
    if (topCard) {
      const leafPs = Array.from(topCard.querySelectorAll("p")).filter((p) => p.children.length === 0);
      // The location often contains words like "Area", "Region", "City", "Metropolitan",
      // or a country/state name. Heuristic: pick the leaf <p> that's not the name,
      // not a degree, not the headline, and not the chip-row (contains " · " separator).
      for (const p of leafPs) {
        const t = clean(p.textContent);
        if (!t || t === full_name || t === headline) continue;
        if (DEGREE_RE.test(t)) continue;
        if (/[·•]/.test(t) && t.split(/[·•]/).length > 2) continue;
        if (/Area|Region|City|Metropolitan|País|Country|Greater/i.test(t)) {
          location = t;
          break;
        }
      }
    }

    return { full_name, headline, about, location };
  });
}

// Extract <li>-based records from a /details/<section>/ subpage.
async function scrapeDetailsSubpage(page, profileBase, section) {
  const url = `${profileBase.replace(/\/$/, "")}/details/${section}/`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch {
    return [];
  }
  await sleep(jitter(2500, 1200));
  // Scroll deep so all lazy-loaded entries render before we read them.
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 700);
    await sleep(jitter(500, 300));
  }
  await sleep(jitter(1500, 800));

  return await page.evaluate(() => {
    const clean = (s) => (s || "").trim().replace(/\s+/g, " ");

    // /details/ pages render entries as <li> inside <ul>. Each entry contains
    // multiple <span> chunks; LinkedIn historically used aria-hidden="true"
    // spans for the visible text + a screen-reader twin, but the newer SDUI
    // layout uses plain <span> nodes. Try aria-hidden first; fall back to
    // all leaf <span> nodes if none. Last resort: split li.textContent by
    // line breaks / multiple spaces.
    function chunksFromLi(li) {
      const ariaSpans = li.querySelectorAll('span[aria-hidden="true"]');
      const candidates = ariaSpans.length > 0
        ? Array.from(ariaSpans)
        : Array.from(li.querySelectorAll("span")).filter((s) => s.children.length === 0);
      let chunks = candidates
        .map((s) => clean(s.textContent))
        .filter((t) => t && t.length < 800);
      if (chunks.length === 0) {
        // Final fallback: split by newline-equivalent boundaries.
        chunks = clean(li.textContent || "")
          .split(/\s{2,}|·{1,}|·/)
          .map((s) => s.trim())
          .filter((t) => t.length > 1 && t.length < 800);
      }
      const seen = new Set();
      const ordered = [];
      for (const c of chunks) {
        if (seen.has(c)) continue;
        seen.add(c);
        ordered.push(c);
      }
      return ordered;
    }

    // Find the actual content list. The /details/skills/ page has a tab nav
    // ("All", "Industry Knowledge", "Tools & Technologies") that's also a
    // <ul>, and its li count rivals the content list. Pick the <ul> whose
    // direct <li> children carry the most total text (content > nav). Also
    // skip lists with role=tablist or inside <nav>.
    const main = document.querySelector("main") || document.body;
    const candidates = Array.from(main.querySelectorAll("ul"))
      .filter((ul) => {
        if (ul.closest("nav")) return false;
        if (ul.getAttribute("role") === "tablist") return false;
        return true;
      });
    let bestUl = null;
    let bestScore = 0;
    candidates.forEach((ul) => {
      const direct = Array.from(ul.children).filter((c) => c.tagName === "LI");
      if (direct.length === 0) return;
      // Score: total textContent length across direct li children; if the
      // average per-li text is < 10 (tab nav with single-word labels), drop.
      const total = direct.reduce((acc, li) => acc + (li.textContent || "").length, 0);
      const avg = total / direct.length;
      if (avg < 20) return; // filter tab navs / short-label lists
      if (total > bestScore) {
        bestScore = total;
        bestUl = ul;
      }
    });
    if (!bestUl) return [];

    const items = Array.from(bestUl.children).filter((c) => c.tagName === "LI");
    return items.map(chunksFromLi).filter((row) => row.length > 0);
  });
}

// Compose structured records from the raw chunk arrays of a /details/ subpage.
function parseExperienceChunks(chunkRows) {
  // Per row, the first chunk is typically the title, the second the company
  // (sometimes followed by " · Full-time"), the third the date range, the
  // fourth a duration, the fifth the location, the rest description bullets.
  const out = [];
  for (const row of chunkRows) {
    if (!row || row.length === 0) continue;
    const [title = "", company = "", dates = "", duration = "", location = "", ...rest] = row;
    out.push({
      title,
      company: (company || "").split(" · ")[0],
      employment_type: (company || "").includes(" · ") ? company.split(" · ").slice(1).join(" · ") : "",
      dates,
      duration,
      location,
      description: rest.join("\n").slice(0, 1500),
    });
    if (out.length >= 12) break;
  }
  return out;
}
function parseEducationChunks(chunkRows) {
  const out = [];
  for (const row of chunkRows) {
    if (!row || row.length === 0) continue;
    const [school = "", field = "", dates = "", ...rest] = row;
    out.push({
      school,
      field,
      degree: rest.find((s) => /degree|grado|bachiller|master|maestría/i.test(s)) || "",
      dates,
      description: rest.join("\n").slice(0, 800),
    });
    if (out.length >= 8) break;
  }
  return out;
}
function parseSkillsChunks(chunkRows) {
  // Skills are usually one chunk per row (the skill name), occasionally
  // followed by a small "endorsement" subchunk.
  const out = [];
  for (const row of chunkRows) {
    if (!row || row.length === 0) continue;
    const name = row[0];
    if (name && name.length < 80) out.push(name);
    if (out.length >= 40) break;
  }
  return out;
}
function parseCertificationChunks(chunkRows) {
  const out = [];
  for (const row of chunkRows) {
    if (!row || row.length === 0) continue;
    const [name = "", issuer = "", issued = "", ...rest] = row;
    out.push({ name, issuer, issued, credential_id: rest.join(" ").slice(0, 200) });
    if (out.length >= 12) break;
  }
  return out;
}

async function scrapeProfile(page, url) {
  // 1) Top card → name, headline, about, location.
  const top = await scrapeProfileTopCard(page, url);

  // 2) Visit each /details/ subpage. LinkedIn 200s these even when empty.
  const expChunks = await scrapeDetailsSubpage(page, url, "experience");
  const eduChunks = await scrapeDetailsSubpage(page, url, "education");
  const skillsChunks = await scrapeDetailsSubpage(page, url, "skills");
  const certsChunks = await scrapeDetailsSubpage(page, url, "certifications");

  return {
    page_title: top.full_name ? `${top.full_name} | LinkedIn` : "",
    full_name: top.full_name || "",
    headline: top.headline || "",
    location: top.location || "",
    about: top.about || "",
    experience: parseExperienceChunks(expChunks),
    education: parseEducationChunks(eduChunks),
    skills: parseSkillsChunks(skillsChunks),
    certifications: parseCertificationChunks(certsChunks),
    projects: [],
  };
}

async function waitForChallengeClear(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    await sleep(3000);
    const cur = page.url();
    if (cur !== last) {
      console.log("  url ->", cur);
      last = cur;
    }
    if (!/checkpoint|login|authwall/i.test(cur)) return true;
  }
  return false;
}

// ── Main ────────────────────────────────────────────────────────────────────

const runId = await postOdooWebhook();
console.log(`Webhook fired. Run: ${runId}`);

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [
    "--no-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=ChromeWhatsNewUI",
    // The user-data-dir we point at HAS a "Default" profile. Be explicit so
    // Chrome doesn't decide it wants a different one.
    "--profile-directory=Default",
  ],
  ignoreDefaultArgs: ["--enable-automation"],
});

// Install stealth init script — runs at document_start in every frame/page.
await ctx.addInitScript(STEALTH_INIT);

try {
  let page = ctx.pages()[0] || (await ctx.newPage());

  console.log("Warming up on /feed/ ...");
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(jitter(3000, 1500));

  if (/checkpoint|login|authwall/i.test(page.url())) {
    console.log("");
    console.log("=".repeat(70));
    console.log("LinkedIn challenge detected — solve it in the open Chrome window.");
    console.log("URL:", page.url());
    console.log("Waiting up to 20 minutes for you to clear it...");
    console.log("=".repeat(70));
    const cleared = await waitForChallengeClear(page, 20 * 60_000);
    if (!cleared) throw new Error(`Challenge not cleared in time: ${page.url()}`);
    console.log("Challenge cleared. URL:", page.url());
    await sleep(2500);
  }

  await humanScroll(page, 3);

  const searchUrl =
    `https://www.linkedin.com/search/results/people/` +
    `?keywords=${encodeURIComponent(JOB_TITLE)}&origin=SWITCH_SEARCH_VERTICAL`;
  console.log(`Navigating to search for "${JOB_TITLE}"...`);
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(jitter(3500, 2000));

  if (/checkpoint|login|authwall/i.test(page.url())) {
    console.log("Challenge on search page. Waiting...");
    const cleared = await waitForChallengeClear(page, 15 * 60_000);
    if (!cleared) throw new Error(`Challenge not cleared on search: ${page.url()}`);
  }

  const profileUrls = await scrapeSearchProfileUrls(page);
  console.log(`Found ${profileUrls.length} profile URLs.`);
  if (profileUrls.length === 0) {
    await page.screenshot({ path: "live-empty-search.png" });
    throw new Error("Search returned 0 profile URLs (see live-empty-search.png).");
  }
  console.log("First 5 URLs:", profileUrls.slice(0, 5));

  const top = profileUrls.slice(0, PROFILE_LIMIT);
  let stepIndex = 10;
  for (const url of top) {
    console.log(`Visiting: ${url}`);
    try {
      const data = await scrapeProfile(page, url);
      console.log(`  -> "${data.full_name}" | "${(data.headline || "").slice(0, 80)}"`);
      console.log(
        `     about=${(data.about || "").length}ch ` +
          `experience=${data.experience.length} ` +
          `education=${data.education.length} ` +
          `skills=${data.skills.length} ` +
          `certs=${data.certifications.length} ` +
          `location="${data.location || ""}"`,
      );
      await postExtraction(runId, stepIndex++, url, data);
    } catch (err) {
      console.error(`  ! scrape failed:`, err?.message || err);
    }
    await sleep(jitter(3000, 2500));
  }
} finally {
  await ctx.close().catch(() => {});
}

const result = await completeRun(runId);
console.log("Run completed:", result);
console.log("");
console.log(`Verify Odoo:`);
console.log(`  psql -h localhost -U odoo -d morsoft -c "SELECT id, partner_name, linkedin, job_id, easy_recruit_status FROM hr_applicant WHERE job_id=${JOB_ID} ORDER BY id DESC LIMIT 5;"`);
