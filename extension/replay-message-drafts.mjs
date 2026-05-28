// Standalone replay tool — given a run id with extracted profiles, opens
// the message composer for each candidate and pastes the rendered draft
// without sending. Used to iterate quickly on the open_message_drafts
// behavior without re-running the slow LinkedIn search + scoring loop.
//
// Usage:
//   node replay-message-drafts.mjs <run_id>
//
// Honors --headed (default true) and --keep-open (default true). The
// browser stays open after composing all drafts so you can eyeball them
// and either send manually or close.

import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BACKEND = process.env.BACKEND || "http://localhost:8081";
const API_KEY = process.env.API_KEY || "dev-api-key-change-in-production";
const HEADERS = { "X-API-Key": API_KEY, "Content-Type": "application/json" };
const PROFILE_DIR = resolve(__dirname, ".linkedin-profile");

const runId = process.argv[2];
if (!runId) {
  console.error("usage: node replay-message-drafts.mjs <run_id>");
  process.exit(2);
}

async function fetchMessageTargets(id) {
  const r = await fetch(`${BACKEND}/v1/runs/${id}/message-targets`, { headers: HEADERS });
  if (!r.ok) throw new Error(`message-targets ${r.status}: ${await r.text()}`);
  return r.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function composeDraftInPage(page, message) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 200)).catch(() => {});
    await page.waitForSelector(
      '[data-view-name="profile-top-card"], section[componentkey*="Topcard"], main h1, main h2',
      { timeout: 35000 },
    );
  } catch {
    return { ok: false, reason: "top_card_not_found" };
  }
  const clicked = await page.evaluate(() => {
    const tokens = ["message", "mensaje", "send a message", "enviar mensaje", "inmail"];
    const lower = (s) => (s || "").trim().toLowerCase();
    const inGlobalNav = (el) => {
      if (el.closest('nav, header, #global-nav, .global-nav, [data-global-nav], [class*="global-nav"]')) return true;
      // The /messaging/ anchor IS the navbar messaging link (no role=button,
      // navigates away). Skip any anchor whose href points there.
      if (el.tagName === "A" && /\/messaging\//.test(el.getAttribute("href") || "")) return true;
      return false;
    };
    const scopes = [];
    const top = document.querySelector('[data-view-name="profile-top-card"]');
    if (top) scopes.push(top);
    const main = document.querySelector("main");
    if (main) scopes.push(main);
    if (!scopes.length) scopes.push(document.body);
    for (const scope of scopes) {
      const aria = Array.from(scope.querySelectorAll('button[aria-label], a[aria-label]'));
      for (const el of aria) {
        if (inGlobalNav(el)) continue;
        const l = lower(el.getAttribute("aria-label"));
        if (!l) continue;
        for (const t of tokens) {
          if (l === t || l.startsWith(t + " ") || l.startsWith(t + "…")) {
            el.scrollIntoView({ block: "center" }); el.click(); return true;
          }
        }
      }
      const buttons = Array.from(scope.querySelectorAll('button, a[role="button"]'));
      for (const el of buttons) {
        if (inGlobalNav(el)) continue;
        const t = lower(el.innerText || el.textContent);
        if (!t) continue;
        for (const tok of tokens) {
          if (t === tok || t.startsWith(tok)) {
            el.scrollIntoView({ block: "center" }); el.click(); return true;
          }
        }
      }
    }
    return false;
  });
  if (!clicked) return { ok: false, reason: "no_message_button" };
  try {
    await page.waitForFunction(() => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      for (const d of dialogs) if (d.querySelector('[contenteditable="true"]')) return true;
      return false;
    }, { timeout: 10000 });
  } catch {
    return { ok: false, reason: "dialog_did_not_open" };
  }
  return page.evaluate((msg) => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    let editor = null;
    for (const d of dialogs) {
      const e = d.querySelector('.msg-form__contenteditable[contenteditable="true"], [contenteditable="true"]');
      if (e) { editor = e; break; }
    }
    if (!editor) return { ok: false, reason: "editor_missing" };
    editor.focus();
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch {}
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, msg); } catch { inserted = false; }
    if (!inserted) {
      editor.textContent = msg;
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    }
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }, message);
}

async function main() {
  const payload = await fetchMessageTargets(runId);
  if (!payload.targets || payload.targets.length === 0) {
    console.error(`no targets for run ${runId} (template:${(payload.template || "").slice(0, 40)})`);
    process.exit(3);
  }
  console.log(`Fetched ${payload.targets.length} targets for run ${runId}`);
  for (const t of payload.targets) {
    console.log(`  · ${t.name || t.profile_url} (score=${t.score ?? "—"})`);
  }

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome", headless: false, viewport: { width: 1440, height: 900 },
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  for (let i = 0; i < payload.targets.length; i++) {
    const t = payload.targets[i];
    console.log(`\n[${i + 1}/${payload.targets.length}] Opening ${t.profile_url}`);
    const page = await ctx.newPage();
    try {
      await page.goto(t.profile_url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(3000);
      const r = await composeDraftInPage(page, t.rendered_message);
      console.log(`   ${r.ok ? "DRAFTED" : "FAIL"} ${t.name || ""} ${r.reason ? "reason=" + r.reason : ""}`);
      if (i < payload.targets.length - 1) await sleep(2500);
    } catch (e) {
      console.log(`   ERROR ${e.message?.slice(0, 200)}`);
    }
  }

  console.log("\nAll drafts attempted. Browser kept open. Ctrl+C to close.");
  await new Promise(() => {});
}

main().catch((e) => { console.error(e); process.exit(1); });
