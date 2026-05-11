import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock chrome API
globalThis.chrome = {
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  tabs: { query: vi.fn(), sendMessage: vi.fn() },
  storage: { session: { get: vi.fn(), set: vi.fn() } },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
} as any;

describe("Capture utilities", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("should build a selector from element ID", async () => {
    const { buildSelector } = await import("../src/content/capture");
    const el = document.createElement("button");
    el.id = "submit-btn";
    document.body.appendChild(el);
    expect(buildSelector(el as HTMLElement)).toBe("#submit-btn");
  });

  it("should build a selector from class and tag", async () => {
    const { buildSelector } = await import("../src/content/capture");
    const el = document.createElement("button");
    el.className = "primary large";
    document.body.appendChild(el);
    const selector = buildSelector(el as HTMLElement);
    expect(selector).toContain("button");
    expect(selector).toContain("primary");
  });

  it("should capture click event metadata", async () => {
    const { captureClick } = await import("../src/content/capture");
    const el = document.createElement("button");
    el.textContent = "Click Me";
    el.id = "test-btn";
    el.setAttribute("aria-label", "Test Button");
    el.setAttribute("role", "button");
    document.body.appendChild(el);

    const event = new MouseEvent("click", {
      clientX: 100,
      clientY: 200,
      button: 0,
    });
    Object.defineProperty(event, "target", { value: el });

    const result = captureClick(event);
    expect(result.event_type).toBe("click");
    expect(result.payload.target.tag).toBe("button");
    expect(result.payload.target.id).toBe("test-btn");
    expect(result.payload.client_x).toBe(100);
    expect(result.payload.client_y).toBe(200);
    expect(result.payload.target.selector).toContain("test-btn");
  });

  it("should capture input event metadata", async () => {
    const { captureInput } = await import("../src/content/capture");
    const input = document.createElement("input");
    input.type = "text";
    input.name = "search";
    input.placeholder = "Search...";
    input.value = "hello";
    document.body.appendChild(input);

    const event = new Event("change");
    Object.defineProperty(event, "target", { value: input });

    const result = captureInput(event);
    expect(result.event_type).toBe("type");
    expect(result.payload.target.tag).toBe("input");
    expect(result.payload.input_type).toBe("text");
    expect(result.payload.field_name).toBe("search");
    expect(result.payload.value_length).toBe(5);
  });

  it("should capture data attributes", async () => {
    const { getDataAttributes } = await import("../src/content/capture");
    const el = document.createElement("div");
    el.setAttribute("data-test-id", "123");
    el.setAttribute("data-cy", "submit");
    document.body.appendChild(el);

    const attrs = getDataAttributes(el as HTMLElement);
    expect(attrs["data-test-id"]).toBe("123");
    expect(attrs["data-cy"]).toBe("submit");
  });

  it("should return empty data attrs for element without them", async () => {
    const { getDataAttributes } = await import("../src/content/capture");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const attrs = getDataAttributes(el as HTMLElement);
    expect(attrs).toBeUndefined();
  });
});

describe("Replay utilities", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("should find element by CSS selector", async () => {
    const { executeStep } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.id = "target";
    document.body.appendChild(btn);

    const result = executeStep({
      action_type: "click",
      selector_chain: [{ type: "css", value: "#target" }],
    });

    expect(result.success).toBe(true);
  });

  it("should find element by text content", async () => {
    const { executeStep } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.textContent = "Submit Form";
    document.body.appendChild(btn);

    const result = executeStep({
      action_type: "click",
      selector_chain: [{ type: "text", value: "Submit Form" }],
    });

    expect(result.success).toBe(true);
  });

  it("should find element by accessibility role", async () => {
    const { executeStep } = await import("../src/content/replay");
    const el = document.createElement("div");
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", "Submit");
    document.body.appendChild(el);

    const result = executeStep({
      action_type: "click",
      selector_chain: [{ type: "accessibility", value: "button|Submit" }],
    });

    expect(result.success).toBe(true);
  });

  it("should fall back through selector chain", async () => {
    const { executeStep } = await import("../src/content/replay");
    const btn = document.createElement("button");
    btn.id = "actual-target";
    btn.textContent = "Click here";
    document.body.appendChild(btn);

    const result = executeStep({
      action_type: "click",
      selector_chain: [
        { type: "css", value: "#nonexistent" },
        { type: "text", value: "Click here" },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("should return failure when element not found", async () => {
    const { executeStep } = await import("../src/content/replay");
    const result = executeStep({
      action_type: "click",
      selector_chain: [{ type: "css", value: "#does-not-exist" }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("should simulate typing into input", async () => {
    const { executeStep } = await import("../src/content/replay");
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);

    const result = executeStep({
      action_type: "type",
      selector_chain: [{ type: "css", value: "input" }],
      value: "test value",
    });

    expect(result.success).toBe(true);
    expect(input.value).toBe("test value");
  });

  it("should simulate select option", async () => {
    const { executeStep } = await import("../src/content/replay");
    const select = document.createElement("select");
    const opt1 = document.createElement("option");
    opt1.value = "a";
    opt1.text = "Option A";
    const opt2 = document.createElement("option");
    opt2.value = "b";
    opt2.text = "Option B";
    select.appendChild(opt1);
    select.appendChild(opt2);
    document.body.appendChild(select);

    const result = executeStep({
      action_type: "select",
      selector_chain: [{ type: "css", value: "select" }],
      value: "b",
    });

    expect(result.success).toBe(true);
    expect(select.value).toBe("b");
  });
});
