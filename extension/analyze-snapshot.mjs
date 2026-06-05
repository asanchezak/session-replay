/**
 * OFFLINE snapshot analyzer — iterate Recruiter (/talent) selectors WITHOUT
 * touching the live account (see feedback_recruiter_offline_selector_iteration).
 *
 * Loads a saved snapshot HTML via file:// in headless chromium (declarative
 * shadow DOM re-attaches automatically), then:
 *   - prints the interactive-element inventory (piercing open shadow roots), and
 *   - if --sel "<css>" is given, reports how many elements match + a preview,
 *     piercing shadow roots so composer/overlay selectors are testable too.
 *
 * Usage:
 *   node analyze-snapshot.mjs <path-to.html> [--sel "css selector"] [--grep text]
 */
import { chromium } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { INVENTORY_FN } from "./src/behavior/page-snapshot.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const sel = (() => { const i = args.indexOf("--sel"); return i >= 0 ? args[i + 1] : null; })();
const grep = (() => { const i = args.indexOf("--grep"); return i >= 0 ? (args[i + 1] || "").toLowerCase() : null; })();

if (!file || !existsSync(resolve(file))) {
  console.error("usage: node analyze-snapshot.mjs <path-to.html> [--sel \"css\"] [--grep text]");
  process.exit(1);
}

// Pierce open shadow roots when testing a CSS selector.
const MATCH_FN = (css) => {
  const hits = [];
  function walk(root) {
    let els; try { els = Array.from(root.querySelectorAll(css)); } catch { return; }
    for (const el of els) hits.push({ tag: el.tagName.toLowerCase(), aria: el.getAttribute("aria-label") || "", text: (el.innerText || el.textContent || "").trim().slice(0, 80), href: el.getAttribute("href") || "" });
    const all = root.querySelectorAll("*");
    for (const el of all) if (el.shadowRoot) walk(el.shadowRoot);
  }
  walk(document);
  return hits;
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: "load" });

const inv = await page.evaluate(INVENTORY_FN);
console.log(`\nSnapshot: ${file}`);
console.log(`Interactive elements: ${inv.count}\n`);

let rows = inv.elements;
if (grep) rows = rows.filter((e) => JSON.stringify(e).toLowerCase().includes(grep));
for (const e of rows.slice(0, 80)) {
  const id = [e.tag, e.role && `role=${e.role}`, e.type && `type=${e.type}`, e.aria && `aria="${e.aria}"`, e.placeholder && `ph="${e.placeholder}"`, e.dataView && `dv=${e.dataView}`, e.href && `href=${e.href.slice(0, 50)}`, e.inShadow && `[shadow:${e.inShadow}]`, !e.visible && "(hidden)"].filter(Boolean).join(" ");
  console.log(`  ${id}${e.text ? `  — "${e.text}"` : ""}`);
}
if (rows.length > 80) console.log(`  … +${rows.length - 80} more`);

if (sel) {
  const hits = await page.evaluate(MATCH_FN, sel);
  console.log(`\n--sel "${sel}" → ${hits.length} match(es):`);
  for (const h of hits.slice(0, 20)) console.log(`  <${h.tag}> aria="${h.aria}" href="${h.href.slice(0, 60)}" — "${h.text}"`);
}

await browser.close();
