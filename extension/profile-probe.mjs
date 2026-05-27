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
  const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
  const out = {
    h2_all: [],
    dataViewNames: [],
    sections_by_h2: {},
    topcard_dump: "",
  };
  document.querySelectorAll("h2").forEach((h) => out.h2_all.push(clean(h.textContent)));
  // Every element carrying data-view-name (the new LinkedIn structural hook).
  const dvSet = new Set();
  document.querySelectorAll("[data-view-name]").forEach((el) => dvSet.add(el.getAttribute("data-view-name")));
  out.dataViewNames = Array.from(dvSet);
  // Pull text under each h2 in profile sections.
  document.querySelectorAll("h2").forEach((h) => {
    const heading = clean(h.textContent);
    const section = h.closest("section") || h.parentElement;
    if (section) {
      out.sections_by_h2[heading] = clean(section.textContent).slice(0, 800);
    }
  });
  const tc = document.querySelector('[data-view-name="profile-top-card"]') ||
             document.querySelector('section[componentkey*="Topcard"]');
  if (tc) {
    out.topcard_dump = clean(tc.textContent).slice(0, 1500);
  }
  return out;
});
console.log("h2 (all):", dom.h2_all);
console.log("");
console.log("data-view-names:", dom.dataViewNames);
console.log("");
console.log("topcard textContent:");
console.log(dom.topcard_dump);
console.log("");
for (const [h, txt] of Object.entries(dom.sections_by_h2)) {
  console.log(`---- h2="${h}" ----`);
  console.log(txt.slice(0, 600));
  console.log("");
}

await page.screenshot({ path: "profile-probe.png", fullPage: false });
console.log("Screenshot: profile-probe.png");
await ctx.close();
