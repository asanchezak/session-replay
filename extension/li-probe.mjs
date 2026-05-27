/** Dump the <li> innerHTML + chunk breakdown for /details/experience/. */
import { chromium } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROFILE_DIR = path.resolve(__dirname, ".linkedin-profile");
const SLUG = process.argv[2] || "ldiego08";
const SECTION = process.argv[3] || "experience";
const URL = `https://www.linkedin.com/in/${SLUG}/details/${SECTION}/`;

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome", headless: false,
  viewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--disable-blink-features=AutomationControlled",
         "--no-first-run", "--no-default-browser-check", "--profile-directory=Default"],
  ignoreDefaultArgs: ["--enable-automation"],
});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 600); await page.waitForTimeout(400); }
await page.waitForTimeout(2000);

const data = await page.evaluate(() => {
  const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
  const main = document.querySelector("main") || document.body;
  const uls = Array.from(main.querySelectorAll("ul"));
  // Find largest by total text
  let bestUl = null, bestText = 0;
  uls.forEach((ul) => {
    const direct = Array.from(ul.children).filter((c) => c.tagName === "LI");
    if (direct.length === 0) return;
    const total = direct.reduce((a, li) => a + (li.textContent || "").length, 0);
    if (total > bestText) { bestText = total; bestUl = ul; }
  });
  if (!bestUl) return { items: [] };
  const items = Array.from(bestUl.children).filter((c) => c.tagName === "LI").slice(0, 3);
  return {
    items: items.map((li, i) => ({
      index: i,
      aria_spans: Array.from(li.querySelectorAll('span[aria-hidden="true"]')).map((s) => clean(s.textContent)).filter(Boolean),
      all_leaf_spans: Array.from(li.querySelectorAll("span")).filter((s) => s.children.length === 0).map((s) => clean(s.textContent)).filter(Boolean),
      paras_or_divs: Array.from(li.querySelectorAll("p, h3, div")).filter((e) => e.children.length === 0).map((e) => clean(e.textContent)).filter(Boolean),
      raw_text: clean(li.textContent).slice(0, 600),
      innerhtml_preview: (li.innerHTML || "").replace(/\s+/g, " ").slice(0, 1500),
    })),
  };
});
data.items.forEach((it) => {
  console.log(`\n========== item #${it.index} ==========`);
  console.log("aria-hidden spans (count=", it.aria_spans.length, "):");
  it.aria_spans.forEach((s, i) => console.log(`  [${i}] ${s}`));
  console.log("all leaf spans (count=", it.all_leaf_spans.length, "):");
  it.all_leaf_spans.slice(0, 20).forEach((s, i) => console.log(`  [${i}] ${s}`));
  console.log("p/h3/div leaf (count=", it.paras_or_divs.length, "):");
  it.paras_or_divs.slice(0, 12).forEach((s, i) => console.log(`  [${i}] ${s}`));
  console.log("raw_text:", it.raw_text);
});

await ctx.close();
