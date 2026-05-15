import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeButton, makeDiv } from "../src/test/test-doubles";

if (typeof CSS === "undefined") (globalThis as any).CSS = {};
(CSS as any).escape = (v: string) => v.replace(/[!"#$%&'()*+,./:;<=>?@[\]^`{|}~\\]/g, "\\$&");

globalThis.chrome = {
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  tabs: { query: vi.fn(), sendMessage: vi.fn() },
  storage: { session: { get: vi.fn(), set: vi.fn(), onChanged: { addListener: vi.fn() } } },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
} as any;

describe("buildAnchorSelector", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("creates anchor selector relative to parent with id", async () => {
    const { buildAnchorSelector } = await import("../src/content/selectors");
    const parent = makeDiv({ id: "form-container" });
    const btn = document.createElement("button");
    btn.textContent = "Submit";
    parent.appendChild(btn);

    const result = buildAnchorSelector(btn);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("anchor");
    expect(result!.score).toBe(0.55);
    const parsed = JSON.parse(result!.value);
    expect(parsed.anchor_selector).toContain("form-container");
  });

  it("returns null for element with no stable ancestor", async () => {
    const { buildAnchorSelector } = await import("../src/content/selectors");
    const btn = document.createElement("button");
    btn.textContent = "Orphan";
    document.body.appendChild(btn);
    const result = buildAnchorSelector(btn);
    expect(result).toBeNull();
  });

  it("finds data-testid as stable anchor", async () => {
    const { buildAnchorSelector } = await import("../src/content/selectors");
    const parent = makeDiv({ "data-testid": "modal" });
    const input = document.createElement("input");
    parent.appendChild(input);

    const result = buildAnchorSelector(input);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.value);
    expect(parsed.anchor_selector).toContain("data-testid");
  });

  it("returns null when element has no parent", async () => {
    const { buildAnchorSelector } = await import("../src/content/selectors");
    const detached = document.createElement("button");
    const result = buildAnchorSelector(detached);
    expect(result).toBeNull();
  });

  it("anchor is included in buildSelectors chain", async () => {
    const { buildSelectors } = await import("../src/content/selectors");
    const parent = makeDiv({ id: "wrapper" });
    const btn = document.createElement("button");
    btn.textContent = "Item";
    parent.appendChild(btn);

    const chain = buildSelectors(btn);
    const anchorSel = chain.find((s) => s.type === "anchor");
    expect(anchorSel).toBeDefined();
  });
});

describe("findElementByAnchor", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("falls back when anchor element is missing", async () => {
    const { executeStep } = await import("../src/content/replay");
    const btn = makeButton("Fallback");
    btn.id = "fallback-btn";
    btn.style.width = "100px";
    btn.style.height = "30px";

    const result = await executeStep({
      action_type: "click",
      selector_chain: [
        { type: "anchor", value: JSON.stringify({ anchor_selector: "#gone", relation: "inside" }) },
        { type: "css", value: "#fallback-btn" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("handles malformed anchor value gracefully", async () => {
    const { executeStep } = await import("../src/content/replay");
    const btn = makeButton("OK");
    btn.id = "ok-btn";
    btn.style.width = "100px";
    btn.style.height = "30px";

    const result = await executeStep({
      action_type: "click",
      selector_chain: [
        { type: "anchor", value: "not-json" },
        { type: "css", value: "#ok-btn" },
      ],
    });
    expect(result.success).toBe(true);
  });
});
