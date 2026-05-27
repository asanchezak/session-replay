/**
 * Open one LinkedIn profile in Chrome (logged-in profile) and dump:
 *  - The final URL after redirects
 *  - All h1 elements visible
 *  - The first 5KB of <main> innerHTML
 *  - A screenshot
 *
 * Used to diagnose why scrapeProfile is getting empty results.
 */
import { chromium } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROFILE_DIR = path.resolve(__dirname, ".linkedin-profile");

const URL = process.argv[2] || "https://www.linkedin.com/in/sebasti%C3%A1n-solano-878521212";

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [
    "--no-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--profile-directory=Default",
  ],
  ignoreDefaultArgs: ["--enable-automation"],
});

const page = ctx.pages()[0] || await ctx.newPage();
console.log("Navigating to:", URL);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(8000);
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(700);
}
await page.waitForTimeout(2000);

console.log("Final URL:", page.url());

const dom = await page.evaluate(() => {
  const out = { h1: [], headings: [], mainPreview: "", anchors: [] };
  document.querySelectorAll("h1").forEach((h) => out.h1.push((h.textContent || "").trim().slice(0, 200)));
  document.querySelectorAll("h2").forEach((h) => out.headings.push((h.textContent || "").trim().slice(0, 100)));
  const main = document.querySelector("main") || document.body;
  out.mainPreview = (main.innerHTML || "").slice(0, 5000);
  // Anchor candidates for profile sections.
  const ids = ["about","experience","education","skills","certifications","projects","volunteer"];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) out.anchors.push(id + " present");
  });
  return out;
});
console.log("h1 texts:", dom.h1);
console.log("h2 first 15:", dom.headings.slice(0, 15));
console.log("section anchors:", dom.anchors);
console.log("");
console.log("main innerHTML preview (5KB):");
console.log(dom.mainPreview.replace(/\s+/g, " ").slice(0, 3000));

await page.screenshot({ path: "profile-probe.png", fullPage: false });
console.log("Screenshot: profile-probe.png");
await ctx.close();
