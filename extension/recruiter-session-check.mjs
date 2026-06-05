/**
 * MINIMAL read-only LinkedIn Recruiter (Talent) SESSION check.
 *
 * Sole purpose: answer "is the daemon's .linkedin-profile logged into the
 * Recruiter/Talent seat, or do we need to sign in again?" — WITHOUT doing
 * anything on the account.
 *
 * SAFETY (hard rules):
 *   - ONE navigation to /talent/home. NO clicks, NO typing, NO scrolling into
 *     actions, NO profile views, NO search. Read-only.
 *   - Classifies the landing URL/DOM and exits. Never trips a circuit breaker.
 *
 * CONTEXT: must run in the SAME S4U/linkedin-bot logon context as the daemon so
 * Chrome can DPAPI-decrypt the staged session cookies (raw SSH network logon
 * gets a login wall regardless of session validity).
 *
 * Output: .debug/session-check/{home.png, result.json, STATUS}
 *   STATUS ∈ { LOGGED_IN, LOGIN_WALL, CHECKPOINT, ERROR }
 */
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { STEALTH_INIT } from "./src/shared/stealth.mjs";
import { isBlockerUrl, detectChallengeInPage } from "./src/behavior/blocker-detect.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = resolve(__dirname, ".linkedin-profile");
const OUT = resolve(__dirname, ".debug", "session-check");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function status(s) { try { writeFileSync(resolve(OUT, "STATUS"), s + "\n"); } catch {} }
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

let result = "ERROR";
let ctx;
status("RUNNING");
try {
  ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome", headless: false,
    viewport: { width: 1280, height: 720 },
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", "--disable-features=ChromeWhatsNewUI", "--profile-directory=Default"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  await ctx.addInitScript(STEALTH_INIT);
  const page = ctx.pages()[0] || await ctx.newPage();

  log("goto /talent/home");
  await page.goto("https://www.linkedin.com/talent/home", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
  await sleep(4000);

  const url = page.url();
  const title = await page.title().catch(() => "");
  const ch = await detectChallengeInPage(page).catch(() => null);
  await page.screenshot({ path: resolve(OUT, "home.png"), fullPage: false }).catch(() => {});

  const walled = isBlockerUrl(url);
  if (/checkpoint|challenge/i.test(url) || (ch && /checkpoint|captcha/i.test(ch.type || ""))) {
    result = "CHECKPOINT";
  } else if (walled || /\/uas\/login|login-cap|\/login/i.test(url)) {
    result = "LOGIN_WALL";
  } else if (/\/talent\//i.test(url)) {
    result = "LOGGED_IN";
  } else {
    result = "ERROR";
  }

  writeFileSync(resolve(OUT, "result.json"), JSON.stringify({ result, url, title, challenge: ch || null, ts: new Date().toISOString() }, null, 2));
  log("result:", result, "url:", url, "title:", title);
} catch (e) {
  result = "ERROR";
  try { writeFileSync(resolve(OUT, "result.json"), JSON.stringify({ result, error: String(e && e.message || e), ts: new Date().toISOString() }, null, 2)); } catch {}
  log("ERROR", e && e.message);
} finally {
  status(result);
  try { await ctx?.close(); } catch {}
}
