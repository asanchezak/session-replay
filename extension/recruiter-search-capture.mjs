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

// Candidate selectors for the Recruiter search box — refined offline from the
// landing snapshot. First visible match wins.
const SEARCH_INPUT_CANDIDATES = [
  '[role="combobox"][aria-label*="Search" i]',
  'input[aria-label*="Search by" i]',
  'input[placeholder*="Search" i]',
  'input[aria-label*="Search" i]',
  'input#global-typeahead-search-input',
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

  // Find the search input (best-effort; if none, we still have the landing HTML).
  let input = null, used = null;
  for (const c of SEARCH_INPUT_CANDIDATES) {
    const loc = page.locator(c).first();
    if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false)) { input = loc; used = c; break; }
  }
  if (!input) {
    log("no search input matched candidates — landing snapshot is enough to find it offline");
    result = "NO_SEARCH_INPUT";
  } else {
    log(`search input via: ${used}`);
    const box = await input.boundingBox().catch(() => null);
    if (box) { await moveMouseAlongBezier(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, rand).catch(() => {}); }
    await input.click({ timeout: 5000 }).catch(() => {});
    await think(1200, 2600);
    await input.type(KEYWORD, { delay: 90 + Math.floor(rand() * 80) }).catch(() => {});
    await think(1500, 3000);
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
    await think(4000, 7000);
    if (await blocked(page)) { await snapshotPage(page, { dir: OUT, stage: "BLOCKED-results" }); result = "BLOCKED"; throw new Error("blocked at results"); }
    await humanScrollSeeded(page, 2 + Math.floor(rand() * 2), rand).catch(() => {});
    await think(2000, 4000);
    await snapshotPage(page, { dir: OUT, stage: "02-search-results" });
    log(`captured 02-search-results url=${page.url()}`);
    result = "OK";
  }
} catch (e) {
  if (result === "RUNNING" || result === "ERROR") result = "ERROR";
  log("ERROR", e && e.message);
} finally {
  status(result);
  try { await ctx?.close(); } catch {}
  log("STATUS:", result);
}
