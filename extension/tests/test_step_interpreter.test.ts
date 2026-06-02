import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs without types
import {
  orderSelectorChain,
  isDangerousXPath,
  normalizeText,
  parseAccessibility,
  parseShadowCss,
  parseAnchor,
  evaluateSuccessCondition,
  successConditionInputs,
} from "../src/behavior/step-interpreter.mjs";

describe("orderSelectorChain", () => {
  it("sorts by descending score, stable, non-mutating", () => {
    const chain = [
      { type: "css", value: "a", score: 0.2 },
      { type: "text", value: "b", score: 0.9 },
      { type: "xpath", value: "c" },
      { type: "css", value: "d", score: 0.9 },
    ];
    const before = chain.map((s) => s.value);
    const out = orderSelectorChain(chain);
    expect(out.map((s) => s.value)).toEqual(["b", "d", "a", "c"]); // 0.9,0.9 stable, then 0.2, then 0
    expect(chain.map((s) => s.value)).toEqual(before); // input untouched
  });

  it("returns [] for non-arrays", () => {
    expect(orderSelectorChain(undefined as never)).toEqual([]);
    expect(orderSelectorChain(null as never)).toEqual([]);
  });

  // Property: ordering is permutation-invariant and never drops/dups elements.
  it("property: stable, score-sorted, preserves multiset across input permutations", () => {
    const seedItems = [
      { type: "css", value: "p", score: 1 },
      { type: "css", value: "q", score: 0.5 },
      { type: "css", value: "r", score: 0.5 },
      { type: "css", value: "s", score: 0 },
    ];
    const perms = [
      [0, 1, 2, 3], [3, 2, 1, 0], [1, 0, 3, 2], [2, 3, 0, 1],
    ];
    for (const p of perms) {
      const input = p.map((i) => seedItems[i]);
      const out = orderSelectorChain(input);
      // monotonically non-increasing score
      for (let i = 1; i < out.length; i++) {
        expect((out[i - 1].score || 0) >= (out[i].score || 0)).toBe(true);
      }
      // same multiset of values
      expect([...out.map((x: { value: string }) => x.value)].sort()).toEqual(["p", "q", "r", "s"]);
    }
  });
});

describe("isDangerousXPath", () => {
  it("flags the banned functions and passes safe paths", () => {
    expect(isDangerousXPath("//span[normalize-space(text())='x']")).toBe(true);
    expect(isDangerousXPath("//div[count(*)>1]")).toBe(true);
    expect(isDangerousXPath("substring(//a, 1)")).toBe(true);
    expect(isDangerousXPath("//section/article/span")).toBe(false);
    expect(isDangerousXPath("//*[@id='x']")).toBe(false);
  });
});

describe("normalizeText", () => {
  it("folds accents, collapses whitespace, lowercases", () => {
    expect(normalizeText("  Acércate \n AHORA ")).toBe("acercate ahora");
    expect(normalizeText("")).toBe("");
  });
});

describe("parseAccessibility", () => {
  it("JSON object", () => {
    expect(parseAccessibility(JSON.stringify({ role: "button", label: "OK" }))).toEqual({ role: "button", label: "OK" });
  });
  it("JSON object with name alias", () => {
    expect(parseAccessibility(JSON.stringify({ role: "link", name: "Home" }))).toEqual({ role: "link", label: "Home" });
  });
  it("JSON array", () => {
    expect(parseAccessibility(JSON.stringify(["button", "Send"]))).toEqual({ role: "button", label: "Send" });
  });
  it("role[text='x'] bracket form", () => {
    expect(parseAccessibility("button[text='Send message']")).toEqual({ role: "button", label: "Send message" });
  });
  it("role|label pipe form", () => {
    expect(parseAccessibility("textbox|Email")).toEqual({ role: "textbox", label: "Email" });
  });
  it("'<role> <label>' word form", () => {
    expect(parseAccessibility("button Submit")).toEqual({ role: "button", label: "Submit" });
  });
  it("bare label", () => {
    expect(parseAccessibility("Just a label")).toEqual({ role: "", label: "Just a label" });
  });
});

describe("parseShadowCss", () => {
  it("parses host_chain + target", () => {
    expect(parseShadowCss(JSON.stringify({ host_chain: ["#a", "#b"], target: ".x" })))
      .toEqual({ hostChain: ["#a", "#b"], target: ".x" });
  });
  it("null on missing target or bad json", () => {
    expect(parseShadowCss(JSON.stringify({ host_chain: ["#a"] }))).toBeNull();
    expect(parseShadowCss("not json")).toBeNull();
  });
});

describe("parseAnchor", () => {
  it("parses anchor + offsets + relation with defaults", () => {
    expect(parseAnchor(JSON.stringify({ anchor_selector: "#a", offset_x: 5, offset_y: 9, relation: "right" })))
      .toEqual({ anchorSelector: "#a", offsetX: 5, offsetY: 9, relation: "right" });
    expect(parseAnchor(JSON.stringify({ anchor_selector: "#a" })))
      .toEqual({ anchorSelector: "#a", offsetX: 0, offsetY: 0, relation: "" });
  });
  it("null on missing anchor or bad json", () => {
    expect(parseAnchor(JSON.stringify({ offset_x: 1 }))).toBeNull();
    expect(parseAnchor("{bad")).toBeNull();
  });
});

describe("evaluateSuccessCondition", () => {
  it("no/empty condition passes", () => {
    expect(evaluateSuccessCondition(null)).toEqual({ ok: true });
    expect(evaluateSuccessCondition({})).toEqual({ ok: true });
    expect(evaluateSuccessCondition({ type: "" })).toEqual({ ok: true });
  });
  it("visible_text_contains (space-insensitive, case-insensitive, NOT accent-folded)", () => {
    // Matches replay.ts's _normalizeForCheck: collapse whitespace + lowercase,
    // but accents are NOT folded (so "Éxito" does NOT match "exito").
    expect(evaluateSuccessCondition({ type: "visible_text_contains", value: "TOTAL   éxito" }, { pageText: "operación con total éxito hoy" }).ok).toBe(true);
    expect(evaluateSuccessCondition({ type: "visible_text_contains", value: "éxito" }, { pageText: "con exito" }).ok).toBe(false);
    expect(evaluateSuccessCondition({ type: "visible_text_contains", value: "nope" }, { pageText: "hello" }).ok).toBe(false);
  });
  it("url_contains", () => {
    expect(evaluateSuccessCondition({ type: "url_contains", value: "/in/" }, { currentUrl: "https://x/in/abc" }).ok).toBe(true);
    expect(evaluateSuccessCondition({ type: "url_contains", value: "/jobs/" }, { currentUrl: "https://x/in/abc" }).ok).toBe(false);
  });
  it("input_value_contains, incl. missing target", () => {
    expect(evaluateSuccessCondition({ type: "input_value_contains", value: "abc" }, { inputValue: "xxabcyy" }).ok).toBe(true);
    expect(evaluateSuccessCondition({ type: "input_value_contains", value: "abc" }, { inputValue: null }).reason).toContain("no_target");
  });
  it("selector_exists", () => {
    expect(evaluateSuccessCondition({ type: "selector_exists", selector: "#x" }, { selectorFound: true }).ok).toBe(true);
    expect(evaluateSuccessCondition({ type: "selector_exists", selector: "#x" }, { selectorFound: false }).ok).toBe(false);
  });
  it("unknown type passes (lenient)", () => {
    expect(evaluateSuccessCondition({ type: "made_up" }, {}).ok).toBe(true);
  });
});

describe("successConditionInputs", () => {
  it("maps each type to the values the adapter must fetch", () => {
    expect(successConditionInputs({ type: "visible_text_contains" })).toEqual(["pageText"]);
    expect(successConditionInputs({ type: "url_contains" })).toEqual(["currentUrl"]);
    expect(successConditionInputs({ type: "input_value_contains" })).toEqual(["inputValue"]);
    expect(successConditionInputs({ type: "selector_exists" })).toEqual(["selectorFound"]);
    expect(successConditionInputs({ type: "other" })).toEqual([]);
    expect(successConditionInputs(null)).toEqual([]);
  });
});
