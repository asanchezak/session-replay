/**
 * Unit tests for the extension-side healer.
 *
 * Pins E-C-07: today the healer applies AI selectors with confidence > 0.3.
 * The fix raises the cutoff (to e.g. 0.7) AND defers to settings.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

if (typeof CSS === "undefined") (globalThis as any).CSS = {};
(CSS as any).escape = (v: string) => v.replace(/[!"#$%&'()*+,./:;<=>?@[\]^`{|}~\\]/g, "\\$&");

const fakeTabsSendMessage = vi.fn();
const fakeApiHealStep = vi.fn();
const fakeApiRecoverRun = vi.fn();

globalThis.chrome = {
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  tabs: { sendMessage: fakeTabsSendMessage, query: vi.fn(), get: vi.fn(), update: vi.fn() },
  storage: { session: { get: vi.fn(), set: vi.fn(), setAccessLevel: vi.fn() } },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
  action: { onClicked: { addListener: vi.fn() } },
} as any;

// Mock api.ts before healer imports it.
vi.mock("../src/background/api", () => ({
  apiClient: {
    healStep: (...args: unknown[]) => fakeApiHealStep(...args),
    recoverRun: (...args: unknown[]) => fakeApiRecoverRun(...args),
  },
}));

vi.mock("../src/background/orchestrator", () => ({
  orchestrator: { notifyRecovering: vi.fn() },
}));

describe("StepHealer", () => {
  beforeEach(() => {
    fakeTabsSendMessage.mockReset();
    fakeApiHealStep.mockReset();
    fakeApiRecoverRun.mockReset();
  });

  it("falls back via method[0] without calling AI", async () => {
    const { stepHealer } = await import("../src/background/healer");
    // First sendMessage = DOM snippet capture. Second = EXECUTE_STEP for fallback method.
    fakeTabsSendMessage
      .mockResolvedValueOnce({ type: "DOM_SNIPPET_RESULT", html: "<html/>", url: "u", title: "t" })
      .mockResolvedValueOnce({ success: true });

    const result = await stepHealer.heal(
      "run-1", 0,
      {
        action_type: "click",
        selector_chain: [{ type: "css", value: "#missing" }],
        methods: [{ action_type: "click", selector_chain: [{ type: "css", value: "#fallback" }] }],
      },
      999,
      "wf", 1,
    );
    expect(result.success).toBe(true);
    expect(fakeApiHealStep).not.toHaveBeenCalled();
  });

  // E-C-07: pinned — confidence 0.4 should be rejected once threshold gate is wired
  it("pins E-C-07: confidence 0.4 should NOT apply (currently passes because dom too short)", async () => {
    const { stepHealer } = await import("../src/background/healer");
    fakeTabsSendMessage.mockResolvedValueOnce({ type: "DOM_SNIPPET_RESULT", html: "<html><body>".padEnd(100, "x")+"</body></html>", url: "u", title: "t" });
    fakeApiHealStep.mockResolvedValueOnce({
      step_index: 0,
      new_selectors: [{ type: "css", value: "#guess" }],
      confidence: 0.4,
      explanation: "low",
    });

    const result = await stepHealer.heal(
      "run-2", 0,
      { action_type: "click", selector_chain: [{ type: "css", value: "#missing" }] },
      999,
      "wf", 1,
    );
    // Fails today because healer checks confidence > 0.3 and 0.4 > 0.3
    expect(result.success).toBe(false);
  });

  it("applies AI selector at confidence 0.95", async () => {
    const { stepHealer } = await import("../src/background/healer");
    fakeTabsSendMessage
      .mockResolvedValueOnce({ type: "DOM_SNIPPET_RESULT", html: "<html><body>".padEnd(100, "x")+"</body></html>", url: "u", title: "t" })
      .mockResolvedValueOnce({ success: true });
    fakeApiHealStep.mockResolvedValueOnce({
      step_index: 0,
      new_selectors: [{ type: "css", value: "#correct" }],
      confidence: 0.95,
      explanation: "ok",
    });

    const result = await stepHealer.heal(
      "run-3", 0,
      { action_type: "click", selector_chain: [{ type: "css", value: "#missing" }] },
      999,
      "wf", 1,
    );
    expect(result.success).toBe(true);
    expect(result.newSelectors).toEqual([{ type: "css", value: "#correct" }]);
  });

  it("DOM capture failure reports descriptive error", async () => {
    const { stepHealer } = await import("../src/background/healer");
    fakeTabsSendMessage.mockRejectedValueOnce(new Error("no content script"));

    const result = await stepHealer.heal(
      "run-4", 0,
      { action_type: "click", selector_chain: [{ type: "css", value: "#missing" }] },
      999,
      "wf", 1,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not available|not found/);
  });
});
