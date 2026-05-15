import { describe, it, expect, vi } from "vitest";

if (typeof CSS === "undefined") (globalThis as any).CSS = {};
(CSS as any).escape = (v: string) => v.replace(/[!"#$%&'()*+,./:;<=>?@[\]^`{|}~\\]/g, "\\$&");

globalThis.chrome = {
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  tabs: { query: vi.fn(), sendMessage: vi.fn() },
  storage: { session: { get: vi.fn(), set: vi.fn() } },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
} as any;

describe("Controlled input replay", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("types into React-controlled input using native value setter", async () => {
    const { executeStep } = await import("../src/content/replay");
    const input = document.createElement("input");
    input.type = "text";
    input.style.width = "100px";
    input.style.height = "30px";
    document.body.appendChild(input);

    const result = await executeStep({
      action_type: "type",
      selector_chain: [{ type: "css", value: "input" }],
      value: "hello",
    });
    expect(result.success).toBe(true);
    expect(input.value).toBe("hello");
  });

  it("dispatches input and change events for framework detection", async () => {
    const { executeStep } = await import("../src/content/replay");
    const input = document.createElement("input");
    input.type = "text";
    input.style.width = "100px";
    input.style.height = "30px";
    document.body.appendChild(input);

    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));

    await executeStep({
      action_type: "type",
      selector_chain: [{ type: "css", value: "input" }],
      value: "hello",
    });
    expect(events).toContain("input");
    expect(events).toContain("change");
  });

  it("handles empty value in type", async () => {
    const { executeStep } = await import("../src/content/replay");
    const input = document.createElement("input");
    input.type = "text";
    input.style.width = "100px";
    input.style.height = "30px";
    document.body.appendChild(input);

    const result = await executeStep({
      action_type: "type",
      selector_chain: [{ type: "css", value: "input" }],
    });
    expect(result.success).toBe(true);
    expect(input.value).toBe("");
  });
});
