/**
 * Probe specifically for the headline element location inside the top card,
 * and dump the structure of /details/experience/ etc.
 */
import { chromium } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROFILE_DIR = path.resolve(__dirname, ".linkedin-profile");

const SLUG = process.argv[2] || "sofia-llona-lecca";
const PROFILE = `https://www.linkedin.com/in/${SLUG}/`;

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome", headless: false,
  viewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--disable-blink-features=AutomationControlled",
         "--no-first-run", "--no-default-browser-check", "--profile-directory=Default"],
  ignoreDefaultArgs: ["--enable-automation"],
});
const page = ctx.pages()[0] || await ctx.newPage();

async function dumpPage(url, label) {
  console.log(`\n============ ${label} ============`);
  console.log("URL:", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(6000);
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 500); await page.waitForTimeout(500); }
  await page.waitForTimeout(2000);

  const data = await page.evaluate(() => {
    const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
    const out = {
      url: location.href,
      title: document.title,
      h2: [],
      topcard_children: [],
      dataViewNames: [],
      list_entries: [],
    };
    document.querySelectorAll("h2").forEach((h) => out.h2.push(clean(h.textContent).slice(0, 100)));
    document.querySelectorAll("[data-view-name]").forEach((el) => {
      const n = el.getAttribute("data-view-name");
      if (n) out.dataViewNames.push(n);
    });
    out.dataViewNames = Array.from(new Set(out.dataViewNames));
    // Top-card: log each direct child div's textContent so we can find the
    // exact node holding the headline.
    const tc = document.querySelector('[data-view-name="profile-top-card"]') ||
               document.querySelector('section[componentkey*="Topcard"]');
    if (tc) {
      const walker = tc.querySelectorAll("div, span, h2, p");
      let i = 0;
      walker.forEach((el) => {
        if (el.children.length === 0) {
          const t = clean(el.textContent);
          if (t && t.length > 3 && t.length < 200) {
            out.topcard_children.push(`#${i++} tag=${el.tagName} cls=${(el.className||"").slice(0,80)} text=${t}`);
          }
        }
      });
    }
    // Detail/experience pages: capture <li> entries with their structured fields.
    document.querySelectorAll("section ul > li, main ul > li").forEach((li, idx) => {
      if (idx >= 8) return;
      const t = clean(li.textContent);
      if (t.length > 20 && t.length < 800) {
        out.list_entries.push(t.slice(0, 400));
      }
    });
    return out;
  });
  console.log("title:", data.title);
  console.log("h2:", data.h2.slice(0, 12));
  console.log("data-view-names matching profile-card-*:", data.dataViewNames.filter((n) => n.startsWith("profile-card-")));
  console.log("\n-- topcard leaf texts --");
  data.topcard_children.slice(0, 20).forEach((s) => console.log(s));
  console.log("\n-- list entries --");
  data.list_entries.slice(0, 6).forEach((s) => console.log("- " + s));
}

await dumpPage(PROFILE, "profile main");
await dumpPage(PROFILE + "details/experience/", "experience subpage");
await dumpPage(PROFILE + "details/skills/", "skills subpage");
await dumpPage(PROFILE + "details/education/", "education subpage");

await ctx.close();
