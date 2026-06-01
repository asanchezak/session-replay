/**
 * Opens a Connection-Request-with-Note draft on a LinkedIn profile and writes the
 * personalized note (atomic native-setter set), then STOPS — it never clicks Send.
 *
 * Why Connect-with-Note instead of direct Message: LinkedIn only exposes Message to
 * 1st-degree connections (or paid InMail). Connect is available on almost any
 * profile, and the optional "Add a note" textarea (300-char limit) carries a
 * personalized message the recipient sees when accepting.
 *
 * The connect → dialog → textarea logic is the shared canonical core
 * (../behavior/connect-compose-core.mjs), also used by the daemon — a single source
 * of truth so a LinkedIn DOM change is fixed once, not twice (the drift between the
 * two copies is exactly what risks anti-bot flags).
 *
 * SERIALIZATION CAVEAT: this function is intended to be injected via
 * chrome.scripting.executeScript, which serializes it via .toString(). A function
 * that *references* an import (prepareConnectNoteDialog) throws in the page. When
 * wiring this to a call site, inject the CORE directly (it is self-contained) and
 * do the value-set as a follow-up step. This wrapper is currently NOT wired to any
 * call site (imported but unused), so it carries no runtime risk today.
 *
 * Return shape:
 *   {ok: true}                            — note written, awaiting Send
 *   {ok: false, reason: "<short token>"}  — graceful failure
 */
import { prepareConnectNoteDialog, NOTE_TEXTAREA_SELECTOR } from "../behavior/connect-compose-core.mjs";

export async function openMessageComposerAndType(
  message: string,
): Promise<{ ok: boolean; reason?: string }> {
  const prep = await prepareConnectNoteDialog();
  if (!prep.ok) return { ok: false, reason: prep.reason };

  // Core focused + cleared the note textarea; write the text atomically via the
  // native setter so React/Vue see the change. (The daemon types it keystroke by
  // keystroke instead — same shared core, divergent typing strategy by design.)
  const trimmed = (message || "").slice(0, 300);
  const textarea = document.querySelector<HTMLTextAreaElement>(NOTE_TEXTAREA_SELECTOR);
  if (!textarea) return { ok: false, reason: "note_textarea_missing" };
  textarea.focus();
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (nativeSetter) nativeSetter.call(textarea, trimmed);
  else textarea.value = trimmed;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));

  return { ok: true };
}
