import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentCommand } from "../src/shared/types";

// The CommandExecutor.runScript path calls chrome.scripting.executeScript
// directly — no content-script messaging. We stub the scripting API and
// simulate the harness running by invoking the supplied `func` with `args`
// from inside this test process. That exercises the wiring (param
// construction, result shape, error handling) without spinning up a browser.
const executeScript = vi.fn<(opts: any) => Promise<chrome.scripting.InjectionResult[]>>();
const tabsGet = vi.fn<(tabId: number) => Promise<chrome.tabs.Tab>>();

globalThis.chrome = {
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  tabs: { query: vi.fn(), sendMessage: vi.fn(), get: tabsGet },
  scripting: { executeScript } as any,
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
    tabsGet.mockResolvedValue({ id: 1, windowId: 42 } as chrome.tabs.Tab);
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
});
