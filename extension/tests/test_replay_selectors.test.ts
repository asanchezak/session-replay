import { describe, it, expect, beforeEach, vi } from "vitest";

if (typeof CSS === "undefined") (globalThis as any).CSS = {};
(CSS as any).escape = (v: string) => v.replace(/[!"#$%&'()*+,./:;<=>?@[\]^`{|}~\\]/g, "\\$&");

globalThis.chrome = {
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  tabs: { query: vi.fn(), sendMessage: vi.fn() },
  storage: { session: { get: vi.fn(), set: vi.fn(), onChanged: { addListener: vi.fn() } } },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
} as any;

describe("Selector chain fallthrough", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("falls through CSS → text", async () => {
    const { executeStep } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.textContent = "Save";
    btn.style.width = "100px";
    btn.style.height = "30px";
    document.body.appendChild(btn);
    const r = await executeStep({
      action_type: "click",
      selector_chain: [
        { type: "css", value: "#nonexistent" },
        { type: "text", value: "Save" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("falls through CSS → a11y", async () => {
    const { executeStep } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", "Submit");
    btn.style.width = "100px";
    btn.style.height = "30px";
    document.body.appendChild(btn);
    const r = await executeStep({
      action_type: "click",
      selector_chain: [
        { type: "css", value: "#nope" },
        { type: "accessibility", value: JSON.stringify(["button", "Submit"]) },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("matches accessibility label-only selector", async () => {
    const { executeStep } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.textContent = "Iniciar";
    btn.style.width = "100px";
    btn.style.height = "30px";
    document.body.appendChild(btn);
    const r = await executeStep({
      action_type: "click",
      selector_chain: [{ type: "accessibility", value: "Iniciar" }],
    });
    expect(r.success).toBe(true);
  });

  it("matches accessibility role+text bracket selector", async () => {
    const { executeStep } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.textContent = "Inicio";
    btn.style.width = "100px";
    btn.style.height = "30px";
    document.body.appendChild(btn);
    const r = await executeStep({
      action_type: "click",
      selector_chain: [{ type: "accessibility", value: "button[text='Inicio']" }],
    });
    expect(r.success).toBe(true);
  });

  it("matches accessibility text ignoring accents/case", async () => {
    const { executeStep } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.textContent = "Iniciar sesión";
    btn.style.width = "100px";
    btn.style.height = "30px";
    document.body.appendChild(btn);
    const r = await executeStep({
      action_type: "click",
      selector_chain: [{ type: "accessibility", value: "iniciar sesion" }],
    });
    expect(r.success).toBe(true);
  });

  it("falls through all four → xpath wins", async () => {
    const { executeStep } = await import("../src/content/replay");
    const wrapper = document.createElement("div");
    const btn = document.createElement("button");
    wrapper.appendChild(btn);
    document.body.appendChild(wrapper);
    const r = await executeStep({
      action_type: "click",
      selector_chain: [
        { type: "css", value: "#nope" },
        { type: "text", value: "matchnothing" },
        { type: "accessibility", value: JSON.stringify(["nonsense", ""]) },
        { type: "xpath", value: "//button" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("returns failure on totally missing target", async () => {
    const { executeStep } = await import("../src/content/replay");
    const r = await executeStep({
      action_type: "click",
      selector_chain: [
        { type: "css", value: "#a" },
        { type: "text", value: "b" },
        { type: "xpath", value: "//div[@class='c']" },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("E-C-05: chain respects a11y-before-css order (PRD §7.2)", async () => {
    const { executeStep } = await import("../src/content/replay");
    const wrong = document.createElement("button");
    wrong.id = "primary";
    wrong.style.width = "100px";
    wrong.style.height = "30px";
    document.body.appendChild(wrong);

    const right = document.createElement("button");
    right.setAttribute("role", "button");
    right.setAttribute("aria-label", "Login");
    right.id = "wrong-id-but-correct-target";
    right.style.width = "100px";
    right.style.height = "30px";
    document.body.appendChild(right);

    let clickedOn: Element | null = null;
    document.addEventListener("click", (e) => { clickedOn = e.target as Element; });

    await executeStep({
      action_type: "click",
      selector_chain: [
        { type: "accessibility", value: JSON.stringify(["button", "Login"]) },
        { type: "css", value: "#primary" },
      ],
    });
    expect(clickedOn).toBe(right);
  });
});
