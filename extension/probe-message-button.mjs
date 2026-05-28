// Inspect the Message button(s) on a LinkedIn profile so we can craft a
// reliable selector for the compose dialog. Dumps every button + anchor
// that contains "message" / "mensaje" with its surrounding context.

import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = resolve(__dirname, ".linkedin-profile");

const url = process.argv[2];
if (!url) {
  console.error("usage: node probe-message-button.mjs <profile_url>");
  process.exit(2);
}

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome", headless: false, viewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
  ignoreDefaultArgs: ["--enable-automation"],
});

const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 4000));
// Scroll a bit to trigger any lazy hydration.
await page.evaluate(() => window.scrollTo(0, 300));
await new Promise((r) => setTimeout(r, 2500));

const inventory = await page.evaluate(() => {
  const tokens = ["message", "mensaje", "connect", "conectar", "follow", "seguir", "more", "más"];
  const elements = Array.from(document.querySelectorAll('button, a[role="button"], a'));
  const matches = [];
  for (const el of elements) {
    const aria = (el.getAttribute("aria-label") || "").trim();
    const text = (el.innerText || el.textContent || "").trim();
    const cls = el.className?.toString().slice(0, 120) || "";
    const id = el.id || "";
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    const href = el.getAttribute("href") || "";
    const inProfileTopCard = !!el.closest('[data-view-name="profile-top-card"]');
    const inProfileActions = !!el.closest('[class*="pvs-profile-actions"], [class*="profile-actions"], [data-view-name="profile-actions"]');
    const visible = el.offsetParent !== null;
    const lowAria = aria.toLowerCase();
    const lowText = text.toLowerCase();
    const hit = tokens.some(t => lowAria.startsWith(t) || lowAria === t || lowText === t || lowText.startsWith(t));
    if (hit) {
      matches.push({ tag, role, aria, text: text.slice(0, 60), cls, id, href, inProfileTopCard, inProfileActions, visible });
    }
  }
  return {
    title: document.title,
    bodyText: (document.body?.innerText || "").slice(0, 200),
    matches,
  };
});

console.log("title:", inventory.title);
console.log("body snippet:", inventory.bodyText.slice(0, 120));
console.log("matches:", inventory.matches.length);
for (const m of inventory.matches) {
  console.log(JSON.stringify(m, null, 2));
}

console.log("Browser left open. Ctrl+C to exit.");
await new Promise(() => {});
