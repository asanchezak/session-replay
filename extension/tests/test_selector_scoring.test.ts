import { describe, it, expect, beforeEach } from "vitest";
import { makeButton, makeInput, makeDiv, createDom } from "../src/test/test-doubles";

if (typeof CSS === "undefined") (globalThis as any).CSS = {};
(CSS as any).escape = (v: string) => v.replace(/[!"#$%&'()*+,./:;<=>?@[\]^`{|}~\\]/g, "\\$&");

globalThis.chrome = {
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  tabs: { query: vi.fn(), sendMessage: vi.fn() },
  storage: { session: { get: vi.fn(), set: vi.fn(), onChanged: { addListener: vi.fn() } } },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
} as any;

describe("computeSelectorScore", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("data-testid attribute scores 0.95", async () => {
    const { computeSelectorScore } = await import("../src/content/selectors");
    const btn = makeButton("OK", { "data-testid": "submit-btn" });
    expect(computeSelectorScore("css", btn)).toBe(0.95);
  });

  it("data-qa attribute scores 0.95", async () => {
    const { computeSelectorScore } = await import("../src/content/selectors");
    const btn = makeButton("OK", { "data-qa": "submit" });
    expect(computeSelectorScore("css", btn)).toBe(0.95);
  });

  it("aria-label attribute scores 0.85", async () => {
    const { computeSelectorScore } = await import("../src/content/selectors");
    const btn = makeButton("OK", { "aria-label": "Submit" });
    expect(computeSelectorScore("css", btn)).toBe(0.85);
  });

  it("id attribute scores 0.80", async () => {
    const { computeSelectorScore } = await import("../src/content/selectors");
    const btn = makeButton("OK", { id: "submit-btn" });
    expect(computeSelectorScore("css", btn)).toBe(0.80);
  });

  it("name attribute scores 0.75", async () => {
    const { computeSelectorScore } = await import("../src/content/selectors");
    const input = makeInput({ name: "email" });
    expect(computeSelectorScore("css", input)).toBe(0.75);
  });

  it("role attribute scores 0.65 in css context", async () => {
    const { computeSelectorScore } = await import("../src/content/selectors");
    const btn = makeButton("OK", { role: "button" });
    expect(computeSelectorScore("css", btn)).toBe(0.65);
  });

  it("text selector scores 0.70", async () => {
    const { computeSelectorScore } = await import("../src/content/selectors");
    const btn = makeButton("Click Me");
    expect(computeSelectorScore("text", btn)).toBe(0.70);
  });

  it("accessibility with role and label scores 0.85", async () => {
    const { computeSelectorScore } = await import("../src/content/selectors");
    const btn = makeButton("OK", { role: "button", "aria-label": "Submit" });
    expect(computeSelectorScore("accessibility", btn)).toBe(0.85);
  });

  it("accessibility with role only scores 0.65", async () => {
    const { computeSelectorScore } = await import("../src/content/selectors");
    const btn = makeButton("OK", { role: "button" });
    expect(computeSelectorScore("accessibility", btn)).toBe(0.65);
  });

  it("nth-of-type path scores 0.30", async () => {
    const { computeSelectorScore } = await import("../src/content/selectors");
    const parent = document.createElement("div");
    for (let i = 0; i < 3; i++) {
      const btn = document.createElement("button");
      btn.textContent = `Btn ${i}`;
      parent.appendChild(btn);
    }
    document.body.appendChild(parent);
    const target = parent.children[1] as HTMLElement;
    expect(computeSelectorScore("css", target)).toBe(0.30);
  });

  it("xpath selector scores 0.20", async () => {
    const { computeSelectorScore } = await import("../src/content/selectors");
    const btn = makeButton("OK");
    expect(computeSelectorScore("xpath", btn)).toBe(0.20);
  });

  it("chain is sorted by score descending", async () => {
    const { buildSelectors } = await import("../src/content/selectors");
    const btn = makeButton("Save", { id: "save-btn", "data-testid": "save" });
    const chain = buildSelectors(btn);
    for (let i = 1; i < chain.length; i++) {
      expect((chain[i - 1].score || 0) >= (chain[i].score || 0)).toBe(true);
    }
  });

  it("data-testid appears before text in chain", async () => {
    const { buildSelectors } = await import("../src/content/selectors");
    const btn = makeButton("Save", { "data-testid": "save" });
    const chain = buildSelectors(btn);
    // No aria attributes → accessibility is skipped, css(0.95) > text(0.70) > xpath(0.20)
    expect(chain[0].type).toBe("css");
    expect(chain[0].score).toBe(0.95);
    expect(chain[1].type).toBe("text");
    expect(chain[1].score).toBe(0.70);
    expect(chain[2].type).toBe("xpath");
    expect(chain[2].score).toBe(0.20);
  });

  it("all selectors have scores in valid range", async () => {
    const { buildSelectors } = await import("../src/content/selectors");
    const div = makeDiv();
    const chain = buildSelectors(div);
    expect(chain.length).toBeGreaterThanOrEqual(2);
    for (const s of chain) {
      expect(typeof s.score).toBe("number");
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
    }
  });
});
