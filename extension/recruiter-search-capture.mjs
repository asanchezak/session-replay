/**
 * READ-ONLY capture of the LinkedIn Recruiter (/talent) SEARCH flow.
 *
 * Single deliberate live run to capture the HTML of (a) the search landing and
 * (b) a results page, so the search-input / submit / result-card selectors can be
 * locked OFFLINE via analyze-snapshot.mjs — never reloading the sensitive account.
 * (see feedback_recruiter_offline_selector_iteration)
 *
 * SAFETY: only navigates + types ONE keyword into the search box + submits +
 * reads. NEVER opens a profile, connects, saves, or messages. Aborts on any
 * login/checkpoint wall (no circuit-breaker writes — this is a probe).
 *
 * CONTEXT: must run as linkedin-bot (S4U task) so Chrome can DPAPI-decrypt the
 * staged Recruiter session in .linkedin-profile. Keep the daemon Disabled.
 *
 * Output: recruiter-snapshots/search-capture/{<stage>.html,.dom.json,.png,manifest.json}
 *         + STATUS  (OK | NO_SEARCH_INPUT | BLOCKED | ERROR)
 */
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { STEALTH_INIT } from "./src/shared/stealth.mjs";
import { isBlockerUrl, detectChallengeInPage } from "./src/behavior/blocker-detect.mjs";
import { createPageNav } from "./src/behavior/page-nav.mjs";
import { snapshotPage } from "./src/behavior/page-snapshot.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = resolve(__dirname, ".linkedin-profile");
const OUT = resolve(__dirname, "recruiter-snapshots", "search-capture");
mkdirSync(OUT, { recursive: true });

const KEYWORD = process.env.SEARCH_KEYWORD || "Full Stack Developer";
const { moveMouseAlongBezier, humanScrollSeeded } = createPageNav();
const rand = Math.random;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const think = (a = 2500, b = 6000) => sleep(a + Math.floor(rand() * (b - a)));
function status(s) { try { writeFileSync(resolve(OUT, "STATUS"), s + "\n"); } catch {} }
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

async function blocked(page) {
  if (isBlockerUrl(page.url())) return true;
  const ch = await detectChallengeInPage(page).catch(() => null);
  return !!ch;
}

// Recruiter /talent/home job-title search typeahead — locked offline from the
// captured home snapshot (run e24a66e1). Stable id. First match wins.
const SEARCH_INPUT_CANDIDATES = [
  'input#calling-job-search-typeahead-input',
  'input.ts-common-typeahead__input[placeholder*="cargo" i]',
  'input[placeholder*="cargo" i]',
  '[role="combobox"][aria-label*="Search" i]',
  'input[placeholder*="Search" i]',
  'textarea.copilot-chat-input__textbox',
];

let result = "ERROR", ctx;
status("RUNNING");
try {
  ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome", headless: false, viewport: { width: 1280, height: 720 },
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", "--disable-features=ChromeWhatsNewUI", "--profile-directory=Default"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  await ctx.addInitScript(STEALTH_INIT);
  const page = ctx.pages()[0] || await ctx.newPage();

  // WARM START: land on /talent/home like a real user (cold deep-link to
  // /talent/search bounces to /uas/login-cap; from a warm home it works — same
  // reason the recording never cold-linked search).
  log("goto /talent/home (warm start)");
  await page.goto("https://www.linkedin.com/talent/home", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
  await think(3000, 6000);
  if (await blocked(page)) { await snapshotPage(page, { dir: OUT, stage: "BLOCKED-home" }); result = "BLOCKED"; throw new Error("blocked at /talent/home — session not valid"); }
  await moveMouseAlongBezier(page, { x: 400 + rand() * 400, y: 250 + rand() * 200 }, rand).catch(() => {});
  await snapshotPage(page, { dir: OUT, stage: "01-talent-home" });
  log("captured 01-talent-home");

  // Get a POPULATED results page: click a saved-search history link (home lists
  // them; they re-run a real search) and WAIT for candidate cards to render —
  // Recruiter loads results async, so poll for profile links while scrolling.
  // (The home "Introduce el cargo" typeahead + Enter does NOT do a clean keyword
  // search — it picks a history item — so we use the history links directly.)
  const histLinks = page.locator('a[href*="/talent/search?searchHistoryId"]');
  const n = await histLinks.count().catch(() => 0);
  log(`history links on home: ${n}`);
  if (!n) {
    result = "NO_HISTORY_LINK";
  } else {
    // Prefer a job-title search (many candidates) over a by-name search.
    let target = histLinks.first();
    for (let i = 0; i < n; i++) {
      const t = (await histLinks.nth(i).innerText().catch(() => "")) || "";
      if (/administrator|developer|engineer|analyst|manager/i.test(t)) { target = histLinks.nth(i); break; }
    }
    await target.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
    await think(800, 1800);
    await target.click({ timeout: 8000 }).catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    await think(2000, 3500);
    if (await blocked(page)) { await snapshotPage(page, { dir: OUT, stage: "BLOCKED-results" }); result = "BLOCKED"; throw new Error("blocked at results"); }
    // Poll for candidate cards (async render); scroll to trigger lazy load.
    const CARD_SEL = 'a[href*="/talent/profile/"], a[href*="/talent/search/profile/"]';
    let cards = 0;
    for (let i = 0; i < 14; i++) {
      cards = await page.locator(CARD_SEL).count().catch(() => 0);
      if (cards > 0) break;
      await humanScrollSeeded(page, 1 + Math.floor(rand() * 2), rand).catch(() => {});
      await sleep(2500);
    }
    log(`candidate links rendered: ${cards}`);
    await think(1500, 3000);
    await snapshotPage(page, { dir: OUT, stage: "03-results-populated" });
    log(`captured 03-results-populated url=${page.url()} cards=${cards}`);
    result = cards > 0 ? "OK" : "OK_NO_CARDS";
  }
} catch (e) {
  if (result === "RUNNING" || result === "ERROR") result = "ERROR";
  log("ERROR", e && e.message);
} finally {
  status(result);
  try { await ctx?.close(); } catch {}
  log("STATUS:", result);
}
