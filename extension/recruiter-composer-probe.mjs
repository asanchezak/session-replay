/**
 * READ-ONLY probe for the LinkedIn Recruiter (Talent) BULK MESSAGE composer.
 *
 * Goal: capture the two selectors the recording never recorded — the message
 * BODY field and the SEND button — by driving to the "Easy Recruit" project
 * pipeline, selecting its (single) candidate, and OPENING the Message composer.
 *
 * SAFETY (hard rules):
 *   - NEVER types a message body. NEVER clicks Send / submit. Read-only.
 *   - On any login/checkpoint/captcha wall: abort immediately, no retries,
 *     no circuit-breaker writes (this is a probe, not the daemon).
 *   - Slow + human-paced: random multi-second dwells, bezier mouse travel
 *     before every click, gradual scrolls. One careful session.
 *
 * CONTEXT: must run in the SAME logon context as the daemon (scheduled task,
 * user linkedin-bot, S4U) so Chrome can DPAPI-decrypt the staged session
 * cookies. Launched directly from an SSH network logon it gets a login wall.
 *
 * Output: .debug/composer-probe/<stage>.{png,json,html} + probe.log + STATUS.
 */
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { STEALTH_INIT } from "./src/shared/stealth.mjs";
import { OVERLAY_INIT } from "./src/shared/overlay-init.mjs";
import { isBlockerUrl, detectChallengeInPage } from "./src/behavior/blocker-detect.mjs";
import { createPageNav } from "./src/behavior/page-nav.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = resolve(__dirname, ".linkedin-profile");
const OUT = resolve(__dirname, ".debug", "composer-probe");
mkdirSync(OUT, { recursive: true });

const PROJECT_NAME = process.env.PROJECT_NAME || "Easy Recruit";
const { moveMouseAlongBezier, humanScrollSeeded } = createPageNav();
const rand = Math.random;

const LOGF = resolve(OUT, "probe.log");
function log(...a) {
  const line = new Date().toISOString().slice(11, 19) + " " + a.join(" ");
  console.log(line);
  try { appendFileSync(LOGF, line + "\n"); } catch {}
}
function status(s) { try { writeFileSync(resolve(OUT, "STATUS"), s + "\n"); } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Human dwell: random, generous. think() between major actions.
const think = (min = 2500, max = 6500) => sleep(min + Math.floor(rand() * (max - min)));

// ── DOM inventory: every interactive element with selector-building attrs ────
const INVENTORY_FN = (rootSelector) => {
  const root = rootSelector ? document.querySelector(rootSelector) : document.body;
  if (!root) return { error: "root-not-found", rootSelector };
  const sel = 'button, a[role="button"], input, textarea, [contenteditable], [role="textbox"], [role="combobox"], [role="dialog"]';
  const els = Array.from(root.querySelectorAll(sel));
  const out = [];
  for (const el of els) {
    const cs = window.getComputedStyle(el);
    out.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      aria: (el.getAttribute("aria-label") || "").trim(),
      placeholder: el.getAttribute("placeholder") || el.getAttribute("aria-placeholder") || "",
      name: el.getAttribute("name") || "",
      type: el.getAttribute("type") || "",
      id: el.id || "",
      cls: (el.className?.toString() || "").slice(0, 180),
      dataView: el.getAttribute("data-view-name") || el.getAttribute("data-live-test-component") || "",
      contenteditable: el.getAttribute("contenteditable") || "",
      text: (el.innerText || el.textContent || "").trim().slice(0, 70),
      visible: el.offsetParent !== null && cs.visibility !== "hidden" && cs.display !== "none",
    });
  }
  return { rootSelector: rootSelector || "body", count: out.length, elements: out };
};

async function dump(page, stage, rootSelector = null) {
  try { await page.screenshot({ path: resolve(OUT, `${stage}.png`), fullPage: false }); } catch (e) { log("screenshot fail", stage, e.message); }
  try {
    const inv = await page.evaluate(INVENTORY_FN, rootSelector);
    inv.url = page.url();
    inv.title = await page.title().catch(() => "");
    writeFileSync(resolve(OUT, `${stage}.json`), JSON.stringify(inv, null, 2));
    log(`stage[${stage}] url=${inv.url} elements=${inv.count ?? "-"}`);
  } catch (e) { log("inventory fail", stage, e.message); }
  if (rootSelector) {
    const html = await page.$eval(rootSelector, (n) => n.outerHTML).catch(() => null);
    if (html) writeFileSync(resolve(OUT, `${stage}.html`), html);
  }
}

// Wall check after every navigation. Returns true if blocked.
async function blocked(page, stage) {
  if (isBlockerUrl(page.url())) { log(`WALL(url) at ${stage}: ${page.url()}`); return true; }
  const ch = await detectChallengeInPage(page);
  if (ch) { log(`WALL(dom:${ch.type}) at ${stage}`); return true; }
  return false;
}

// Slow, human page load: navigate, dwell, settle the cursor + a gentle scroll.
async function humanGoto(page, url, stage) {
  log(`goto ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
  await think(3000, 6000);
  if (await blocked(page, stage)) { await dump(page, `BLOCKED-${stage}`); throw new Error(`BLOCKED at ${stage}`); }
  try { await moveMouseAlongBezier(page, { x: 400 + rand() * 500, y: 250 + rand() * 300 }, rand); } catch {}
  await humanScrollSeeded(page, 2 + Math.floor(rand() * 2), rand).catch(() => {});
  await think(1500, 3500);
}

// Human click on the first element matching a text/aria regex. Bezier travel +
// real mouse click. Returns true if it clicked. NEVER used for Send/submit.
async function humanClick(page, opts, label) {
  const { textRe, ariaSel } = opts;
  let handle = null;
  if (ariaSel) { const l = page.locator(ariaSel).first(); if (await l.count()) handle = await l.elementHandle(); }
  if (!handle && textRe) {
    handle = await page.evaluateHandle((src) => {
      const re = new RegExp(src, "i");
      const els = Array.from(document.querySelectorAll('a, button, span[role="button"], div[role="button"], [role="link"]'));
      const hit = els.find((e) => re.test((e.innerText || e.textContent || "").trim()) && e.offsetParent !== null);
      return hit || null;
    }, textRe.source);
    if (handle && !(await handle.evaluate((n) => !!n).catch(() => false))) handle = null;
  }
  if (!handle) { log(`click MISS: ${label}`); return false; }
  try {
    await handle.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await think(1200, 2800);
    const box = await handle.boundingBox();
    if (box) {
      await moveMouseAlongBezier(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, rand);
      await sleep(120 + Math.floor(rand() * 220));
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    } else {
      await handle.click({ timeout: 5000 });
    }
    log(`clicked: ${label}`);
    await think(2500, 5000);
    return true;
  } catch (e) { log(`click ERR ${label}: ${e.message}`); return false; }
}

let ok = false;
status("RUNNING");
const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome", headless: false,
  viewport: { width: 1280, height: 720 },
  args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", "--disable-features=ChromeWhatsNewUI", "--profile-directory=Default"],
  ignoreDefaultArgs: ["--enable-automation"],
});
await ctx.addInitScript(STEALTH_INIT);
await ctx.addInitScript(OVERLAY_INIT).catch(() => {});
const page = ctx.pages()[0] || await ctx.newPage();

try {
  // 0) Land on Recruiter home like a normal user opening the app.
  await humanGoto(page, "https://www.linkedin.com/talent/home", "home");
  await dump(page, "0-home");

  // 1) Projects list (canonical URL) → confirm session is live + find project.
  await humanGoto(page, "https://www.linkedin.com/talent/projects", "projects");
  await dump(page, "1-projects");
  const projectHref = await page.evaluate((name) => {
    const links = Array.from(document.querySelectorAll('a[href*="/talent/hire/"]'));
    const hit = links.find((a) => (a.innerText || a.textContent || "").trim().toLowerCase().includes(name.toLowerCase()));
    return hit ? hit.getAttribute("href") : null;
  }, PROJECT_NAME);
  log("project href:", String(projectHref));
  if (!projectHref) { log("project not found by name; see 1-projects.json"); status("NO_PROJECT"); }
  else {
    const projectId = (projectHref.match(/\/talent\/hire\/(\d+)/) || [])[1];
    log("project id:", projectId);

    // 2) Open the project pipeline (people in the project) — click the link.
    let nav = await humanClick(page, { textRe: new RegExp("^" + PROJECT_NAME + "$") }, `project ${PROJECT_NAME}`);
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await think(2500, 5000);
    if (await blocked(page, "after-project")) { await dump(page, "BLOCKED-after-project"); throw new Error("BLOCKED after project"); }
    // Ensure we are on the pipeline view.
    if (!/\/manage\//.test(page.url())) {
      await humanClick(page, { textRe: /^Pipeline$/, ariaSel: 'button[aria-label="Pipeline"]' }, "Pipeline");
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      await think(2500, 4500);
    }
    if (!/\/manage\//.test(page.url())) {
      await humanGoto(page, `https://www.linkedin.com/talent/hire/${projectId}/manage/all`, "pipeline-direct");
    }
    await dump(page, "2-pipeline");

    // 3) Select the candidate(s): click the select-all / row checkbox.
    const cb = page.locator('input[type="checkbox"]').first();
    if (await cb.count()) {
      const box = await cb.boundingBox();
      if (box) { await moveMouseAlongBezier(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, rand); await sleep(200); }
      await cb.click({ timeout: 8000 }).catch((e) => log("checkbox click fail", e.message));
      await think(1800, 3500);
    } else { log("no checkbox found"); }
    await dump(page, "3-selected");

    // 4) Open the Message composer. Overflow "More Items" first (recording),
    //    then "Message (N)". Confirm dialog "Ok" if present. NEVER send.
    await humanClick(page, { ariaSel: 'button[aria-label="More Items"]' }, "More Items");
    let opened = await humanClick(page, { textRe: /^Message \(\d+\)$/ }, "Message (N)");
    if (!opened) opened = await humanClick(page, { ariaSel: 'button[aria-label^="Message"], a[aria-label^="Message"]' }, "Message(aria)");
    if (!opened) opened = await humanClick(page, { textRe: /^Message$/ }, "Message(text)");
    await humanClick(page, { ariaSel: 'button[aria-label="Ok"]' }, "Ok-confirm");
    await think(2500, 4500);

    // 5) Dump the composer (the prize: body field + Send button selectors).
    await dump(page, "4-composer-full");
    for (const rootSel of [".single-message-composer", '[role="dialog"]', ".msg-form", "form"]) {
      const exists = await page.locator(rootSel).count().catch(() => 0);
      if (exists) await dump(page, `5-composer_${rootSel.replace(/[^a-z0-9]+/gi, "_")}`, rootSel);
    }
    ok = true;
    status(opened ? "OK_COMPOSER" : "OK_NO_COMPOSER");
  }
} catch (e) {
  log("ERROR:", e.message);
  await dump(page, "ERROR").catch(() => {});
  status("BLOCKED_OR_ERROR");
} finally {
  await think(1500, 2500);
  await ctx.close().catch(() => {});
  log(ok ? "DONE ok" : "DONE with issues");
  process.exit(0);
}
