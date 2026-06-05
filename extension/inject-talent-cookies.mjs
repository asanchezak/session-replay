/**
 * INJECTOR — run AS linkedin-bot (the daemon's DPAPI context, via S4U task).
 * Transplants the linkedin.com cookies extracted from Fernanda's personal Chrome
 * (.transplant/talent-cookies.json) into the daemon's .linkedin-profile, then
 * verifies the Recruiter session loads by navigating to /talent/home ONCE.
 *
 * Playwright addCookies writes the cookies into the persistent profile; Chrome
 * re-encrypts them at rest under the linkedin-bot DPAPI key, so the daemon can
 * read them afterwards. Same LinkedIn account as the profile already holds
 * (Fernanda), so this just adds the missing Recruiter "seat" cookie layer.
 *
 * Output: .debug/transplant/{STATUS, result.json, talent-home.png}
 *   STATUS in { LOGGED_IN, LOGIN_WALL, CHECKPOINT, ERROR }
 */
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { STEALTH_INIT } from "./src/shared/stealth.mjs";
import { isBlockerUrl } from "./src/behavior/blocker-detect.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = resolve(__dirname, ".linkedin-profile");
const OUT = resolve(__dirname, ".debug", "transplant");
const COOKIES = resolve(__dirname, ".transplant", "talent-cookies.json");
mkdirSync(OUT, { recursive: true });

function status(s) { try { writeFileSync(resolve(OUT, "STATUS"), s + "\n"); } catch {} }
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

status("RUNNING");
let result = "ERROR", ctx;
try {
  const raw = JSON.parse(readFileSync(COOKIES, "utf8"));
  const cookies = raw
    .filter((c) => c && c.name && c.domain)
    .map((c) => {
      let sameSite = ["Strict", "Lax", "None"].includes(c.sameSite) ? c.sameSite : "Lax";
      let secure = !!c.secure;
      if (sameSite === "None") secure = true; // addCookies requires secure for SameSite=None
      const out = { name: c.name, value: c.value, domain: c.domain, path: c.path || "/", httpOnly: !!c.httpOnly, secure, sameSite };
      if (typeof c.expires === "number" && c.expires > 0) out.expires = Math.floor(c.expires);
      return out;
    });
  log(`loaded ${cookies.length} cookies; names: ${[...new Set(cookies.map((c) => c.name))].join(",")}`);

  ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome", headless: false,
    viewport: { width: 1280, height: 720 },
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", "--disable-features=ChromeWhatsNewUI", "--profile-directory=Default"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  await ctx.addInitScript(STEALTH_INIT);
  await ctx.addCookies(cookies);
  log("cookies injected into .linkedin-profile");

  const page = ctx.pages()[0] || await ctx.newPage();
  log("goto /talent/home");
  await page.goto("https://www.linkedin.com/talent/home", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 4000));

  const url = page.url();
  const title = await page.title().catch(() => "");
  await page.screenshot({ path: resolve(OUT, "talent-home.png") }).catch(() => {});
  if (/checkpoint|challenge/i.test(url)) result = "CHECKPOINT";
  else if (isBlockerUrl(url) || /\/uas\/login|login-cap|\/login\b/i.test(url)) result = "LOGIN_WALL";
  else if (/\/talent\//i.test(url)) result = "LOGGED_IN";
  else result = "ERROR";

  writeFileSync(resolve(OUT, "result.json"), JSON.stringify({ result, url, title, injected: cookies.length, ts: new Date().toISOString() }, null, 2));
  log("result:", result, "url:", url, "title:", title);
} catch (e) {
  result = "ERROR";
  try { writeFileSync(resolve(OUT, "result.json"), JSON.stringify({ result, error: String(e && e.message || e), ts: new Date().toISOString() }, null, 2)); } catch {}
  log("ERROR", e && e.message);
} finally {
  status(result);
  try { await ctx?.close(); } catch {}
}
