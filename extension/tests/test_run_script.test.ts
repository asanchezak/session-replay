import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentCommand } from "../src/shared/types";

// The CommandExecutor.runScript path calls chrome.scripting.executeScript
// directly — no content-script messaging. We stub the scripting API and
// simulate the harness running by invoking the supplied `func` with `args`
// from inside this test process. That exercises the wiring (param
// construction, result shape, error handling) without spinning up a browser.
const executeScript = vi.fn<(opts: any) => Promise<chrome.scripting.InjectionResult[]>>();
const tabsGet = vi.fn<(tabId: number) => Promise<chrome.tabs.Tab>>();
const tabsUpdate = vi.fn<() => Promise<chrome.tabs.Tab>>();
const debuggerAttach = vi.fn<() => Promise<void>>();
const debuggerSendCommand = vi.fn<() => Promise<void>>();
const debuggerDetach = vi.fn<() => Promise<void>>();

globalThis.chrome = {
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  tabs: { query: vi.fn(), sendMessage: vi.fn(), get: tabsGet, update: tabsUpdate },
  scripting: { executeScript } as any,
  debugger: {
    attach: debuggerAttach,
    sendCommand: debuggerSendCommand,
    detach: debuggerDetach,
    onDetach: { addListener: vi.fn() },
  },
  storage: { session: { get: vi.fn(), set: vi.fn() } },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
} as any;

// Helper: simulate the harness by invoking the passed func with passed args
// inside this test process. This is what the page would do at runtime.
function simulateExecute(): void {
  executeScript.mockImplementation(async (opts: any) => {
    const out = await opts.func(...opts.args);
    return [{ result: out, frameId: 0 } as chrome.scripting.InjectionResult];
  });
}

describe("CommandExecutor.runScript", () => {
  beforeEach(() => {
    executeScript.mockReset();
    tabsGet.mockReset();
    tabsUpdate.mockReset();
    debuggerAttach.mockReset();
    debuggerSendCommand.mockReset();
    debuggerDetach.mockReset();
    tabsGet.mockResolvedValue({ id: 1, windowId: 42 } as chrome.tabs.Tab);
    tabsUpdate.mockResolvedValue({ id: 1, url: "https://www.linkedin.com/feed/" } as chrome.tabs.Tab);
    debuggerAttach.mockResolvedValue(undefined);
    debuggerSendCommand.mockResolvedValue(undefined);
    debuggerDetach.mockResolvedValue(undefined);
    document.body.innerHTML = "";
  });

  it("rejects commands with no script source", async () => {
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();
    const result = await ce.runScript(1, {
      action: "run_script",
      target: null, value: null, selector_chain: [], intent: null,
      methods: [], timeout_ms: 5000, success_condition: null,
    } as AgentCommand);
    expect(result.success).toBe(false);
    expect(result.error).toContain("missing 'script' source");
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("returns the script's value on success", async () => {
    simulateExecute();
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();
    const result = await ce.runScript(1, {
      action: "run_script",
      script: "return args.x + args.y;",
      script_args: { x: 2, y: 3 },
      script_timeout_ms: 5000,
      target: null, value: null, selector_chain: [], intent: null,
      methods: [], timeout_ms: 5000, success_condition: null,
    } as AgentCommand);
    expect(result.success).toBe(true);
    expect(result.script_result).toBe(5);
    expect(typeof result.script_duration_ms).toBe("number");
  });

  it("captures console.log into script_logs", async () => {
    simulateExecute();
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();
    const result = await ce.runScript(1, {
      action: "run_script",
      script: "console.log('hello world'); return 1;",
      script_args: {},
      script_timeout_ms: 5000,
      target: null, value: null, selector_chain: [], intent: null,
      methods: [], timeout_ms: 5000, success_condition: null,
    } as AgentCommand);
    expect(result.success).toBe(true);
    expect(result.script_logs?.some((l) => l.includes("hello world"))).toBe(true);
  });

  it("returns SCRIPT_TIMEOUT when the script exceeds its budget", async () => {
    simulateExecute();
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();
    const result = await ce.runScript(1, {
      action: "run_script",
      script: "await new Promise(r => setTimeout(r, 5000)); return 'late';",
      script_args: {},
      script_timeout_ms: 100,
      target: null, value: null, selector_chain: [], intent: null,
      methods: [], timeout_ms: 5000, success_condition: null,
    } as AgentCommand);
    expect(result.success).toBe(false);
    expect(result.error).toBe("SCRIPT_TIMEOUT");
  });

  it("surfaces thrown errors as SCRIPT_THREW without crashing", async () => {
    simulateExecute();
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();
    const result = await ce.runScript(1, {
      action: "run_script",
      script: "throw new Error('boom');",
      script_args: {},
      script_timeout_ms: 5000,
      target: null, value: null, selector_chain: [], intent: null,
      methods: [], timeout_ms: 5000, success_condition: null,
    } as AgentCommand);
    expect(result.success).toBe(false);
    expect(result.error).toContain("SCRIPT_THREW");
    expect(result.error).toContain("boom");
  });

  it("sanitizes non-serializable return values", async () => {
    simulateExecute();
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();
    const result = await ce.runScript(1, {
      action: "run_script",
      script: "return { fn: () => 1, x: 42 };",
      script_args: {},
      script_timeout_ms: 5000,
      target: null, value: null, selector_chain: [], intent: null,
      methods: [], timeout_ms: 5000, success_condition: null,
    } as AgentCommand);
    expect(result.success).toBe(true);
    expect((result.script_result as any).x).toBe(42);
    expect((result.script_result as any).fn).toEqual({ __nonserializable__: "function" });
  });

  it("clamps script_timeout_ms to the 15s hard cap", async () => {
    let observedTimeout = 0;
    executeScript.mockImplementation(async (opts: any) => {
      observedTimeout = opts.args[2];
      // Return synchronously without invoking the harness so the timeout
      // bound is what matters.
      return [{ result: { ok: true, value: null, logs: [], durationMs: 1 }, frameId: 0 }];
    });
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();
    await ce.runScript(1, {
      action: "run_script",
      script: "return 1;",
      script_args: {},
      script_timeout_ms: 999_999,
      target: null, value: null, selector_chain: [], intent: null,
      methods: [], timeout_ms: 5000, success_condition: null,
    } as AgentCommand);
    expect(observedTimeout).toBe(15_000);
  });

  it("routes run_script through executeCommand without content-script messaging", async () => {
    simulateExecute();
    const tabsSendMessage = vi.fn();
    (chrome.tabs as any).sendMessage = tabsSendMessage;
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();
    const result = await ce.executeCommand(1, {
      action: "run_script",
      script: "return 'ok';",
      script_args: {},
      script_timeout_ms: 5000,
      target: null, value: null, selector_chain: [], intent: null,
      methods: [], timeout_ms: 5000, success_condition: null,
    } as AgentCommand);
    expect(result.success).toBe(true);
    expect(result.script_result).toBe("ok");
    // Must NOT have dispatched a content-script message — runScript is the
    // service-worker-only path.
    expect(tabsSendMessage).not.toHaveBeenCalled();
  });

  it("enforces success_condition after run_script (pass)", async () => {
    simulateExecute();
    document.body.innerText = "Message sent successfully";
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();
    const result = await ce.executeCommand(1, {
      action: "run_script",
      script: "return 'ok';",
      script_args: {},
      script_timeout_ms: 5000,
      target: null, value: null, selector_chain: [], intent: null,
      methods: [], timeout_ms: 5000,
      success_condition: { type: "visible_text_contains", value: "sent successfully" },
    } as AgentCommand);
    expect(result.success).toBe(true);
  });

  it("enforces success_condition after run_script (fail)", async () => {
    simulateExecute();
    document.body.innerText = "No delivery marker here";
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();
    const result = await ce.executeCommand(1, {
      action: "run_script",
      script: "return 'ok';",
      script_args: {},
      script_timeout_ms: 5000,
      target: null, value: null, selector_chain: [], intent: null,
      methods: [], timeout_ms: 5000,
      success_condition: { type: "visible_text_contains", value: "sent successfully" },
    } as AgentCommand);
    expect(result.success).toBe(false);
    expect(result.error).toContain("SUCCESS_CONDITION_FAILED");
  });

  it("enforces visible_text_contains through open shadow roots", async () => {
    simulateExecute();
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const message = document.createElement("div");
    message.textContent = "Shadow message delivered";
    shadow.appendChild(message);
    document.body.appendChild(host);

    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();
    const result = await ce.executeCommand(1, {
      action: "run_script",
      script: "return 'ok';",
      script_args: {},
      script_timeout_ms: 5000,
      target: null, value: null, selector_chain: [], intent: null,
      methods: [], timeout_ms: 5000,
      success_condition: { type: "visible_text_contains", value: "Shadow message delivered" },
    } as AgentCommand);

    expect(result.success).toBe(true);
  });

  it("js_click harness prefers submit button over anchor for Send", async () => {
    simulateExecute();
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();

    const anchor = document.createElement("a");
    anchor.href = "https://www.linkedin.com/notifications/";
    anchor.textContent = "Send";
    (anchor as HTMLElement).getBoundingClientRect = () => ({
      width: 80, height: 20, top: 10, left: 10, right: 90, bottom: 30, x: 10, y: 10, toJSON: () => "",
    } as DOMRect);

    const button = document.createElement("button");
    button.type = "submit";
    button.className = "msg-form__send-button";
    button.textContent = "Send";
    (button as HTMLElement).getBoundingClientRect = () => ({
      width: 80, height: 20, top: 40, left: 10, right: 90, bottom: 60, x: 10, y: 40, toJSON: () => "",
    } as DOMRect);

    document.body.appendChild(anchor);
    document.body.appendChild(button);

    const result = await ce.executeCommand(1, {
      action: "run_script",
      script: "return null;",
      script_args: {
        __harness: "js_click",
        label: "Send",
        selectorCandidates: ["Send"],
        textCandidates: ["Send"],
        shadowSelectors: [],
      },
      script_timeout_ms: 5000,
      target: null,
      value: null,
      selector_chain: [],
      intent: null,
      methods: [],
      timeout_ms: 5000,
      success_condition: null,
    } as AgentCommand);

    expect(result.success).toBe(true);
    const scriptResult = (result.script_result ?? {}) as Record<string, unknown>;
    expect(scriptResult.tag).toBe("BUTTON");
  });

  it("js_click harness does not fall back to global Send when shadow root is missing", async () => {
    simulateExecute();
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();

    const anchor = document.createElement("a");
    anchor.href = "https://www.linkedin.com/notifications/";
    anchor.textContent = "Send";
    (anchor as HTMLElement).getBoundingClientRect = () => ({
      width: 100, height: 20, top: 12, left: 10, right: 110, bottom: 32, x: 10, y: 12, toJSON: () => "",
    } as DOMRect);
    document.body.appendChild(anchor);

    const result = await ce.executeCommand(1, {
      action: "run_script",
      script: "return null;",
      script_args: {
        __harness: "js_click",
        label: "Send",
        selectorCandidates: ["Send"],
        textCandidates: ["Send"],
        shadowSelectors: [
          {
            hostChain: ["div[data-testid=\"interop-shadowdom\"]"],
            target: "button.msg-form__send-button",
          },
        ],
      },
      script_timeout_ms: 5000,
      target: null,
      value: null,
      selector_chain: [],
      intent: null,
      methods: [],
      timeout_ms: 5000,
      success_condition: null,
    } as AgentCommand);

    expect(result.success).toBe(false);
    expect(result.error || "").toContain("JS_CLICK_FALLBACK_NO_TARGET");
  }, 12000);

  it("site adapter opens the messaging dock through a scoped LinkedIn operation", async () => {
    simulateExecute();
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();

    const host = document.createElement("div");
    host.setAttribute("data-testid", "interop-shadowdom");
    const shadow = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.id = "msg-overlay-list-bubble-header__button";
    button.textContent = "Messaging";
    button.getBoundingClientRect = () => ({
      width: 90, height: 24, top: 400, left: 600, right: 690, bottom: 424, x: 600, y: 400, toJSON: () => "",
    } as DOMRect);
    shadow.appendChild(button);
    document.body.appendChild(host);

    const result = await ce.executeCommand(1, {
      action: "run_script",
      script: "site_adapter:linkedin",
      script_args: {
        __harness: "site:linkedin",
        operation: "open_messaging_dock",
        scope: "global_nav",
      },
      script_timeout_ms: 5000,
      target: null,
      value: null,
      selector_chain: [],
      intent: null,
      methods: [],
      timeout_ms: 5000,
      success_condition: null,
    } as AgentCommand);

    expect(result.success).toBe(true);
    expect(debuggerSendCommand).toHaveBeenCalledWith({ tabId: 1 }, "Input.dispatchMouseEvent", expect.objectContaining({
      type: "mousePressed",
      x: 645,
      y: 412,
    }));
    expect((result.script_result as any).operation).toBe("open_messaging_dock");
  });

  it("site adapter resolves LinkedIn global nav clicks by href semantics", async () => {
    simulateExecute();
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();

    const header = document.createElement("header");
    const nav = document.createElement("nav");
    const home = document.createElement("a");
    home.href = "https://www.linkedin.com/feed/";
    home.setAttribute("aria-label", "");
    const homeIcon = document.createElement("span");
    homeIcon.setAttribute("aria-hidden", "true");
    home.appendChild(homeIcon);
    home.getBoundingClientRect = () => ({
      width: 0, height: 0, top: 8, left: 16, right: 16, bottom: 8, x: 16, y: 8, toJSON: () => "",
    } as DOMRect);
    homeIcon.getBoundingClientRect = () => ({
      width: 48, height: 48, top: 8, left: 16, right: 64, bottom: 56, x: 16, y: 8, toJSON: () => "",
    } as DOMRect);
    nav.appendChild(home);
    header.appendChild(nav);
    document.body.appendChild(header);

    const result = await ce.executeCommand(1, {
      action: "run_script",
      script: "site_adapter:linkedin",
      script_args: {
        __harness: "site:linkedin",
        operation: "click",
        scope: "global_nav",
        label: "Home",
      },
      script_timeout_ms: 5000,
      target: null,
      value: null,
      selector_chain: [],
      intent: null,
      methods: [],
      timeout_ms: 5000,
      success_condition: null,
    } as AgentCommand);

    expect(result.success).toBe(true);
    expect(debuggerSendCommand).toHaveBeenCalledWith({ tabId: 1 }, "Input.dispatchMouseEvent", expect.objectContaining({
      type: "mousePressed",
      x: 40,
      y: 32,
    }));
    expect((result.script_result as any).reason).toBe("linkedin_scoped_click");
  });

  it("site adapter falls back to canonical route navigation for known global nav labels", async () => {
    simulateExecute();
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();

    const result = await ce.executeCommand(1, {
      action: "run_script",
      script: "site_adapter:linkedin",
      script_args: {
        __harness: "site:linkedin",
        operation: "click",
        scope: "global_nav",
        label: "Home",
      },
      script_timeout_ms: 5000,
      target: null,
      value: null,
      selector_chain: [],
      intent: null,
      methods: [],
      timeout_ms: 5000,
      success_condition: null,
    } as AgentCommand);

    expect(result.success).toBe(true);
    expect(tabsUpdate).toHaveBeenCalledWith(1, { url: "http://localhost:3000/feed/" });
    expect(debuggerSendCommand).not.toHaveBeenCalled();
    expect((result.script_result as any).action).toBe("navigate");
  });

  it("site adapter opens the full LinkedIn messaging page when the dock root is absent", async () => {
    simulateExecute();
    tabsUpdate.mockResolvedValueOnce({ id: 1, url: "http://localhost:3000/messaging/" } as chrome.tabs.Tab);
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();

    const result = await ce.executeCommand(1, {
      action: "run_script",
      script: "site_adapter:linkedin",
      script_args: {
        __harness: "site:linkedin",
        operation: "open_messaging_dock",
        scope: "global_nav",
      },
      script_timeout_ms: 5000,
      target: null,
      value: null,
      selector_chain: [],
      intent: null,
      methods: [],
      timeout_ms: 5000,
      success_condition: null,
    } as AgentCommand);

    expect(result.success).toBe(true);
    expect(tabsUpdate).toHaveBeenCalledWith(1, { url: "http://localhost:3000/messaging/" });
    expect((result.script_result as any).reason).toBe("linkedin_open_messaging_page");
  });

  it("site adapter types into the messaging composer with trusted text", async () => {
    simulateExecute();
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();

    const host = document.createElement("div");
    host.setAttribute("data-testid", "interop-shadowdom");
    const shadow = host.attachShadow({ mode: "open" });
    const composer = document.createElement("div");
    composer.setAttribute("role", "textbox");
    composer.setAttribute("aria-label", "Write a message...");
    composer.setAttribute("contenteditable", "true");
    composer.getBoundingClientRect = () => ({
      width: 300, height: 40, top: 500, left: 400, right: 700, bottom: 540, x: 400, y: 500, toJSON: () => "",
    } as DOMRect);
    shadow.appendChild(composer);
    document.body.appendChild(host);

    const result = await ce.executeCommand(1, {
      action: "run_script",
      script: "site_adapter:linkedin",
      script_args: {
        __harness: "site:linkedin",
        operation: "type_message",
        scope: "messaging_dock",
        text: "hello from test",
      },
      script_timeout_ms: 5000,
      target: null,
      value: null,
      selector_chain: [],
      intent: null,
      methods: [],
      timeout_ms: 5000,
      success_condition: null,
    } as AgentCommand);

    expect(result.success).toBe(true);
    expect(debuggerSendCommand).toHaveBeenCalledWith({ tabId: 1 }, "Input.insertText", { text: "hello from test" });
    expect((result.script_result as any).operation).toBe("type_message");
  });

  it("site adapter opens the messaging dock before retrying a dock-scoped operation", async () => {
    executeScript
      .mockResolvedValueOnce([{ result: { ok: false, operation: "open_conversation", error: "LINKEDIN_SITE_NO_MESSAGING_ROOT" }, frameId: 0 } as chrome.scripting.InjectionResult])
      .mockResolvedValueOnce([{ result: {
        ok: true,
        operation: "open_messaging_dock",
        action: "click",
        x: 100,
        y: 200,
        width: 80,
        height: 40,
        tag: "BUTTON",
        text: "Messaging",
        reason: "linkedin_open_messaging_dock",
        settleMs: 10,
      }, frameId: 0 } as chrome.scripting.InjectionResult])
      .mockResolvedValueOnce([{ result: {
        ok: true,
        operation: "open_conversation",
        action: "click",
        x: 300,
        y: 400,
        width: 240,
        height: 56,
        tag: "LI",
        text: "Franz Sivaja Sánchez",
        reason: "linkedin_open_conversation",
        settleMs: 10,
      }, frameId: 0 } as chrome.scripting.InjectionResult]);

    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();
    const result = await ce.executeCommand(1, {
      action: "run_script",
      script: "site_adapter:linkedin",
      script_args: {
        __harness: "site:linkedin",
        operation: "open_conversation",
        scope: "messaging_dock",
        name: "Franz Sivaja Sánchez",
      },
      script_timeout_ms: 5000,
      target: null,
      value: null,
      selector_chain: [],
      intent: null,
      methods: [],
      timeout_ms: 5000,
      success_condition: null,
    } as AgentCommand);

    expect(result.success).toBe(true);
    expect(executeScript).toHaveBeenCalledTimes(3);
    expect(debuggerSendCommand).toHaveBeenCalledWith({ tabId: 1 }, "Input.dispatchMouseEvent", expect.objectContaining({
      type: "mousePressed",
      x: 100,
      y: 200,
    }));
    expect(debuggerSendCommand).toHaveBeenCalledWith({ tabId: 1 }, "Input.dispatchMouseEvent", expect.objectContaining({
      type: "mousePressed",
      x: 300,
      y: 400,
    }));
    expect((result.script_result as any).operation).toBe("open_conversation");
  });
});
