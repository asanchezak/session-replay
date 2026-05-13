/**
 * Property-based test for selector generation.
 *
 * For any element we attach to the DOM, `buildCssSelector(el)` must produce a
 * selector that uniquely resolves back to `el` via `document.querySelector`.
 * (As long as the element has a stable identifier.)
 *
 * `fast-check` may not be installed; we fall back to a hand-rolled fuzz that
 * generates random ID/class/attr combinations.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

if (typeof CSS === "undefined") (globalThis as any).CSS = {};
(CSS as any).escape = (v: string) =>
  v.replace(/[!"#$%&'()*+,./:;<=>?@[\]^`{|}~\\]/g, "\\$&");

globalThis.chrome = {
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  tabs: { query: vi.fn(), sendMessage: vi.fn() },
  storage: { session: { get: vi.fn(), set: vi.fn(), onChanged: { addListener: vi.fn() } } },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
} as any;

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randId(): string {
  const len = rand(3, 12);
  return "id_" + Array.from({ length: len }, () => "abcdefghij"[rand(0, 9)]).join("");
}

describe("Selector generation properties", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("ID selector round-trips for 100 random IDs", async () => {
    const { buildCssSelector } = await import("../src/content/selectors");
    for (let i = 0; i < 100; i++) {
      const id = randId();
      const el = document.createElement("button");
      el.id = id;
      document.body.appendChild(el);
      const sel = buildCssSelector(el as HTMLElement);
      expect(document.querySelector(sel)).toBe(el);
      el.remove();
    }
  });

  it("data-testid selector round-trips for 50 random values", async () => {
    const { buildCssSelector } = await import("../src/content/selectors");
    for (let i = 0; i < 50; i++) {
      const v = randId();
      const el = document.createElement("button");
      el.setAttribute("data-testid", v);
      document.body.appendChild(el);
      const sel = buildCssSelector(el as HTMLElement);
      expect(document.querySelector(sel)).toBe(el);
      el.remove();
    }
  });

  it("nth-of-type selector picks the right sibling among 5", async () => {
    const { buildCssSelector } = await import("../src/content/selectors");
    const parent = document.createElement("ul");
    document.body.appendChild(parent);
    const items: HTMLLIElement[] = [];
    for (let i = 0; i < 5; i++) {
      const li = document.createElement("li");
      parent.appendChild(li);
      items.push(li);
    }
    for (const li of items) {
      const sel = buildCssSelector(li as HTMLElement);
      expect(document.querySelector(sel)).toBe(li);
    }
  });

  it("text selector returns sensible content for button", async () => {
    const { buildTextSelector } = await import("../src/content/selectors");
    const btn = document.createElement("button");
    btn.textContent = "  Save  changes  ";
    document.body.appendChild(btn);
    expect(buildTextSelector(btn)).toBe("Save changes");
  });

  it("text selector returns null for empty content", async () => {
    const { buildTextSelector } = await import("../src/content/selectors");
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    expect(buildTextSelector(btn)).toBeNull();
  });

  it("a11y selector returns null when neither role nor aria-label", async () => {
    const { buildAccessibilitySelector } = await import("../src/content/selectors");
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    expect(buildAccessibilitySelector(btn)).toBeNull();
  });

  it("xpath selector resolves back to element", async () => {
    const { buildXPathSelector } = await import("../src/content/selectors");
    const div = document.createElement("section");
    div.id = "x";
    const inner = document.createElement("span");
    div.appendChild(inner);
    document.body.appendChild(div);
    const xp = buildXPathSelector(inner);
    const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    expect(r.singleNodeValue).toBe(inner);
  });
});
