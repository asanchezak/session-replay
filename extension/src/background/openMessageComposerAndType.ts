/**
 * Function injected via chrome.scripting.executeScript into a LinkedIn
 * profile page. Opens a Connection-Request-with-Note draft for the
 * candidate, pastes the rendered outreach text into the note textarea,
 * and STOPS — it never clicks Send.
 *
 * Why Connect-with-Note instead of direct Message: LinkedIn only exposes
 * the Message button to 1st-degree connections (or paid InMail). Connect
 * is available on almost any profile, and the optional "Add a note"
 * textarea (300-char limit) carries a personalized message that the
 * recipient sees when accepting the invitation.
 *
 * Return shape:
 *   {ok: true}                              — note pasted, awaiting Send
 *   {ok: false, reason: "<short token>"}    — graceful failure (no
 *                                              Connect button, modal
 *                                              didn't open, textarea
 *                                              missing, etc.)
 *
 * Pure (no closures over module state) — executeScript serializes the
 * function before injection.
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

  function inGlobalNav(el: Element): boolean {
    if (el.closest('nav, header, #global-nav, .global-nav, [data-global-nav], [class*="global-nav"]')) return true;
    if (el.tagName === "A" && /\/messaging\//.test(el.getAttribute("href") || "")) return true;
    return false;
  }

  function findActionButton(tokens: string[], scope: Element | null): HTMLElement | null {
    if (!scope) return null;
    const ariaEls = Array.from(
      scope.querySelectorAll<HTMLElement>("button[aria-label], a[aria-label]"),
    );
    for (const el of ariaEls) {
      if (inGlobalNav(el)) continue;
      const label = (el.getAttribute("aria-label") || "").toLowerCase().trim();
      if (!label) continue;
      for (const tok of tokens) {
        if (label === tok || label.startsWith(tok + " ") || label.startsWith(tok + "…") || label.includes(" " + tok + " ")) {
          return el;
        }
      }
    }
    const textEls = Array.from(
      scope.querySelectorAll<HTMLElement>('button, a[role="button"], div[role="button"], li[role="menuitem"]'),
    );
    for (const el of textEls) {
      if (inGlobalNav(el)) continue;
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      if (!t) continue;
      for (const tok of tokens) {
        if (t === tok || t.startsWith(tok)) {
          return el;
        }
      }
    }
    return null;
  }

  function findInOpenMenus(tokens: string[]): HTMLElement | null {
    const menus = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"], [aria-expanded="true"] + *, .artdeco-dropdown__content'));
    for (const m of menus) {
      const found = findActionButton(tokens, m);
      if (found) return found;
    }
    return null;
  }

  // 1) Wait for profile to render.
  const topCard = await waitFor<HTMLElement>(
    () =>
      document.querySelector<HTMLElement>('[data-view-name="profile-top-card"]')
      || document.querySelector<HTMLElement>('section[componentkey*="Topcard"]')
      || document.querySelector<HTMLElement>('main h1, main h2'),
    20000,
  );
  if (!topCard) return { ok: false, reason: "top_card_not_found" };

  // 2) Find Connect button — strictly scoped to the profile's top-card
  //    so we don't trip the "People you may know" sidebar Connect buttons
  //    (those fire invitations INSTANTLY, no modal, wrong recipient).
  const profileTopCard = document.querySelector<HTMLElement>(
    '[data-view-name="profile-top-card"]',
  );
  if (!profileTopCard) return { ok: false, reason: "top_card_not_found" };

  const pendingTokens = ["pending", "pendiente", "invitation sent", "invitación enviada"];
  if (findActionButton(pendingTokens, profileTopCard)) return { ok: false, reason: "already_pending" };

  const connectTokens = ["connect", "conectar", "invitar", "invite", "vincular"];
  const moreTokens = ["more", "más", "mas"];

  let connectBtn = findActionButton(connectTokens, profileTopCard);
  if (!connectBtn) {
    const more = findActionButton(moreTokens, profileTopCard);
    if (more) {
      try {
        more.scrollIntoView({ block: "center" });
        more.click();
      } catch {}
      await sleep(600);
      connectBtn = await waitFor<HTMLElement>(() => findInOpenMenus(connectTokens), 5000);
    }
  }
  if (!connectBtn) return { ok: false, reason: "no_connect_button" };

  try {
    connectBtn.scrollIntoView({ block: "center" });
    connectBtn.click();
  } catch {}

  // 3) Wait for the invitation modal. LinkedIn renders it as
  //    role="dialog" with a heading "Add a note to your invitation"
  //    (or the Spanish equivalent "Personaliza tu invitación").
  const dialog = await waitFor<HTMLElement>(() => {
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
    for (const d of dialogs) {
      const txt = (d.innerText || "").toLowerCase();
      if (/invit|connect|conectar|personaliz/i.test(txt)) return d;
    }
    return null;
  }, 8000);
  if (!dialog) return { ok: false, reason: "connect_modal_did_not_open" };

  // 4) If a "Send without a note" / "Add a note" toggle is present, click
  //    "Add a note" to reveal the textarea. The textarea is sometimes
  //    visible immediately; in that case the click is a no-op.
  const addNote = Array.from(
    dialog.querySelectorAll<HTMLElement>('button, a[role="button"]'),
  ).find((b) => {
    const t = (b.innerText || b.textContent || "").trim().toLowerCase();
    return t.includes("add a note")
      || t.includes("añadir nota")
      || t.includes("personalizar")
      || t.includes("personalize")
      || t === "add a note";
  });
  if (addNote) {
    try { addNote.click(); } catch {}
    await sleep(400);
  }

  // 5) Locate the textarea. LinkedIn uses <textarea id="custom-message">
  //    historically, but the id changes; selector falls back to any
  //    visible <textarea> inside the dialog.
  const textarea = await waitFor<HTMLTextAreaElement>(() => {
    const t = dialog.querySelector<HTMLTextAreaElement>(
      'textarea#custom-message, textarea[name="message"], textarea[aria-label*="message" i], textarea[aria-label*="nota" i], textarea',
    );
    return t || null;
  }, 6000);
  if (!textarea) return { ok: false, reason: "note_textarea_missing" };

  // 6) Paste the message. Cap at 300 chars (LinkedIn's hard limit on
  //    invitation notes).
  const trimmed = (message || "").slice(0, 300);
  textarea.focus();
  textarea.value = "";
  // Use the native setter so React/Vue see the change.
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (nativeSetter) nativeSetter.call(textarea, trimmed);
  else textarea.value = trimmed;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));

  await sleep(250);

  return { ok: true };
}
