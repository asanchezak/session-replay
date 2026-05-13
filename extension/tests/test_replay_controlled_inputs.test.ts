/**
 * Pins E-C-01 — React/Vue controlled inputs cannot be replayed.
 *
 * Today `simulateType` does `element.value = value` directly. React intercepts
 * the property setter and ignores bare assignments. The fix uses the prototype
 * setter via `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)`.
 *
 * We simulate a "React-like controlled" input by replacing its own `value`
 * setter with a no-op observer that records assignments; the test passes
 * only when the prototype setter is called (which bypasses the override).
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

describe("Replay against controlled inputs", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("ordinary input takes value via simulateType", async () => {
    const { executeStep } = await import("../src/content/replay");
    const input = document.createElement("input");
    document.body.appendChild(input);

    const r = executeStep({ action_type: "type", selector_chain: [{ type: "css", value: "input" }], value: "hello" });
    expect(r.success).toBe(true);
    expect(input.value).toBe("hello");
  });

  it("React-controlled input: bare value= is intercepted, fix must use native setter (BUG E-C-01)", async () => {
    const { executeStep } = await import("../src/content/replay");
    const input = document.createElement("input");
    document.body.appendChild(input);

    // Simulate React: install an own-property setter that "consumes" the
    // assignment without storing it (analogous to React's controlled-input
    // shim, which uses `nativeInputValueSetter`).
    let intercepted = false;
    Object.defineProperty(input, "value", {
      configurable: true,
      get() { return ""; },
      set(_v: string) { intercepted = true; /* swallow */ },
    });

    executeStep({ action_type: "type", selector_chain: [{ type: "css", value: "input" }], value: "hello" });
    // Today: the bare `element.value = value` calls the override and React-like
    // shim swallows the value. The fix uses the prototype setter, so
    // `intercepted` will be FALSE (the override is bypassed).
    expect(intercepted).toBe(false);
  });

  it("React-controlled input: dispatches an 'input' event with bubbles (BUG E-C-01 sibling)", async () => {
    const { executeStep } = await import("../src/content/replay");
    const input = document.createElement("input");
    document.body.appendChild(input);
    const events: Event[] = [];
    input.addEventListener("input", (e) => events.push(e));
    input.addEventListener("change", (e) => events.push(e));

    executeStep({ action_type: "type", selector_chain: [{ type: "css", value: "input" }], value: "x" });

    // React's onChange listens on `input`, not `change`. Today both are
    // dispatched, so this passes; but the more important assertion below
    // currently fails because the input event lacks the InputEvent constructor
    // shape React expects.
    const inputEvts = events.filter((e) => e.type === "input");
    expect(inputEvts[0]).toBeInstanceOf(InputEvent);
  });
});
