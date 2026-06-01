// Canonical in-page logic for opening a LinkedIn "Connect with a note" dialog,
// extracted from the duplicated copies in driver-daemon.mjs (composeDraftInPage)
// and background/openMessageComposerAndType.ts (de-dup Phase 3).
//
// prepareConnectNoteDialog() runs IN THE PAGE: it finds the Connect button scoped
// to the profile top-card (never the "People you may know" sidebar, whose Connect
// fires instantly to the wrong person), opens the dialog, reveals the note
// textarea, focuses + clears it, and returns. It does NOT type the note — each
// caller does that with its own strategy:
//   - daemon: real keystrokes via page.keyboard (typeHumanLike) for genuine events
//   - extension: atomic native-setter value write
//
// SERIALIZATION INVARIANT: this function is run via Playwright `page.evaluate` and
// (when wired up) `chrome.scripting.executeScript`, both of which serialize it via
// .toString(). It MUST stay self-contained — no imports, no closures over module
// scope, all helpers defined inside. Callers that inject it must inject THIS
// function directly, not a wrapper that references it as an import.

// Re-query selector for callers that type into the textarea after the core focuses
// it. Kept in sync with the in-core locate below (the core can't reference this
// const — it's serialized — so the literal is repeated there intentionally).
export const NOTE_TEXTAREA_SELECTOR =
  'textarea#custom-message, textarea[name="message"], textarea[aria-label*="message" i], textarea[aria-label*="nota" i]';

export async function prepareConnectNoteDialog() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function inGlobalNav(el) {
    if (el.closest('nav, header, #global-nav, .global-nav, [data-global-nav], [class*="global-nav"]')) return true;
    if (el.tagName === "A" && /\/messaging\//.test(el.getAttribute("href") || "")) return true;
    return false;
  }
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
    const menus = Array.from(document.querySelectorAll('[role="menu"], [aria-expanded="true"] + *, .artdeco-dropdown__content'));
    for (const m of menus) {
      const f = findActionButton(tokens, m);
      if (f) return f;
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
  const topCard = document.querySelector('[data-view-name="profile-top-card"]');
  if (!topCard) return { ok: false, reason: "top_card_not_found" };
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
  // Focus + clear only. Each caller types the note its own way.
  textarea.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setter) setter.call(textarea, ""); else textarea.value = "";
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(150);
  return { ok: true, ready: true };
}
