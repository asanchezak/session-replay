import { describe, it, expect, beforeEach } from "vitest";
// @ts-expect-error — .mjs module without types
import { orderChain, resolveChainInPage, PHASE_A_VERBS } from "../src/behavior/selector-resolve.mjs";

// Pure-logic + jsdom tests for the daemon's selector resolver. The
// geometry-dependent strategies (text viewport-priority, anchor hit-test) and
// xpath (jsdom's document.evaluate is unreliable) are covered by the Playwright
// fixture spec e2e/selector-resolve.spec.ts. Here we cover the parts that run
// faithfully in jsdom: ordering, css (incl. open-shadow pierce), shadow_css,
// and the accessibility role/label tiers.

describe("orderChain", () => {
  it("sorts by descending score", () => {
    const chain = [
      { type: "css", value: "a", score: 0.2 },
      { type: "text", value: "b", score: 0.9 },
      { type: "xpath", value: "c", score: 0.5 },
    ];
    expect(orderChain(chain).map((s) => s.value)).toEqual(["b", "c", "a"]);
  });

  it("treats a missing score as 0", () => {
    const chain = [{ type: "css", value: "x" }, { type: "css", value: "y", score: 0.1 }];
    expect(orderChain(chain).map((s) => s.value)).toEqual(["y", "x"]);
  });

  it("does not mutate the input array", () => {
    const chain = [{ type: "css", value: "a", score: 1 }, { type: "css", value: "b", score: 2 }];
    const before = chain.map((s) => s.value);
    orderChain(chain);
    expect(chain.map((s) => s.value)).toEqual(before);
  });

  it("returns [] for non-array input", () => {
    expect(orderChain(undefined as never)).toEqual([]);
    expect(orderChain(null as never)).toEqual([]);
  });
});

describe("PHASE_A_VERBS", () => {
  it("contains exactly click and type", () => {
    expect([...PHASE_A_VERBS].sort()).toEqual(["click", "type"]);
  });
});

describe("resolveChainInPage (jsdom — geometry-independent strategies)", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("resolves a css selector", () => {
    document.body.innerHTML = `<button data-testid="primary">Primary</button>`;
    const el = resolveChainInPage([{ type: "css", value: '[data-testid="primary"]' }]);
    expect(el?.textContent).toBe("Primary");
  });

  it("css pierces an open shadow root via deep search", () => {
    const host = document.createElement("div");
    host.id = "card";
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = `<button class="shadow-send" aria-label="Send">Send</button>`;
    document.body.appendChild(host);
    const el = resolveChainInPage([{ type: "css", value: ".shadow-send" }]);
    expect(el?.textContent).toBe("Send");
  });

  it("resolves a shadow_css host_chain + target", () => {
    const host = document.createElement("div");
    host.id = "card";
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = `<button class="shadow-send">Send</button>`;
    document.body.appendChild(host);
    const value = JSON.stringify({ host_chain: ["#card"], target: ".shadow-send" });
    const el = resolveChainInPage([{ type: "shadow_css", value }]);
    expect(el?.textContent).toBe("Send");
  });

  it("resolves accessibility role+label (JSON object)", () => {
    document.body.innerHTML = `<div role="dialog"><div role="button" aria-label="Confirm choice">OK</div></div>`;
    const value = JSON.stringify({ role: "button", label: "Confirm choice" });
    const el = resolveChainInPage([{ type: "accessibility", value }]);
    expect(el?.textContent).toBe("OK");
  });

  it("resolves accessibility via the 'role|label' string form", () => {
    document.body.innerHTML = `<button aria-label="Send message">x</button>`;
    const el = resolveChainInPage([{ type: "accessibility", value: "button|Send message" }]);
    expect((el as HTMLElement)?.getAttribute("aria-label")).toBe("Send message");
  });

  it("honors descending score across mixed strategies", () => {
    document.body.innerHTML = `<button id="a">A</button><button id="b">B</button>`;
    const el = resolveChainInPage([
      { type: "css", value: "#a", score: 0.1 },
      { type: "css", value: "#b", score: 0.9 },
    ]);
    expect((el as HTMLElement)?.id).toBe("b");
  });

  it("returns null when nothing matches", () => {
    document.body.innerHTML = `<div>nothing</div>`;
    expect(resolveChainInPage([{ type: "css", value: ".missing" }])).toBeNull();
  });

  it("skips an invalid selector and tries the next in the chain", () => {
    document.body.innerHTML = `<button id="real">real</button>`;
    const el = resolveChainInPage([
      { type: "css", value: "::::bad", score: 0.9 },
      { type: "css", value: "#real", score: 0.1 },
    ]);
    expect((el as HTMLElement)?.id).toBe("real");
  });
});
