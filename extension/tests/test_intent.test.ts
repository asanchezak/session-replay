/**
 * Pin the human-readable `intent` string produced by `buildIntent` (capture.ts).
 *
 * `buildIntent` is not exported, but `captureClick` / `captureInput` call it
 * and embed the result in `payload.intent`. We assert via those.
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

describe("Intent string", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("click on anchor mentions href", async () => {
    const { captureClick } = await import("../src/content/capture");
    const a = document.createElement("a");
    a.href = "https://example.com";
    a.textContent = "Go";
    document.body.appendChild(a);

    const ev = new MouseEvent("click");
    Object.defineProperty(ev, "target", { value: a });
    const r = captureClick(ev);
    expect(String(r.payload.intent)).toContain("https://example.com");
    expect(String(r.payload.intent)).toContain("Go");
  });

  it("click on labeled button reports label", async () => {
    const { captureClick } = await import("../src/content/capture");
    const btn = document.createElement("button");
    btn.setAttribute("aria-label", "Submit form");
    btn.textContent = "OK";
    document.body.appendChild(btn);
    const ev = new MouseEvent("click");
    Object.defineProperty(ev, "target", { value: btn });
    const r = captureClick(ev);
    expect(String(r.payload.intent)).toContain("Submit form");
  });

  it("typing into named input mentions field name", async () => {
    const { captureInput } = await import("../src/content/capture");
    const input = document.createElement("input");
    input.name = "username";
    input.value = "alice";
    document.body.appendChild(input);
    const ev = new Event("change");
    Object.defineProperty(ev, "target", { value: input });
    const r = captureInput(ev);
    expect(String(r.payload.intent)).toContain("username");
  });

  it("select dropdown intent mentions chosen value", async () => {
    const { captureInput } = await import("../src/content/capture");
    const sel = document.createElement("select");
    const opt = document.createElement("option");
    opt.value = "remote";
    opt.text = "Remote";
    sel.name = "location";
    sel.appendChild(opt);
    sel.value = "remote";
    document.body.appendChild(sel);
    const ev = new Event("change");
    Object.defineProperty(ev, "target", { value: sel });
    const r = captureInput(ev);
    expect(String(r.payload.intent)).toContain("remote");
    expect(String(r.payload.intent)).toContain("location");
  });
});
