/**
 * Pins E-C-06 — detector exports are never imported and the functions go untested.
 *
 * Once `detector.ts` is wired into the content-script runtime, these tests
 * become live integration checks. Today they ensure the matrix logic itself
 * is correct, so the fix is just "import and call".
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

if (typeof CSS === "undefined") (globalThis as any).CSS = {};
(CSS as any).escape = (v: string) => v.replace(/[!"#$%&'()*+,./:;<=>?@[\]^`{|}~\\]/g, "\\$&");

globalThis.chrome = {
  runtime: {
    sendMessage: vi.fn(),
    onInstalled: { addListener: vi.fn() },
    onMessage: { addListener: vi.fn() },
  },
  tabs: {
    sendMessage: vi.fn(),
    query: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  storage: {
    session: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
      setAccessLevel: vi.fn(),
    },
  },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
  action: { onClicked: { addListener: vi.fn() } },
  webNavigation: { onCompleted: { addListener: vi.fn(), removeListener: vi.fn() } },
} as any;

describe("detector", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("detects reCAPTCHA iframe", async () => {
    const { detectChallenges } = await import("../src/background/detector");
    const i = document.createElement("iframe");
    i.src = "https://www.google.com/recaptcha/api2/anchor";
    document.body.appendChild(i);
    const out = detectChallenges();
    expect(out.some((c) => c.type === "captcha")).toBe(true);
  });

  it("detects hCaptcha iframe", async () => {
    const { detectChallenges } = await import("../src/background/detector");
    const i = document.createElement("iframe");
    i.src = "https://newassets.hcaptcha.com/captcha/v1";
    document.body.appendChild(i);
    expect(detectChallenges().some((c) => c.type === "captcha")).toBe(true);
  });

  it("detects login form (high confidence with email + password)", async () => {
    const { detectChallenges } = await import("../src/background/detector");
    const u = document.createElement("input");
    u.type = "email";
    const p = document.createElement("input");
    p.type = "password";
    document.body.appendChild(u);
    document.body.appendChild(p);
    const hit = detectChallenges().find((c) => c.type === "login_form")!;
    expect(hit).toBeTruthy();
    expect(hit.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("detects 2FA via autocomplete=one-time-code", async () => {
    const { detectChallenges } = await import("../src/background/detector");
    const c = document.createElement("input");
    c.setAttribute("autocomplete", "one-time-code");
    document.body.appendChild(c);
    expect(detectChallenges().some((c) => c.type === "two_factor")).toBe(true);
  });

  it("detects unexpected modal via role=dialog", async () => {
    const { detectChallenges } = await import("../src/background/detector");
    const d = document.createElement("div");
    d.setAttribute("role", "dialog");
    d.style.display = "block";
    Object.defineProperty(d, "offsetWidth", { value: 500 });
    document.body.appendChild(d);
    expect(detectChallenges().some((c) => c.type === "unexpected_modal")).toBe(true);
  });

  it("returns empty array on clean page", async () => {
    const { detectChallenges } = await import("../src/background/detector");
    document.body.innerHTML = "<p>hello</p>";
    expect(detectChallenges()).toEqual([]);
  });

  it("E-N-26: 2FA false positive on `name='promo-code'`", async () => {
    const { detectChallenges } = await import("../src/background/detector");
    const c = document.createElement("input");
    c.name = "promo-code";
    document.body.appendChild(c);
    // Today this matches `name*="code"` and returns a 2fa hit. The fix should
    // be stricter (e.g., autocomplete=one-time-code OR inputmode=numeric +
    // password-prompt context).
    expect(detectChallenges().some((c) => c.type === "two_factor")).toBe(false);
  });

  it("E-C-06: detector is wired into the runtime (imported somewhere)", async () => {
    // Smoke test: ensure detector is at least imported by some module.
    const sw = await import("../src/background/service-worker");
    expect(typeof (sw as any).detectChallenges).toBe("function");
  });
});
