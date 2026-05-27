/**
 * Inspect the DOM structure of LinkedIn /details/<section>/ pages that don't
 * use <ul>/<li>. Looks for:
 *   - <a> anchors and their text+href (skills are typically anchors)
 *   - Repeating sibling divs (entries are usually siblings with the same class shape)
 *   - data-* attributes
 *
 * Used to design a structural parser for skills/education/certifications/projects/courses.
 */
import { chromium } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROFILE_DIR = path.resolve(__dirname, ".linkedin-profile");

const SLUG = process.argv[2] || "ldiego08";
const SECTION = process.argv[3] || "skills";

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome", headless: false,
  viewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--disable-blink-features=AutomationControlled",
         "--no-first-run", "--no-default-browser-check", "--profile-directory=Default"],
  ignoreDefaultArgs: ["--enable-automation"],
});
const page = ctx.pages()[0] || await ctx.newPage();
const url = `https://www.linkedin.com/in/${SLUG}/details/${SECTION}/`;
console.log("URL:", url);

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(5000);
for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 700); await page.waitForTimeout(400); }
await page.waitForTimeout(2000);

const data = await page.evaluate(() => {
  const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
  const main = document.querySelector("main") || document.body;
  const out = {
    anchors_in_main: [],
    repeating_sibling_groups: [],
    data_view_names_in_main: [],
    direct_child_summary: [],
  };

  // Anchors inside <main> with hrefs (skill links lead to a search page).
  Array.from(main.querySelectorAll("a[href]")).forEach((a) => {
    const text = clean(a.textContent).slice(0, 120);
    const href = a.getAttribute("href") || "";
    if (text && text.length < 200 && !text.match(/^(see|more|less|ver|menos|m[áa]s|edit|edit profile|home|messaging)$/i)) {
      out.anchors_in_main.push({ text, href });
    }
  });

  // data-view-name values
  const dvSet = new Set();
  Array.from(main.querySelectorAll("[data-view-name]")).forEach((el) =>
    dvSet.add(el.getAttribute("data-view-name")),
  );
  out.data_view_names_in_main = Array.from(dvSet);

  // Look for repeating sibling patterns: find any parent whose children look uniform
  // (same tag, similar text length, similar child count). Pick the parent with the
  // most uniform children that aren't navigational.
  function fingerprint(el) {
    // Coarse shape: tag + child count + text length bucket
    const childTags = Array.from(el.children).map((c) => c.tagName).join(",");
    const tlen = (el.textContent || "").length;
    const bucket = Math.floor(Math.log2(Math.max(1, tlen)));
    return `${el.tagName}|${childTags}|${bucket}`;
  }

  const allDivs = Array.from(main.querySelectorAll("div, section"));
  let bestGroup = null;
  let bestScore = 0;
  allDivs.forEach((parent) => {
    if (parent.closest("nav") || parent.closest("header")) return;
    const kids = Array.from(parent.children).filter((c) => c.children.length > 0);
    if (kids.length < 2) return;
    const fps = kids.map(fingerprint);
    const firstFp = fps[0];
    const matching = fps.filter((fp) => fp === firstFp).length;
    if (matching < 2) return;
    // Score = matching count * total text size of those children (favor real content)
    const score = matching * kids.reduce((acc, k) => acc + (k.textContent || "").length, 0);
    if (score > bestScore) {
      bestScore = score;
      bestGroup = {
        parent_tag: parent.tagName,
        parent_class: (parent.className || "").slice(0, 100),
        parent_aria: parent.getAttribute("aria-label") || "",
        kid_count: kids.length,
        matching_count: matching,
        fingerprint: firstFp,
        sample_kid_texts: kids.slice(0, 5).map((k) =>
          clean(k.textContent).slice(0, 200),
        ),
      };
    }
  });
  out.repeating_sibling_groups = bestGroup ? [bestGroup] : [];

  // Direct child summary of main
  out.direct_child_summary = Array.from(main.children).map((c) => ({
    tag: c.tagName,
    class: (c.className || "").slice(0, 60),
    text_len: (c.textContent || "").length,
    direct_div_count: Array.from(c.children).filter((k) => k.tagName === "DIV").length,
  }));

  return out;
});

console.log("\n--- data-view-names in main ---");
data.data_view_names_in_main.forEach((n) => console.log(" ", n));

console.log("\n--- anchors in main (first 30) ---");
data.anchors_in_main.slice(0, 30).forEach((a) => console.log(`  "${a.text}" -> ${a.href.slice(0, 100)}`));

console.log("\n--- repeating sibling group ---");
data.repeating_sibling_groups.forEach((g) => {
  console.log("  parent:", g.parent_tag, "class=", g.parent_class, "aria=", g.parent_aria);
  console.log("  kids:", g.kid_count, "matching:", g.matching_count, "fp:", g.fingerprint);
  console.log("  sample kids:");
  g.sample_kid_texts.forEach((t, i) => console.log(`    [${i}] ${t}`));
});

console.log("\n--- main direct children ---");
data.direct_child_summary.forEach((c) => console.log(`  ${c.tag} class='${c.class}' text=${c.text_len} divs=${c.direct_div_count}`));

await ctx.close();
