/**
 * Probe the LinkedIn People-search results DOM so we can craft exact selectors
 * for name + headline per result card. One search. Reuses the staged profile.
 */
import { chromium } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { STEALTH_INIT } from "./src/shared/stealth.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROFILE_DIR = path.resolve(__dirname, ".linkedin-profile");

const KEYWORD = process.argv[2] || "Software Engineer";
const URL = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(KEYWORD)}&origin=SWITCH_SEARCH_VERTICAL`;

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome", headless: false,
  viewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--disable-blink-features=AutomationControlled",
         "--no-first-run", "--no-default-browser-check", "--profile-directory=Default"],
  ignoreDefaultArgs: ["--enable-automation"],
});
await ctx.addInitScript(STEALTH_INIT);
const page = ctx.pages()[0] || await ctx.newPage();

const MODE = process.argv[3] || "1";  // "1", "2", or "seq" (mirror daemon)
async function settle() {
  await page.waitForTimeout(5000);
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 500); await page.waitForTimeout(400); }
  await page.waitForTimeout(2000);
}
if (MODE === "seq") {
  // Mirror the daemon: feed warm-up → search p1 → goto &page=2 in same context.
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await settle();
  const p1 = await page.evaluate(() => document.querySelectorAll('[data-view-name="people-search-result"]').length);
  console.log("PAGE1 card_count:", p1);
  await page.goto(`${URL}&page=2`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await settle();
} else {
  const TARGET = MODE === "2" ? `${URL}&page=2` : URL;
  await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 60000 });
  await settle();
}

const dump = await page.evaluate(() => {
  const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
  // Secondary layout (in-session page-2): results anchored by lockup-title.
  const lockups = Array.from(document.querySelectorAll('[data-view-name="search-result-lockup-title"]'));
  const lockupDump = lockups.slice(0, 4).map((lk) => {
    // climb to a container that also holds the avatar + subtitle
    let box = lk;
    for (let i = 0; i < 6 && box.parentElement; i++) {
      box = box.parentElement;
      if (box.querySelector("img") && box.querySelector('a[href*="/in/"]')) break;
    }
    const link = box.querySelector('a[href*="/in/"]');
    return {
      lockup_text: clean(lk.textContent).slice(0, 60),
      url: (link?.getAttribute("href") || "").split("?")[0],
      img_alt: clean(box.querySelector("img")?.getAttribute("alt") || ""),
      box_dvn: box.getAttribute("data-view-name") || "",
      p_texts: Array.from(box.querySelectorAll("p, span")).map((p) => clean(p.textContent)).filter(Boolean).slice(0, 6),
    };
  });
  const cards = Array.from(document.querySelectorAll('[data-view-name="people-search-result"]'));
  const cardDump = cards.slice(0, 4).map((card) => {
    const mainLink = card.querySelector('a[href*="/in/"]');
    const ps = Array.from(card.querySelectorAll("p")).map((p) => clean(p.textContent)).filter(Boolean);
    return {
      url: (mainLink?.getAttribute("href") || "").split("?")[0],
      img_alt: clean(card.querySelector("img")?.getAttribute("alt") || ""),
      p_texts: ps,
    };
  });
  const links = Array.from(document.querySelectorAll('a[href*="/in/"]'));
  // For the first few profile links, walk up the ancestor chain and record
  // tag/class + text length, to locate the "card" container.
  const probes = links.slice(0, 6).map((a) => {
    const chain = [];
    let el = a;
    for (let i = 0; i < 9 && el; i++) {
      chain.push({
        tag: el.tagName,
        cls: (el.className && el.className.toString ? el.className.toString() : "").slice(0, 70),
        txtlen: clean(el.textContent).length,
      });
      el = el.parentElement;
    }
    return {
      href: (a.getAttribute("href") || "").slice(0, 55),
      link_text: clean(a.textContent).slice(0, 70),
      aria_label: clean(a.getAttribute("aria-label") || "").slice(0, 70),
      img_alt: clean(a.querySelector("img")?.getAttribute("alt") || ""),
      aria_hidden_spans: Array.from(a.querySelectorAll('span[aria-hidden="true"]')).map((s) => clean(s.textContent)).slice(0, 3),
      ancestors: chain,
    };
  });
  // Heuristic card: nearest ancestor of the first link whose textContent is a
  // moderate size (a single result, not the whole list). Dump its HTML.
  let card = links[0];
  for (let i = 0; i < 9 && card && card.parentElement; i++) {
    const t = clean(card.parentElement.textContent);
    if (t.length > 400) break;  // parent now spans multiple results
    card = card.parentElement;
  }
  // When cards aren't found, sample what data-view-name values DO exist near
  // the profile links, to discover page-2's container.
  const dvnCounts = {};
  document.querySelectorAll("[data-view-name]").forEach((el) => {
    const k = el.getAttribute("data-view-name");
    dvnCounts[k] = (dvnCounts[k] || 0) + 1;
  });
  const firstLinkAncestorsDvn = [];
  let el = links[0];
  for (let i = 0; i < 12 && el; i++) {
    if (el.getAttribute && el.getAttribute("data-view-name")) firstLinkAncestorsDvn.push(el.getAttribute("data-view-name"));
    el = el.parentElement;
  }
  return {
    url: location.href,
    total_in_links: links.length,
    card_count: cards.length,
    dvnCounts,
    firstLinkAncestorsDvn,
    cardDump,
    lockupDump,
  };
});

console.log(JSON.stringify(dump, null, 2));
await ctx.close();
