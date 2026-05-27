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

async function scrapeProfile(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  // Profile pages are SPAs. Wait for the top-card section to render — keyed
  // off `data-view-name="profile-top-card"` (covers en + es + i18n variants).
  try {
    await page.waitForSelector(
      '[data-view-name="profile-top-card"], section[componentkey*="Topcard"]',
      { timeout: 20000, state: "attached" },
    );
  } catch {}
  await sleep(jitter(2500, 1500));
  await humanScroll(page, 6);
  await sleep(jitter(1500, 1000));

  return await page.evaluate(() => {
    const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
    const txt = (el) => clean(el?.textContent || "");

    // ── name from top-card ────────────────────────────────────────────────
    const topCard =
      document.querySelector('[data-view-name="profile-top-card"]') ||
      document.querySelector('section[componentkey*="Topcard"]');
    let full_name = "";
    if (topCard) {
      const h2 = topCard.querySelector("h2");
      if (h2) full_name = txt(h2);
    }
    // Fall back to the first sufficiently long h2 anywhere on the page.
    if (!full_name) {
      const headings = Array.from(document.querySelectorAll("h2")).map((h) => txt(h));
      // Skip nav-y h2s like "0 notificaciones", "Recent entity history".
      const NAV = /^\d|notification|notificaci|history|historial|recent|opciones|gente|peopl|advert|publici/i;
      full_name = headings.find((t) => t.length >= 3 && t.length <= 80 && !NAV.test(t)) || "";
    }

    // ── headline: text element immediately below the name in top card ─────
    let headline = "";
    if (topCard) {
      // Walk siblings/descendants for a non-empty short text not equal to the name.
      const walker = topCard.querySelectorAll("div");
      for (const d of walker) {
        if (d.children.length === 0) {
          const t = clean(d.textContent);
          if (
            t &&
            t !== full_name &&
            t.length > 5 &&
            t.length < 250 &&
            !/^\d|see|connect|conexión|seguir|message|mensaj|opciones|notificaci/i.test(t)
          ) {
            headline = t;
            break;
          }
        }
      }
    }

    // ── sections: by data-view-name AND by heading text ───────────────────
    function sectionByView(name) {
      const el = document.querySelector(`[data-view-name="${name}"]`);
      if (!el) return "";
      return clean(el.textContent).slice(0, 3500);
    }
    function sectionByHeading(...candidates) {
      const want = candidates.map((s) => s.toLowerCase());
      const h2s = Array.from(document.querySelectorAll("h2"));
      for (const h of h2s) {
        const t = (h.textContent || "").trim().toLowerCase();
        if (want.includes(t)) {
          const sec = h.closest("section") || h.parentElement;
          if (sec) return clean(sec.textContent).slice(0, 3500);
        }
      }
      return "";
    }

    const about =
      sectionByView("profile-card-about") ||
      sectionByHeading("about", "acerca de", "sobre");
    const experienceText =
      sectionByView("profile-card-experience") ||
      sectionByHeading("experience", "experiencia");
    const educationText =
      sectionByView("profile-card-education") ||
      sectionByHeading("education", "educación", "formación");
    const skillsText =
      sectionByView("profile-card-skills") ||
      sectionByHeading("skills", "aptitudes");

    function parseExperienceRecords(raw) {
      if (!raw) return [];
      const out = [];
      const seen = new Set();
      const re = /([A-Z][^·\n]{1,60})\s+(?:at|@)\s+([A-Z][^·\n]{1,60})/g;
      let m;
      while ((m = re.exec(raw)) !== null && out.length < 4) {
        const key = m[1] + "|" + m[2];
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ title: m[1].trim(), company: m[2].trim(), dates: "", description: "" });
      }
      return out;
    }

    return {
      page_title: document.title || "",
      full_name,
      headline,
      about,
      skills: skillsText ? skillsText.split(/\s+/).filter((w) => w.length > 2).slice(0, 12) : [],
      experience: parseExperienceRecords(experienceText),
      education: educationText ? [{ school: educationText.slice(0, 160), degree: "", field: "", dates: "" }] : [],
      certifications: [],
      projects: [],
    };
  });
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
      console.log(`     about=${(data.about || "").length}ch experience=${data.experience.length}`);
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
