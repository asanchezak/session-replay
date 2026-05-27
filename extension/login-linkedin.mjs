/**
 * Phase 1: open real Chrome against the staged .linkedin-profile and let the
 * user log in to LinkedIn interactively. The driver in live-linkedin-driver.mjs
 * later reuses the same profile to scrape without further user interaction.
 *
 * Waits up to 25 minutes for the URL to land on a logged-in LinkedIn surface.
 */
import { chromium } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROFILE_DIR = path.resolve(__dirname, ".linkedin-profile");

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
      WebGLRenderingContext.prototype.getParameter = mask(function (p) {
        if (p === 37445) return "Intel Inc.";
        if (p === 37446) return "Intel Iris OpenGL Engine";
        return orig.call(this, p);
      }, "getParameter");
    } catch {}
  } catch (err) {
    console.warn("[stealth] init error:", err);
  }
};

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
    "--profile-directory=Default",
  ],
  ignoreDefaultArgs: ["--enable-automation"],
});
await ctx.addInitScript(STEALTH_INIT);

const page = ctx.pages()[0] || await ctx.newPage();
await page.goto("https://www.linkedin.com/login");

console.log("");
console.log("=".repeat(70));
console.log("Log in to LinkedIn in the open Chrome window.");
console.log("Solve any challenge (email code, app, CAPTCHA) when prompted.");
console.log("Watching until URL lands on /feed/ (max 25 min)...");
console.log("=".repeat(70));

const deadline = Date.now() + 25 * 60_000;
let last = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const cur = page.url();
  if (cur !== last) {
    console.log("  url ->", cur);
    last = cur;
  }
  if (/linkedin\.com\/(feed|mynetwork|messaging|jobs|in)\//.test(cur)) {
    console.log("Login complete. URL:", cur);
    await new Promise((r) => setTimeout(r, 4000));
    break;
  }
}
const final = page.url();
const ok = /linkedin\.com\/(feed|mynetwork|messaging|jobs|in)\//.test(final);
console.log(ok ? "OK." : `NOT logged in. Final URL: ${final}`);

await ctx.close();
process.exit(ok ? 0 : 1);
