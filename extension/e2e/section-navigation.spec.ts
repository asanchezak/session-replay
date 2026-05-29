// Validates the daemon's section navigation (src/behavior/page-nav.mjs) against
// a local fixture profile — no LinkedIn, no network. Proves the core anti-bot
// change: we CLICK the in-page "Show all" anchor (a trusted click that follows
// a real mouse path) instead of deep-linking to /details/<section>/, we detect
// which sections have a Show-all anchor, and the visit order varies by seed.

import { test, expect, chromium, type BrowserContext } from "@playwright/test";
// @ts-expect-error — plain .mjs sibling module
import { createPageNav } from "../src/behavior/page-nav.mjs";
// @ts-expect-error — plain .mjs sibling module
import { mulberry32, shuffleInPlace } from "../src/behavior/stealth-core.mjs";

let context: BrowserContext;
test.beforeAll(async () => {
  context = await chromium.launchPersistentContext("", {
    headless: process.env.HEADLESS !== "false",
    channel: process.env.SR_E2E_CHANNEL || "chrome",
    viewport: { width: 1280, height: 800 },
  });
});
test.afterAll(async () => { await context?.close(); });

// A profile-like page that exposes "Show all" anchors for experience + skills
// (but NOT education), and records any click that lands on it as trusted.
const PROFILE_HTML = `
<!doctype html><title>profile</title>
<main style="height:3000px">
  <h2>Jane Doe</h2><p>Staff Engineer</p>
  <section><h3>Experience</h3>
    <a id="exp" href="/in/jane-doe/details/experience/">Show all 8 experiences</a></section>
  <section><h3>Skills</h3>
    <a id="sk" href="/in/jane-doe/details/skills/">Show all 30 skills</a></section>
  <section><h3>Education</h3><p>Some University (inline, no Show all)</p></section>
</main>
<script>
  window.__clicks = [];
  for (const a of document.querySelectorAll('a[href*="/details/"]')) {
    a.addEventListener('click', (e) => {
      e.preventDefault(); // stay on the data: page so we can assert
      window.__clicks.push({ href: a.getAttribute('href'), trusted: e.isTrusted });
    });
  }
</script>`;

const profileUrl = "https://www.linkedin.com/in/jane-doe/";

function loadProfile(page: import("@playwright/test").Page) {
  return page.goto(`data:text/html,${encodeURIComponent(PROFILE_HTML)}`);
}

test("getShowAllSections finds only sections that expose a Show-all anchor", async () => {
  const page = await context.newPage();
  await loadProfile(page);
  const nav = createPageNav();
  const showAll: Set<string> = await nav.getShowAllSections(page, profileUrl);
  expect(showAll.has("/in/jane-doe/details/experience/")).toBe(true);
  expect(showAll.has("/in/jane-doe/details/skills/")).toBe(true);
  // Education has no Show-all anchor → not present (daemon goto's it as fallback).
  expect(showAll.has("/in/jane-doe/details/education/")).toBe(false);
  await page.close();
});

test("clickSectionLink performs a TRUSTED click on the real anchor (not a deep-link)", async () => {
  const page = await context.newPage();
  await loadProfile(page);
  const nav = createPageNav();
  const ok = await nav.clickSectionLink(page, "/in/jane-doe/details/experience/", mulberry32(1));
  expect(ok).toBe(true);
  const clicks = await page.evaluate(() => (window as unknown as { __clicks: { href: string; trusted: boolean }[] }).__clicks);
  expect(clicks.length).toBe(1);
  expect(clicks[0].href).toBe("/in/jane-doe/details/experience/");
  // The whole point: it's a TRUSTED, mouse-driven click — not page.goto().
  expect(clicks[0].trusted).toBe(true);
  await page.close();
});

test("clickSectionLink returns false when the anchor is absent (caller goto-fallbacks)", async () => {
  const page = await context.newPage();
  await loadProfile(page);
  const nav = createPageNav();
  // Education has no Show-all anchor on this fixture.
  const ok = await nav.clickSectionLink(page, "/in/jane-doe/details/education/", mulberry32(2));
  expect(ok).toBe(false);
  await page.close();
});

test("section visit order varies by seed (not a fixed sequence) but covers all", () => {
  const sections = ["experience", "education", "skills", "certifications", "projects", "languages"];
  const orderA = shuffleInPlace([...sections], mulberry32(11));
  const orderB = shuffleInPlace([...sections], mulberry32(22));
  // Full coverage preserved (same set, no drops).
  expect([...orderA].sort()).toEqual([...sections].sort());
  expect([...orderB].sort()).toEqual([...sections].sort());
  // Different seeds → different visit order (the anti-"fixed sequence" property).
  expect(orderA).not.toEqual(orderB);
});
