/**
 * Recruiter (/talent) SESSION KEEP-ALIVE + lifetime probe.
 *
 * Theory under test (#7): the Recruiter seat token has a short TTL but is
 * refreshed by an OPEN/active browser (the SPA heartbeats). Fernanda's
 * always-open Chrome+Edge last weeks; the daemon's open→nav→close pattern never
 * refreshes, so it lapses in ~10-30 min. This holds ONE Chrome open on
 * .linkedin-profile and gently reloads /talent/home every few minutes to keep
 * the token warm — and records exactly how long the session survives.
 *
 * Also dumps the linkedin.com cookies (name + expiry) at start → tests theory #9
 * (does the bot profile have a long-lived "remember device" token like li_rm, or
 * only short/session tokens?).
 *
 * SAFETY: read-only (navigate/reload + gentle scroll/mouse only). Long human
 * intervals + jitter. PAUSES and STOPS on any login/checkpoint wall (never loops
 * a re-login). Run as linkedin-bot (S4U task, no time limit). Keep the daemon
 * Disabled while this holds the profile (single Chrome per user-data-dir).
 *
 * Output: recruiter-snapshots/keepalive/{STATUS, keepalive.log, cookies-at-start.json,
 *         walled-*.{html,png}}.  STATUS ∈ {STARTING, BLOCKED_AT_START, ALIVE …, WALLED@…m, ERROR}
 */
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { STEALTH_INIT } from "./src/shared/stealth.mjs";
import { isBlockerUrl, detectChallengeInPage } from "./src/behavior/blocker-detect.mjs";
import { createPageNav } from "./src/behavior/page-nav.mjs";
import { snapshotPage } from "./src/behavior/page-snapshot.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = resolve(__dirname, ".linkedin-profile");
const OUT = resolve(__dirname, "recruiter-snapshots", "keepalive");
mkdirSync(OUT, { recursive: true });

const MIN_MS = Number(process.env.KEEPALIVE_MIN_MS || 5 * 60_000);
const MAX_MS = Number(process.env.KEEPALIVE_MAX_MS || 9 * 60_000);
const { moveMouseAlongBezier, humanScrollSeeded } = createPageNav();
const rand = Math.random;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const start = Date.now();
const mins = () => ((Date.now() - start) / 60000).toFixed(1);
function status(s) { try { writeFileSync(resolve(OUT, "STATUS"), s + "\n"); } catch {} }
function log(...a) {
  const line = `${new Date().toISOString().slice(11, 19)} +${mins()}m ${a.join(" ")}`;
  console.log(line);
  try { appendFileSync(resolve(OUT, "keepalive.log"), line + "\n"); } catch {}
}
async function blocked(page) {
  if (isBlockerUrl(page.url())) return true;
  const ch = await detectChallengeInPage(page).catch(() => null);
  return !!ch;
}

let ctx;
status("STARTING");
try {
  ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome", headless: false, viewport: { width: 1280, height: 720 },
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", "--disable-features=ChromeWhatsNewUI", "--profile-directory=Default"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  await ctx.addInitScript(STEALTH_INIT);
  const page = ctx.pages()[0] || await ctx.newPage();

  log("goto /talent/home");
  await page.goto("https://www.linkedin.com/talent/home", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
  await sleep(4000);
  if (await blocked(page)) {
    status("BLOCKED_AT_START");
    log("BLOCKED at start — need a fresh login first");
    await snapshotPage(page, { dir: OUT, stage: "blocked-start" }).catch(() => {});
    await ctx.close(); process.exit(1);
  }
  log("ALIVE at start url=" + page.url());

  // #9 evidence: dump linkedin cookies (name + expiry; values omitted).
  try {
    const cookies = await ctx.cookies("https://www.linkedin.com");
    const summ = cookies
      .map((c) => ({ name: c.name, domain: c.domain, expires: c.expires, session: c.expires === -1, expiresISO: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    writeFileSync(resolve(OUT, "cookies-at-start.json"), JSON.stringify(summ, null, 2));
    log("cookies@start: " + summ.map((c) => c.name + (c.session ? "(session)" : "")).join(","));
  } catch (e) { log("cookie dump failed: " + (e.message || e)); }

  status(`ALIVE 0m cycle0`);
  let cycle = 0;
  while (true) {
    const wait = MIN_MS + Math.floor(rand() * (MAX_MS - MIN_MS));
    log(`sleeping ${(wait / 60000).toFixed(1)}m until next refresh`);
    await sleep(wait);
    cycle++;
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
      await sleep(2500 + rand() * 2500);
      await moveMouseAlongBezier(page, { x: 400 + rand() * 400, y: 250 + rand() * 200 }, rand).catch(() => {});
      await humanScrollSeeded(page, 1 + Math.floor(rand() * 2), rand).catch(() => {});
      if (await blocked(page)) {
        status(`WALLED@${mins()}m cycle${cycle}`);
        log(`WALLED after ${mins()}m (cycle ${cycle}) — session lapsed`);
        await snapshotPage(page, { dir: OUT, stage: `walled-c${cycle}` }).catch(() => {});
        break;
      }
      log(`cycle ${cycle} ALIVE url=${page.url()}`);
      status(`ALIVE ${mins()}m cycle${cycle}`);
    } catch (e) {
      log(`cycle ${cycle} error: ${(e.message || e)}`);
      status(`ERROR@${mins()}m`);
      break;
    }
  }
} catch (e) {
  log("FATAL " + (e && e.message));
  status("ERROR");
} finally {
  try { await ctx?.close(); } catch {}
  log("keep-alive ended");
}
