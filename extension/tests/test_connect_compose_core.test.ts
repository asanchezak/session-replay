import { describe, it, expect, beforeEach, vi } from "vitest";
import { prepareConnectNoteDialog } from "../src/behavior/connect-compose-core.mjs";

// Golden tests for the shared connect-note core (used by both the daemon and the
// extension). Fake timers drive the internal waitFor polling so timeout cases
// don't wait 6-8s of real time.

async function run(): Promise<{ ok: boolean; reason?: string; ready?: boolean }> {
  vi.useFakeTimers();
  try {
    const p = prepareConnectNoteDialog();
    await vi.runAllTimersAsync();
    return await p;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  // jsdom does not implement innerText (real browsers do — the core matches
  // dialog/button text via innerText). Polyfill it to textContent for the tests.
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent;
    },
  });
  document.body.innerHTML = "";
});

describe("prepareConnectNoteDialog", () => {
  it("top_card_not_found when there is no profile top-card", async () => {
    document.body.innerHTML = `<main></main>`;
    expect(await run()).toEqual({ ok: false, reason: "top_card_not_found" });
  });

  it("already_pending when the top-card shows a pending invitation", async () => {
    document.body.innerHTML = `<div data-view-name="profile-top-card"><button aria-label="Pending">Pending</button></div>`;
    expect(await run()).toEqual({ ok: false, reason: "already_pending" });
  });

  it("no_connect_button when the top-card has neither Connect nor More", async () => {
    document.body.innerHTML = `<div data-view-name="profile-top-card"><button>Follow</button></div>`;
    expect(await run()).toEqual({ ok: false, reason: "no_connect_button" });
  });

  it("ignores a Connect button OUTSIDE the top-card (sidebar 'People you may know')", async () => {
    document.body.innerHTML =
      `<div data-view-name="profile-top-card"><button>Follow</button></div>` +
      `<aside><button aria-label="Connect">Connect</button></aside>`;
    expect(await run()).toEqual({ ok: false, reason: "no_connect_button" });
  });

  it("connect_modal_did_not_open when clicking Connect reveals no dialog", async () => {
    document.body.innerHTML = `<div data-view-name="profile-top-card"><button aria-label="Connect">Connect</button></div>`;
    expect(await run()).toEqual({ ok: false, reason: "connect_modal_did_not_open" });
  });

  it("note_textarea_missing when the dialog has no textarea", async () => {
    document.body.innerHTML =
      `<div data-view-name="profile-top-card"><button aria-label="Connect">Connect</button></div>` +
      `<div role="dialog">Add a note to your invitation</div>`;
    expect(await run()).toEqual({ ok: false, reason: "note_textarea_missing" });
  });

  it("ok+ready when Connect opens a dialog with a note textarea (EN)", async () => {
    document.body.innerHTML =
      `<div data-view-name="profile-top-card"><button aria-label="Connect">Connect</button></div>` +
      `<div role="dialog">Add a note to your invitation <textarea id="custom-message"></textarea></div>`;
    expect(await run()).toEqual({ ok: true, ready: true });
  });

  it("ok+ready in Spanish (Conectar / Personaliza tu invitación)", async () => {
    document.body.innerHTML =
      `<div data-view-name="profile-top-card"><button aria-label="Conectar">Conectar</button></div>` +
      `<div role="dialog">Personaliza tu invitación <textarea name="message"></textarea></div>`;
    expect(await run()).toEqual({ ok: true, ready: true });
  });
});
