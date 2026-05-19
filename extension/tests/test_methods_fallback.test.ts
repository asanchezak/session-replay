import { describe, it, expect, beforeEach, vi } from "vitest";

if (typeof CSS === "undefined") (globalThis as any).CSS = {};
(CSS as any).escape = (v: string) => v.replace(/[!"#$%&'()*+,./:;<=>?@[\]^`{|}~\\]/g, "\\$&");

globalThis.chrome = {
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  tabs: { query: vi.fn(), sendMessage: vi.fn() },
  storage: { session: { get: vi.fn(), set: vi.fn(), onChanged: { addListener: vi.fn() } } },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
} as any;

describe("executeStep methods fallback", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("uses methods[0] when primary selector chain fails", async () => {
    const { executeStep } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.textContent = "Iniciar";
    btn.style.width = "100px";
    btn.style.height = "30px";
    document.body.appendChild(btn);

    const r = await executeStep({
      action_type: "click",
      selector_chain: [{ type: "css", value: "#does-not-exist" }],
      methods: [
        {
          action_type: "click",
          selector_chain: [{ type: "text", value: "Iniciar" }],
        },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.via_method_index).toBe(0);
  });

  it("returns primary error when methods are absent", async () => {
    const { executeStep } = await import("../src/content/replay");
    const r = await executeStep({
      action_type: "click",
      selector_chain: [{ type: "css", value: "#missing" }],
    });
    expect(r.success).toBe(false);
    expect(r.via_method_index).toBeUndefined();
  });

  it("does not use methods when primary succeeds", async () => {
    const { executeStep } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.id = "primary";
    btn.textContent = "Click";
    btn.style.width = "60px";
    btn.style.height = "20px";
    document.body.appendChild(btn);

    const r = await executeStep({
      action_type: "click",
      selector_chain: [{ type: "css", value: "#primary" }],
      methods: [
        {
          action_type: "click",
          selector_chain: [{ type: "text", value: "Click" }],
        },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.via_method_index).toBeUndefined();
  });

  it("iterates methods in order and returns the first success index", async () => {
    const { executeStep } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.textContent = "Fallback";
    btn.style.width = "100px";
    btn.style.height = "30px";
    document.body.appendChild(btn);

    const r = await executeStep({
      action_type: "click",
      selector_chain: [{ type: "css", value: "#missing" }],
      methods: [
        {
          action_type: "click",
          selector_chain: [{ type: "css", value: "#also-missing" }],
        },
        {
          action_type: "click",
          selector_chain: [{ type: "text", value: "Fallback" }],
        },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.via_method_index).toBe(1);
  });
});
