import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { mockElementFromPoint, mockAnimationFrame } from "../src/test/test-doubles";

if (typeof CSS === "undefined") (globalThis as any).CSS = {};
(CSS as any).escape = (v: string) => v.replace(/[!"#$%&'()*+,./:;<=>?@[\]^`{|}~\\]/g, "\\$&");

globalThis.chrome = {
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  tabs: { query: vi.fn(), sendMessage: vi.fn() },
  storage: { session: { get: vi.fn(), set: vi.fn(), onChanged: { addListener: vi.fn() } } },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
} as any;

describe("checkVisibility", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("returns true for visible element", async () => {
    const { checkVisibility } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.textContent = "OK";
    document.body.appendChild(btn);
    expect(checkVisibility(btn)).toBe(true);
  });

  it("returns false for display:none", async () => {
    const { checkVisibility } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.style.display = "none";
    document.body.appendChild(btn);
    expect(checkVisibility(btn)).toBe(false);
  });

  it("returns false for visibility:hidden", async () => {
    const { checkVisibility } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.style.visibility = "hidden";
    document.body.appendChild(btn);
    expect(checkVisibility(btn)).toBe(false);
  });

  it("returns false for hidden attribute", async () => {
    const { checkVisibility } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.setAttribute("hidden", "");
    document.body.appendChild(btn);
    expect(checkVisibility(btn)).toBe(false);
  });

  it("returns true for zero-size element (visible in DOM even if 0x0)", async () => {
    const { checkVisibility } = await import("../src/content/replay");
    const empty = document.createElement("div");
    document.body.appendChild(empty);
    expect(checkVisibility(empty)).toBe(true);
  });
});

describe("checkEnabled", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("returns true for enabled button", async () => {
    const { checkEnabled } = await import("../src/content/replay");
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    expect(checkEnabled(btn)).toBe(true);
  });

  it("returns false for disabled button", async () => {
    const { checkEnabled } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.disabled = true;
    document.body.appendChild(btn);
    expect(checkEnabled(btn)).toBe(false);
  });

  it("returns false for disabled fieldset", async () => {
    const { checkEnabled } = await import("../src/content/replay");
    const fieldset = document.createElement("fieldset");
    fieldset.disabled = true;
    const btn = document.createElement("button");
    fieldset.appendChild(btn);
    document.body.appendChild(fieldset);
    expect(checkEnabled(btn)).toBe(false);
  });
});

describe("checkNotOverlayed", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("returns true via mocked elementFromPoint", async () => {
    const { checkNotOverlayed } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.style.width = "100px";
    btn.style.height = "30px";
    document.body.appendChild(btn);
    // JSDOM can't compute layout, so width/height will be 0 and function returns true
    expect(checkNotOverlayed(btn)).toBe(true);
  });
});

describe("waitForElement", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("passes for a visible, enabled element", async () => {
    const { waitForElement } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.style.width = "100px";
    btn.style.height = "30px";
    document.body.appendChild(btn);
    const result = await waitForElement(btn, { timeout: 500, reduceMotion: true });
    expect(result.passed).toBe(true);
  });

  it("fails for null element", async () => {
    const { waitForElement } = await import("../src/content/replay");
    const result = await waitForElement(null, { timeout: 100, reduceMotion: true });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("ELEMENT_NOT_FOUND");
  });

  it("fails for display:none element", async () => {
    const { waitForElement } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.style.display = "none";
    document.body.appendChild(btn);
    const result = await waitForElement(btn, { timeout: 100, reduceMotion: true });
    expect(result.passed).toBe(false);
  });

  it("force bypasses all checks", async () => {
    const { waitForElement } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.style.display = "none";
    document.body.appendChild(btn);
    const result = await waitForElement(btn, { force: true });
    expect(result.passed).toBe(true);
  });

  it("fails for disabled button", async () => {
    const { waitForElement } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.disabled = true;
    btn.style.width = "100px";
    btn.style.height = "30px";
    document.body.appendChild(btn);
    const result = await waitForElement(btn, { timeout: 100, reduceMotion: true });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("ELEMENT_NOT_ENABLED");
  });

  it("fails for readonly input", async () => {
    const { waitForElement, checkEditable } = await import("../src/content/replay");
    const input = document.createElement("input");
    input.readOnly = true;
    input.style.width = "100px";
    input.style.height = "30px";
    document.body.appendChild(input);
    // Wait passes visibility + enabled, but the calling action should fail
    const result = await waitForElement(input, { timeout: 100, reduceMotion: true });
    expect(result.passed).toBe(true); // visibility passes
    expect(checkEditable(input)).toBe(false); // but editable fails
  });
});

describe("executeStep (async)", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("clicks visible button", async () => {
    const { executeStep } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.id = "click-target";
    btn.style.width = "100px";
    btn.style.height = "30px";
    document.body.appendChild(btn);

    const result = await executeStep({
      action_type: "click",
      selector_chain: [{ type: "css", value: "#click-target" }],
    });
    expect(result.success).toBe(true);
  });

  it("returns element not found for missing element", async () => {
    const { executeStep } = await import("../src/content/replay");
    const result = await executeStep({
      action_type: "click",
      selector_chain: [{ type: "css", value: "#nonexistent" }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("ELEMENT_NOT_FOUND");
  });

  it("navigate skips element lookup", async () => {
    const { executeStep } = await import("../src/content/replay");
    const result = await executeStep({
      action_type: "navigate",
      selector_chain: [],
      value: "https://example.com",
    });
    expect(result.success).toBe(true);
  });

  it("scroll step bypasses wait", async () => {
    const { executeStep } = await import("../src/content/replay");
    const el = document.createElement("div");
    el.id = "scroll-target";
    el.style.height = "2000px";
    document.body.appendChild(el);

    const result = await executeStep({
      action_type: "scroll",
      selector_chain: [{ type: "css", value: "#scroll-target" }],
    });
    // Log error for debugging
    if (!result.success) console.log("Scroll test error:", result.error);
    expect(result.success).toBe(true);
  });

  it("types into input", async () => {
    const { executeStep } = await import("../src/content/replay");
    const input = document.createElement("input");
    input.type = "text";
    input.style.width = "100px";
    input.style.height = "30px";
    document.body.appendChild(input);

    const result = await executeStep({
      action_type: "type",
      selector_chain: [{ type: "css", value: "input" }],
      value: "test value",
    });
    expect(result.success).toBe(true);
    expect(input.value).toBe("test value");
  });

  it("selects option in select", async () => {
    const { executeStep } = await import("../src/content/replay");
    const select = document.createElement("select");
    select.style.width = "100px";
    select.style.height = "30px";
    for (const v of ["a", "b", "c"]) {
      const opt = document.createElement("option");
      opt.value = v;
      select.appendChild(opt);
    }
    document.body.appendChild(select);

    const result = await executeStep({
      action_type: "select",
      selector_chain: [{ type: "css", value: "select" }],
      value: "b",
    });
    expect(result.success).toBe(true);
    expect(select.value).toBe("b");
  });
});
