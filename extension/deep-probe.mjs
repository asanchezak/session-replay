/**
 * Thorough probe of every /details/<section>/ subpage for ONE profile.
 * Dumps:
 *   - final URL after redirect
 *   - page <title>
 *   - h1/h2 list
 *   - every <ul> with direct li count, total text, sample first li
 *   - innerHTML excerpt of <main>
 *   - screenshot per section
 *
 * Helps decide whether empty fields are LinkedIn-rendered-empty,
 * URL-redirected, or DOM-shape changed.
 */
import { chromium } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROFILE_DIR = path.resolve(__dirname, ".linkedin-profile");

const SLUG = process.argv[2] || "ldiego08";
const SECTIONS = ["experience", "education", "skills", "certifications", "projects", "honors", "courses"];

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome", headless: false,
  viewport: { width: 1440, height: 900 },
  args: [
    "--no-sandbox", "--disable-blink-features=AutomationControlled",
    "--no-first-run", "--no-default-browser-check", "--profile-directory=Default",
  ],
  ignoreDefaultArgs: ["--enable-automation"],
});
const page = ctx.pages()[0] || await ctx.newPage();

// Slow pacing: 8s between subpages so we don't trip soft-rate-limit.
for (const sec of SECTIONS) {
  const url = `https://www.linkedin.com/in/${SLUG}/details/${sec}/`;
  console.log("\n\n========================================");
  console.log(`SECTION: ${sec}`);
  console.log(`URL:     ${url}`);
  console.log("========================================");
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (err) {
    console.log("  ! goto failed:", err.message);
    continue;
  }
  await page.waitForTimeout(5000);
  // Heavy scroll to trigger lazy-load.
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(2000);

  console.log("final url:", page.url());
  console.log("title:", await page.title());

  const data = await page.evaluate(() => {
    const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
    const out = {
      h1: [], h2: [],
      uls: [],
      mainTextLen: 0,
      mainExcerpt: "",
      empty_state: "",
      navigated_away: false,
    };
    document.querySelectorAll("h1").forEach((h) => out.h1.push(clean(h.textContent).slice(0, 120)));
    document.querySelectorAll("h2").forEach((h) => out.h2.push(clean(h.textContent).slice(0, 120)));
    const main = document.querySelector("main") || document.body;
    out.mainTextLen = (main.textContent || "").length;
    out.mainExcerpt = clean(main.textContent || "").slice(0, 400);
    // Look for "empty state" messages.
    const emptyClues = main.textContent.match(/no\s+(skills|education|certifications|projects|experience|courses|honors)|nothing\s+to\s+show|sin\s+(habilidades|formaci|certifica)/i);
    if (emptyClues) out.empty_state = emptyClues[0];
    // Every UL with stats.
    Array.from(main.querySelectorAll("ul")).forEach((ul, idx) => {
      if (ul.closest("nav") || ul.getAttribute("role") === "tablist") return;
      const lis = Array.from(ul.children).filter((c) => c.tagName === "LI");
      if (lis.length === 0) return;
      const total = lis.reduce((acc, li) => acc + (li.textContent || "").length, 0);
      out.uls.push({
        idx,
        li_count: lis.length,
        total_text: total,
        avg: total / lis.length,
        first_li_preview: clean(lis[0].textContent || "").slice(0, 260),
        ul_aria: ul.getAttribute("aria-label") || "",
      });
    });
    // Did the URL redirect back to the main profile? (sign of empty section)
    if (/\/in\/[^/]+\/?$/.test(location.pathname)) out.navigated_away = true;
    return out;
  });

  console.log("h1:", data.h1);
  console.log("h2:", data.h2.slice(0, 10));
  console.log("main text length:", data.mainTextLen);
  console.log("main excerpt:", data.mainExcerpt);
  if (data.empty_state) console.log("EMPTY STATE detected:", data.empty_state);
  if (data.navigated_away) console.log("REDIRECTED back to main profile (section empty)");
  console.log(`<ul> candidates (${data.uls.length}):`);
  data.uls.forEach((u) => {
    console.log(`  ul#${u.idx} aria='${u.ul_aria}' li=${u.li_count} text=${u.total_text} avg=${u.avg.toFixed(0)}`);
    console.log(`    first li: ${u.first_li_preview}`);
  });

  // Polite pacing between subpages to avoid LinkedIn anti-bot soft-block.
  await page.waitForTimeout(8000);
}

await ctx.close();
