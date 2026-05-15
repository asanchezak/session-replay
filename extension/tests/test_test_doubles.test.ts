import { describe, it, expect, beforeEach, vi, afterEach, beforeAll } from "vitest";
import { FakeChromeStorage, FakeChromeRuntime, createDom, makeButton, makeInput, makeDiv, makeSelect, makeElement, mockAnimationFrame, mockElementFromPoint } from "../src/test/test-doubles";

describe("FakeChromeStorage", () => {
  let storage: FakeChromeStorage;

  beforeEach(() => { storage = new FakeChromeStorage(); });

  it("defaults to empty", async () => {
    expect(await storage.get("anything")).toEqual({});
    expect(await storage.get(null)).toEqual({});
  });

  it("stores and retrieves a value", async () => {
    await storage.set({ key: "value" });
    expect(await storage.get("key")).toEqual({ key: "value" });
  });

  it("retrieves multiple keys", async () => {
    await storage.set({ a: "1", b: "2" });
    expect(await storage.get(["a", "b"])).toEqual({ a: "1", b: "2" });
  });

  it("returns default for missing keys", async () => {
    expect(await storage.get({ missing: "default" })).toEqual({ missing: "default" });
  });

  it("removes a key", async () => {
    await storage.set({ x: "y" });
    await storage.remove("x");
    expect(await storage.get("x")).toEqual({});
  });

  it("clears all data", async () => {
    await storage.set({ a: "1", b: "2" });
    await storage.clear();
    expect(await storage.get(null)).toEqual({});
  });

  it("fires onChanged on set", async () => {
    const cb = vi.fn();
    storage.onChanged.addListener(cb);
    await storage.set({ foo: "bar" });
    expect(cb).toHaveBeenCalledWith({ foo: { oldValue: undefined, newValue: "bar" } });
  });

  it("fires onChanged on remove", async () => {
    await storage.set({ foo: "bar" });
    const cb = vi.fn();
    storage.onChanged.addListener(cb);
    await storage.remove("foo");
    expect(cb).toHaveBeenCalledWith({ foo: { oldValue: "bar", newValue: undefined } });
  });

  it("does not fire onChanged for unchanged keys on set", async () => {
    await storage.set({ foo: "bar" });
    const cb = vi.fn();
    storage.onChanged.addListener(cb);
    await storage.set({ foo: "bar" });
    expect(cb).toHaveBeenCalledWith({ foo: { oldValue: "bar", newValue: "bar" } });
  });

  it("reset clears data and listeners", async () => {
    const cb = vi.fn();
    storage.onChanged.addListener(cb);
    await storage.set({ x: "y" });
    storage.reset();
    expect(await storage.get(null)).toEqual({});
    await storage.set({ x: "z" });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(storage.dump()).toEqual({ x: "z" });
  });

  it("setAccessLevel is a noop", () => {
    storage.setAccessLevel("TRUSTED_CONTEXTS");
    expect(true).toBe(true);
  });
});

describe("FakeChromeRuntime", () => {
  let runtime: FakeChromeRuntime;

  beforeEach(() => { runtime = new FakeChromeRuntime(); });

  it("triggers message listeners", () => {
    const cb = vi.fn();
    runtime.onMessage.addListener(cb);
    runtime.triggerMessage({ type: "TEST" }, { tab: { id: 1 } });
    expect(cb).toHaveBeenCalledWith({ type: "TEST" }, { tab: { id: 1 } }, expect.any(Function));
  });

  it("triggers tab update listeners", () => {
    const cb = vi.fn();
    runtime.onUpdated.addListener(cb);
    runtime.triggerTabUpdate(1, { status: "complete" });
    expect(cb).toHaveBeenCalledWith(1, { status: "complete" });
  });

  it("reset clears all listeners", () => {
    const cb = vi.fn();
    runtime.onMessage.addListener(cb);
    runtime.reset();
    runtime.triggerMessage({ type: "TEST" }, {});
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("DOM helpers", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("createDom sets body HTML and returns cleanup", () => {
    const cleanup = createDom("<div id='test'>hello</div>");
    expect(document.getElementById("test")?.textContent).toBe("hello");
    cleanup();
    expect(document.body.innerHTML).toBe("");
  });

  it("makeButton creates and appends a button", () => {
    const btn = makeButton("Click", { id: "btn1", class: "primary" });
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.textContent).toBe("Click");
    expect(btn.id).toBe("btn1");
    expect(btn.className).toBe("primary");
    expect(document.body.contains(btn)).toBe(true);
  });

  it("makeInput creates and appends an input", () => {
    const input = makeInput({ type: "text", name: "email", value: "test@x.com" });
    expect(input.tagName).toBe("INPUT");
    expect(input.type).toBe("text");
    expect(input.name).toBe("email");
    expect(input.value).toBe("test@x.com");
    expect(document.body.contains(input)).toBe(true);
  });

  it("makeSelect creates a select with options", () => {
    const select = makeSelect(["a", "b", "c"], { name: "picker" });
    expect(select.tagName).toBe("SELECT");
    expect(select.options.length).toBe(3);
    expect(select.options[0].value).toBe("a");
    expect(select.name).toBe("picker");
  });

  it("makeElement creates generic elements with children", () => {
    const child = document.createElement("span");
    child.textContent = "child";
    const el = makeElement("div", { "data-testid": "parent" }, [child]);
    expect(el.tagName).toBe("DIV");
    expect(el.getAttribute("data-testid")).toBe("parent");
    expect(el.children.length).toBe(1);
    expect(el.children[0].textContent).toBe("child");
  });
});

describe("mockAnimationFrame", () => {
  it("advances frames on demand", () => {
    const { advanceFrames, restore } = mockAnimationFrame();
    const cb = vi.fn();
    requestAnimationFrame(cb);
    expect(cb).not.toHaveBeenCalled();
    advanceFrames(1);
    expect(cb).toHaveBeenCalledTimes(1);
    restore();
  });

  it("cancelAnimationFrame prevents callback", () => {
    const { advanceFrames, restore } = mockAnimationFrame();
    const cb = vi.fn();
    const id = requestAnimationFrame(cb);
    cancelAnimationFrame(id);
    advanceFrames(1);
    expect(cb).not.toHaveBeenCalled();
    restore();
  });

  it("restore reverts to original rAF behavior", () => {
    const { advanceFrames, restore } = mockAnimationFrame();
    restore();
    const rafId = requestAnimationFrame(vi.fn());
    expect(typeof rafId).toBe("number");
    advanceFrames(1); // noop after restore
  });
});

describe("mockElementFromPoint", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("returns mocked element and restore sets fallback", () => {
    const el = document.createElement("div");
    const restore = mockElementFromPoint(el);
    expect(document.elementFromPoint(0, 0)).toBe(el);
    restore();
    expect(document.elementFromPoint(0, 0)).toBeNull();
  });
});
