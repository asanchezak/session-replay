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

// Connection-Request-with-Note flow — see live-linkedin-driver.mjs for
// the canonical comment.
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
  const trimmed = (message || "").slice(0, 300);
  return page.evaluate(async (msg) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    function inGlobalNav(el) {
      if (el.closest('nav, header, #global-nav, .global-nav, [data-global-nav], [class*="global-nav"]')) return true;
      if (el.tagName === "A" && /\/messaging\//.test(el.getAttribute("href") || "")) return true;
      return false;
    }
    // CRITICAL scoping: only the profile's own top-card. "main" includes
    // the "People you may know" sidebar, whose Connect buttons fire
    // invitations INSTANTLY (no modal) — clicking those would send
    // unintended connection requests to the wrong people.
    const topCard = document.querySelector('[data-view-name="profile-top-card"]');
    function findActionButton(tokens, scope) {
      if (!scope) return null;
      const aria = Array.from(scope.querySelectorAll("button[aria-label], a[aria-label]"));
      for (const el of aria) {
        if (inGlobalNav(el)) continue;
        const l = (el.getAttribute("aria-label") || "").toLowerCase().trim();
        if (!l) continue;
        for (const t of tokens) {
          if (l === t || l.startsWith(t + " ") || l.startsWith(t + "…") || l.includes(" " + t + " ")) return el;
        }
      }
      const others = Array.from(scope.querySelectorAll('button, a[role="button"], div[role="button"], li[role="menuitem"]'));
      for (const el of others) {
        if (inGlobalNav(el)) continue;
        const t = (el.innerText || el.textContent || "").trim().toLowerCase();
        if (!t) continue;
        for (const tok of tokens) {
          if (t === tok || t.startsWith(tok)) return el;
        }
      }
      return null;
    }
    function findInOpenMenus(tokens) {
      // After clicking "More", LinkedIn renders a [role="menu"] or
      // [aria-expanded] dropdown. Look in any open one.
      const menus = Array.from(document.querySelectorAll('[role="menu"], [aria-expanded="true"] + *, .artdeco-dropdown__content'));
      for (const m of menus) {
        const found = findActionButton(tokens, m);
        if (found) return found;
      }
      return null;
    }
    async function waitFor(fn, timeoutMs, poll = 200) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const v = fn();
        if (v) return v;
        await sleep(poll);
      }
      return null;
    }
    if (!topCard) return { ok: false, reason: "top_card_not_found" };
    // Detect already-sent invitations so we don't try to re-connect.
    const pendingTokens = ["pending", "pendiente", "invitation sent", "invitación enviada"];
    if (findActionButton(pendingTokens, topCard)) return { ok: false, reason: "already_pending" };

    const connectTokens = ["connect", "conectar", "invitar", "invite", "vincular"];
    const moreTokens = ["more", "más", "mas"];
    let connectBtn = findActionButton(connectTokens, topCard);
    if (!connectBtn) {
      const more = findActionButton(moreTokens, topCard);
      if (more) {
        try { more.scrollIntoView({ block: "center" }); more.click(); } catch {}
        await sleep(600);
        connectBtn = await waitFor(() => findInOpenMenus(connectTokens), 5000);
      }
    }
    if (!connectBtn) return { ok: false, reason: "no_connect_button" };
    try { connectBtn.scrollIntoView({ block: "center" }); connectBtn.click(); } catch {}
    const dialog = await waitFor(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      for (const d of dialogs) {
        const txt = (d.innerText || "").toLowerCase();
        if (/invit|connect|conectar|personaliz/.test(txt)) return d;
      }
      return null;
    }, 8000);
    if (!dialog) return { ok: false, reason: "connect_modal_did_not_open" };
    const addNote = Array.from(dialog.querySelectorAll('button, a[role="button"]')).find((b) => {
      const t = (b.innerText || b.textContent || "").trim().toLowerCase();
      return t.includes("add a note") || t.includes("añadir nota") || t.includes("personalizar") || t.includes("personalize");
    });
    if (addNote) { try { addNote.click(); } catch {} await sleep(400); }
    const textarea = await waitFor(() => dialog.querySelector(
      'textarea#custom-message, textarea[name="message"], textarea[aria-label*="message" i], textarea[aria-label*="nota" i], textarea'
    ), 6000);
    if (!textarea) return { ok: false, reason: "note_textarea_missing" };
    textarea.focus();
    textarea.value = "";
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(textarea, msg);
    else textarea.value = msg;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(200);
    return { ok: true };
  }, trimmed);
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
