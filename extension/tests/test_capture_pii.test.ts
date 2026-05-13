/**
 * Pins E-C-02 — password / cc-number captured into event payloads in plaintext.
 *
 * Today: `captureInput` reads `target.value` regardless of `type`.
 * Fix: redact when `type === "password"` or `autocomplete` is one of
 * `current-password`, `new-password`, `cc-number`, `cc-csc`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

if (typeof CSS === "undefined") (globalThis as any).CSS = {};
(CSS as any).escape = (v: string) => v.replace(/[!"#$%&'()*+,./:;<=>?@[\]^`{|}~\\]/g, "\\$&");

globalThis.chrome = {
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  tabs: { query: vi.fn(), sendMessage: vi.fn() },
  storage: { session: { get: vi.fn(), set: vi.fn(), onChanged: { addListener: vi.fn() } } },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
} as any;

function inputEvent(el: HTMLElement): Event {
  const ev = new Event("change");
  Object.defineProperty(ev, "target", { value: el });
  return ev;
}

describe("Capture PII redaction", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("does not include the literal password in payload.value (BUG E-C-02)", async () => {
    const { captureInput } = await import("../src/content/capture");
    const input = document.createElement("input");
    input.type = "password";
    input.name = "password";
    input.value = "supersecret123!";
    document.body.appendChild(input);

    const result = captureInput(inputEvent(input));
    expect(result.payload.value).not.toBe("supersecret123!");
    expect(JSON.stringify(result.payload)).not.toContain("supersecret123!");
  });

  it("redacts password and reports value_length=0 (BUG E-C-02)", async () => {
    const { captureInput } = await import("../src/content/capture");
    const input = document.createElement("input");
    input.type = "password";
    input.value = "hunter2";
    document.body.appendChild(input);

    const result = captureInput(inputEvent(input));
    expect(result.payload.value_length).toBe(0);
    expect(String(result.payload.value || "").includes("REDACTED")).toBe(true);
  });

  it("redacts inputs with autocomplete='cc-number' (BUG E-C-02)", async () => {
    const { captureInput } = await import("../src/content/capture");
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("autocomplete", "cc-number");
    input.value = "4111 1111 1111 1111";
    document.body.appendChild(input);

    const result = captureInput(inputEvent(input));
    expect(JSON.stringify(result.payload)).not.toContain("4111 1111 1111 1111");
  });

  it("does not redact ordinary text inputs", async () => {
    const { captureInput } = await import("../src/content/capture");
    const input = document.createElement("input");
    input.type = "text";
    input.value = "regular text";
    document.body.appendChild(input);

    const result = captureInput(inputEvent(input));
    expect(result.payload.value).toBe("regular text");
  });
});
