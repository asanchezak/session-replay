/**
 * Function injected via chrome.scripting.executeScript into a LinkedIn
 * profile page. Locates the "Message" / "Mensaje" button, opens the
 * compose dialog, and pastes the rendered outreach message into the
 * contenteditable. DOES NOT click send.
 *
 * Returned shape: {ok: true} on success; {ok: false, reason: string}
 * on graceful failure (e.g., not a 1st-degree connection, button
 * missing, dialog never opened).
 *
 * Must be pure (no closures over module state) — executeScript serializes
 * it before injection.
 */
export async function openMessageComposerAndType(
  message: string,
): Promise<{ ok: boolean; reason?: string }> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function waitFor<T>(fn: () => T | null, timeoutMs: number, pollMs = 200): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = fn();
      if (v) return v;
      await sleep(pollMs);
    }
    return null;
  }

  // 1) Wait for the profile to land. LinkedIn 2025 puts the top card
  //    under [data-view-name="profile-top-card"] regardless of locale.
  const topCard = await waitFor(
    () => document.querySelector<HTMLElement>('[data-view-name="profile-top-card"]'),
    15000,
  );
  if (!topCard) return { ok: false, reason: "top_card_not_found" };

  // 2) Locate the Message button. Restrict to the profile <main>/top-card
  //    region so we don't click LinkedIn's global navbar "Messaging" link,
  //    which navigates to /messaging/ and never opens the compose dialog.
  //    "Message" / "Mensaje" / "Send a message" / "Enviar mensaje".
  const localeTokens = ["message", "mensaje", "send a message", "enviar mensaje", "inmail"];
  function findMessageButton(): HTMLElement | null {
    const profileScopes: Element[] = [];
    const topCardScope = document.querySelector('[data-view-name="profile-top-card"]');
    if (topCardScope) profileScopes.push(topCardScope);
    const mainScope = document.querySelector("main");
    if (mainScope) profileScopes.push(mainScope);
    if (!profileScopes.length) profileScopes.push(document.body);
    function inGlobalNav(el: Element): boolean {
      if (el.closest('nav, header, #global-nav, .global-nav, [data-global-nav], [class*="global-nav"]')) return true;
      // The persistent "/messaging/" anchor in the navbar matches our text
      // tokens — exclude it explicitly so we don't navigate away.
      if (el.tagName === "A" && /\/messaging\//.test(el.getAttribute("href") || "")) return true;
      return false;
    }
    for (const scope of profileScopes) {
      const ariaCandidates = Array.from(
        scope.querySelectorAll<HTMLElement>("button[aria-label], a[aria-label]"),
      );
      for (const el of ariaCandidates) {
        if (inGlobalNav(el)) continue;
        const label = (el.getAttribute("aria-label") || "").toLowerCase().trim();
        if (!label) continue;
        for (const tok of localeTokens) {
          if (label === tok || label.startsWith(tok + " ") || label.startsWith(tok + "…")) {
            return el;
          }
        }
      }
      const textCandidates = Array.from(
        scope.querySelectorAll<HTMLElement>(
          'button, a[role="button"], .pvs-profile-actions button',
        ),
      );
      for (const el of textCandidates) {
        if (inGlobalNav(el)) continue;
        const t = (el.innerText || el.textContent || "").trim().toLowerCase();
        if (!t) continue;
        for (const tok of localeTokens) {
          if (t === tok || t.startsWith(tok)) {
            return el;
          }
        }
      }
    }
    return null;
  }

  const button = await waitFor(findMessageButton, 8000);
  if (!button) return { ok: false, reason: "no_message_button" };

  // Scroll into view and click. Some LinkedIn buttons require a real
  // PointerEvent; .click() works in our manual tests but fall back if not.
  try {
    button.scrollIntoView({ block: "center" });
    button.click();
  } catch {
    /* ignore */
  }

  // 3) Wait for the compose dialog to render. LinkedIn uses role=dialog
  //    with a msg-form contenteditable inside.
  const dialog = await waitFor<HTMLElement>(() => {
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
    for (const d of dialogs) {
      if (d.querySelector('[contenteditable="true"]')) return d;
    }
    return null;
  }, 8000);
  if (!dialog) return { ok: false, reason: "dialog_did_not_open" };

  const editor =
    dialog.querySelector<HTMLElement>(".msg-form__contenteditable[contenteditable='true']") ||
    dialog.querySelector<HTMLElement>('[contenteditable="true"]');
  if (!editor) return { ok: false, reason: "editor_missing" };

  // 4) Focus + type. Mirrors extension/src/content/replay.ts:simulateType
  //    contenteditable branch. execCommand still works in Chrome despite
  //    being legacy — it's the only API that fires React synthetic input
  //    events correctly for LinkedIn's framework.
  editor.focus();
  // Clear any auto-filled placeholder or stale draft via select-all.
  try {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch {
    /* ignore */
  }

  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, message);
  } catch {
    inserted = false;
  }
  if (!inserted) {
    // Fallback: textContent + InputEvent dispatch.
    editor.textContent = message;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  }
  editor.dispatchEvent(new Event("change", { bubbles: true }));

  // Tiny settle so React commits the new value before the next tab opens.
  await sleep(250);

  return { ok: true };
}
