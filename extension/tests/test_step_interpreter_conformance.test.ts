import { describe, it, expect, beforeEach } from "vitest";
// @ts-expect-error — .mjs without types
import { resolveChainInPage, orderChain } from "../src/behavior/selector-resolve.mjs";
// @ts-expect-error — .mjs without types
import { orderSelectorChain, parseAccessibility, parseShadowCss } from "../src/behavior/step-interpreter.mjs";

// CONFORMANCE: the daemon's in-page resolveChainInPage is a self-contained copy
// of the selector logic (it CANNOT import step-interpreter.mjs — it's serialized
// into the page via evaluateHandle). These tests assert that copy still agrees
// with the shared step-interpreter, so the two can't drift. (replay.ts, by
// contrast, imports the shared module directly — see test_replay_selectors.)

describe("orderChain conformance", () => {
  it("selector-resolve.orderChain is the shared orderSelectorChain", () => {
    expect(orderChain).toBe(orderSelectorChain);
  });
});

describe("resolveChainInPage accessibility parsing matches shared parseAccessibility", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  // Every accessibility value form the shared parser supports must resolve in
  // the in-page resolver to an element built from the shared parse.
  const ACCESSIBILITY_VALUES = [
    JSON.stringify({ role: "button", label: "Confirm choice" }),
    JSON.stringify(["button", "Send"]),
    "button[text='Save changes']",
    "button|Delete",
    "button Submit",
  ];

  for (const value of ACCESSIBILITY_VALUES) {
    it(`resolves "${value}" using the shared-parsed role/label`, () => {
      const { role, label } = parseAccessibility(value);
      // Build an element matching the shared parse. If the in-page parser drifted
      // (e.g. dropped the pipe/bracket form), it would parse a different
      // role/label and fail to find this element.
      document.body.innerHTML = `<div role="${role}" aria-label="${label}">marker-${label}</div>`;
      const el = resolveChainInPage([{ type: "accessibility", value }]);
      expect(el, `in-page resolver must agree with shared parse of ${value}`).not.toBeNull();
      expect((el as HTMLElement).getAttribute("aria-label")).toBe(label);
    });
  }
});

describe("resolveChainInPage shadow_css parsing matches shared parseShadowCss", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("walks the shared-parsed host_chain to the target", () => {
    const value = JSON.stringify({ host_chain: ["#card"], target: ".needle" });
    const parsed = parseShadowCss(value);
    expect(parsed).toEqual({ hostChain: ["#card"], target: ".needle" });
    const host = document.createElement("div");
    host.id = "card";
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = `<button class="needle">found</button>`;
    document.body.appendChild(host);
    const el = resolveChainInPage([{ type: "shadow_css", value }]);
    expect(el?.textContent).toBe("found");
  });
});
