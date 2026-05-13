/**
 * Selector-chain fallthrough tests.
 *
 * Pins E-C-05: priority order today is CSS → text → a11y → xpath; PRD §7.2
 * wants a11y first. We don't reorder here, but we assert that a chain with
 * a11y BEFORE css does succeed (chain order is honored).
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

describe("Selector chain fallthrough", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("falls through CSS → text", async () => {
    const { executeStep } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.textContent = "Save";
    document.body.appendChild(btn);
    const r = executeStep({
      action_type: "click",
      selector_chain: [
        { type: "css", value: "#nonexistent" },
        { type: "text", value: "Save" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("falls through CSS → a11y", async () => {
    const { executeStep } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", "Submit");
    document.body.appendChild(btn);
    const r = executeStep({
      action_type: "click",
      selector_chain: [
        { type: "css", value: "#nope" },
        { type: "accessibility", value: JSON.stringify(["button", "Submit"]) },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("falls through all four → xpath wins", async () => {
    const { executeStep } = await import("../src/content/replay");
    const wrapper = document.createElement("div");
    const btn = document.createElement("button");
    wrapper.appendChild(btn);
    document.body.appendChild(wrapper);
    const r = executeStep({
      action_type: "click",
      selector_chain: [
        { type: "css", value: "#nope" },
        { type: "text", value: "matchnothing" },
        { type: "accessibility", value: JSON.stringify(["nonsense", ""]) },
        { type: "xpath", value: "//button" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("returns failure on totally missing target", async () => {
    const { executeStep } = await import("../src/content/replay");
    const r = executeStep({
      action_type: "click",
      selector_chain: [
        { type: "css", value: "#a" },
        { type: "text", value: "b" },
        { type: "xpath", value: "//div[@class='c']" },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("E-C-05: chain respects a11y-before-css order (PRD §7.2)", async () => {
    const { executeStep } = await import("../src/content/replay");
    // Two candidates: a CSS-stable but semantically wrong one, and an a11y-tagged correct one.
    const wrong = document.createElement("button");
    wrong.id = "primary";
    document.body.appendChild(wrong);

    const right = document.createElement("button");
    right.setAttribute("role", "button");
    right.setAttribute("aria-label", "Login");
    right.id = "wrong-id-but-correct-target";
    document.body.appendChild(right);

    let clickedOn: Element | null = null;
    document.addEventListener("click", (e) => { clickedOn = e.target as Element; });

    executeStep({
      action_type: "click",
      selector_chain: [
        { type: "accessibility", value: JSON.stringify(["button", "Login"]) },
        { type: "css", value: "#primary" },
      ],
    });
    // Expected: the FIRST selector wins (currently CSS-first order is not what
    // PRD wants; the chain priority must be source-authored). Today the
    // executeStep loop iterates in chain order, so this should pass — but if
    // the future reorders it, this becomes the canary.
    expect(clickedOn).toBe(right);
  });
});
