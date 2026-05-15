import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";

if (typeof CSS === "undefined") (globalThis as any).CSS = {};
(CSS as any).escape = (v: string) => v.replace(/[!"#$%&'()*+,./:;<=>?@[\]^`{|}~\\]/g, "\\$&");

globalThis.chrome = {
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  tabs: { query: vi.fn(), sendMessage: vi.fn() },
  storage: { session: { get: vi.fn(), set: vi.fn(), onChanged: { addListener: vi.fn() } } },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
} as any;

describe("Selector score property-based", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("all scores are in [0, 1] for any element", async () => {
    const { computeSelectorScore, buildSelectors } = await import("../src/content/selectors");
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        async (hasId, hasTestId, hasName, hasRole, hasLabel, hasClass, hasDataCy, hasDataQa, isButton) => {
          const el = document.createElement(isButton ? "button" : "div");
          if (hasId) el.id = "test-id";
          if (hasTestId) el.setAttribute("data-testid", "test");
          if (hasDataCy) el.setAttribute("data-cy", "test");
          if (hasDataQa) el.setAttribute("data-qa", "test");
          if (hasName) el.setAttribute("name", "test-name");
          if (hasRole) el.setAttribute("role", "button");
          if (hasLabel) el.setAttribute("aria-label", "test-label");
          if (hasClass) el.className = "some-class";
          document.body.appendChild(el);

          const chain = buildSelectors(el);
          for (const sel of chain) {
            expect(sel.score).toBeGreaterThanOrEqual(0);
            expect(sel.score).toBeLessThanOrEqual(1);
          }

          const cssScore = computeSelectorScore("css", el);
          expect(cssScore).toBeGreaterThanOrEqual(0);
          expect(cssScore).toBeLessThanOrEqual(1);

          document.body.removeChild(el);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("chain is always sorted by score descending", async () => {
    const { buildSelectors } = await import("../src/content/selectors");
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        async (a, b, c, d, e) => {
          const el = document.createElement("button");
          if (a) el.id = "id";
          if (b) el.setAttribute("data-testid", "tid");
          if (c) el.setAttribute("aria-label", "lbl");
          if (d) el.setAttribute("role", "btn");
          if (e) el.textContent = "text";
          document.body.appendChild(el);

          const chain = buildSelectors(el);
          for (let i = 1; i < chain.length; i++) {
            const prev = chain[i - 1].score || 0;
            const curr = chain[i].score || 0;
            expect(prev).toBeGreaterThanOrEqual(curr);
          }

          document.body.removeChild(el);
        },
      ),
      { numRuns: 100 },
    );
  });
});
