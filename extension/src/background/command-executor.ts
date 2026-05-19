import { createLogger } from "../shared/logger";
import type { AgentCommand, PageContext, PageDiff } from "../shared/types";
import type {
  CapturePageContextMessage,
  ExecuteAgentCommandMessage,
  PageContextResponse,
  AgentCommandResultResponse,
} from "../shared/messaging";

const log = createLogger("command-executor");

interface HarnessOutput {
  ok: boolean;
  value?: unknown;
  logs: string[];
  durationMs: number;
  error?: string;
}

/**
 * Injected into the page's MAIN world via chrome.scripting.executeScript.
 * Must be a top-level statically-analyzable function (no closure capture).
 *
 * Receives (sourceText, args, timeoutMs) and:
 * - constructs an async function from the source with `args` bound
 * - races the user code against a hard timeout
 * - captures console.* output (max 10 entries, 200 chars each)
 * - JSON-roundtrips the return value, replacing non-serializable values
 *   with {"__nonserializable__": "<typename>"} sentinels
 *
 * Returns a JSON-serializable HarnessOutput. Errors do not throw — they
 * surface as {ok: false, error: "..."}.
 */
function RUN_SCRIPT_HARNESS(
  source: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<HarnessOutput> {
  const startedAt = Date.now();
  const logs: string[] = [];
  const origConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const capture = (level: string) => (...parts: unknown[]) => {
    if (logs.length < 10) {
      try {
        logs.push(`[${level}] ${parts.map((p) => {
          try { return typeof p === "string" ? p : JSON.stringify(p); }
          catch { return String(p); }
        }).join(" ")}`.slice(0, 200));
      } catch { /* never let logging break the script */ }
    }
  };
  console.log = capture("log");
  console.info = capture("info");
  console.warn = capture("warn");
  console.error = capture("error");

  const sanitize = (v: unknown, seen: WeakSet<object>): unknown => {
    if (v === null) return null;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") return v;
    if (t === "undefined") return null;
    if (t === "bigint") return String(v);
    if (t === "function" || t === "symbol") {
      return { __nonserializable__: t };
    }
    if (typeof v === "object") {
      // DOM nodes and other host objects
      if (typeof (v as any).nodeType === "number" && typeof (v as any).nodeName === "string") {
        return { __nonserializable__: (v as any).nodeName };
      }
      if (seen.has(v as object)) return { __nonserializable__: "circular" };
      seen.add(v as object);
      if (Array.isArray(v)) {
        return (v as unknown[]).map((item) => sanitize(item, seen));
      }
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>)) {
        try {
          out[k] = sanitize((v as Record<string, unknown>)[k], seen);
        } catch {
          out[k] = { __nonserializable__: "throws" };
        }
      }
      return out;
    }
    return { __nonserializable__: String(t) };
  };

  return new Promise<HarnessOutput>((resolve) => {
    let settled = false;
    const finish = (out: HarnessOutput) => {
      if (settled) return;
      settled = true;
      console.log = origConsole.log;
      console.info = origConsole.info;
      console.warn = origConsole.warn;
      console.error = origConsole.error;
      resolve(out);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: "SCRIPT_TIMEOUT",
        logs,
        durationMs: Date.now() - startedAt,
      });
    }, timeoutMs);
    try {
      // Build an async function from the user source with `args` bound.
      // `return` inside source returns the value to us; expressions without
      // `return` resolve to undefined (sanitized to null).
      const userFn = new Function("args", `"use strict"; return (async () => { ${source} })();`);
      Promise.resolve(userFn(args)).then(
        (value) => {
          clearTimeout(timer);
          try {
            finish({
              ok: true,
              value: sanitize(value, new WeakSet()),
              logs,
              durationMs: Date.now() - startedAt,
            });
          } catch (e) {
            finish({
              ok: false,
              error: `SCRIPT_RESULT_SERIALIZATION_FAILED: ${(e as Error).message}`,
              logs,
              durationMs: Date.now() - startedAt,
            });
          }
        },
        (err: unknown) => {
          clearTimeout(timer);
          const msg = err instanceof Error
            ? `${err.name}: ${err.message}`
            : String(err);
          finish({
            ok: false,
            error: `SCRIPT_THREW: ${msg}`.slice(0, 500),
            logs,
            durationMs: Date.now() - startedAt,
          });
        },
      );
    } catch (e) {
      clearTimeout(timer);
      finish({
        ok: false,
        error: `SCRIPT_PARSE_ERROR: ${(e as Error).message}`,
        logs,
        durationMs: Date.now() - startedAt,
      });
    }
  });
}

// Phase 2: per-tab cache of the last PageContext so the next capture can
// emit a delta. Cleared automatically when the tab is closed.
const prevContextByTab = new Map<number, PageContext>();

function elementKey(e: PageContext["visible_elements"][number]): string {
  return `${e.tag}|${e.role ?? ""}|${(e.text || "").slice(0, 40)}|${e.aria_label ?? ""}`;
}

function shortDescriptor(e: PageContext["visible_elements"][number]): {
  tag: string; role?: string; text: string;
} {
  return {
    tag: e.tag,
    role: e.role,
    text: (e.text || e.aria_label || "").slice(0, 80),
  };
}

function computeDiff(prev: PageContext, next: PageContext): PageDiff {
  const prevKeys = new Map(prev.visible_elements.map((e) => [elementKey(e), e]));
  const nextKeys = new Map(next.visible_elements.map((e) => [elementKey(e), e]));
  const added: PageDiff["added"] = [];
  const removed: PageDiff["removed"] = [];
  for (const [k, e] of nextKeys) {
    if (!prevKeys.has(k)) added.push(shortDescriptor(e));
  }
  for (const [k, e] of prevKeys) {
    if (!nextKeys.has(k)) removed.push(shortDescriptor(e));
  }
  return {
    url_changed: prev.url !== next.url,
    previous_url: prev.url !== next.url ? prev.url : undefined,
    title_changed: prev.title !== next.title,
    previous_title: prev.title !== next.title ? prev.title : undefined,
    added: added.slice(0, 15),
    removed: removed.slice(0, 15),
  };
}

export class CommandExecutor {
  async captureContext(tabId: number): Promise<PageContext> {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "CAPTURE_PAGE_CONTEXT",
      } as CapturePageContextMessage);
      const result = response as PageContextResponse;
      const ctx: PageContext = {
        url: result.url,
        title: result.title,
        dom_snippet: result.dom_snippet,
        accessibility_tree: result.accessibility_tree,
        visible_text: result.visible_text,
        visible_elements: result.visible_elements as PageContext["visible_elements"],
        is_blocking: result.is_blocking,
        blocking_type: result.blocking_type,
        page_unchanged: false,
        page_diff: null,
      };

      const prev = prevContextByTab.get(tabId);
      if (prev) {
        ctx.page_diff = computeDiff(prev, ctx);
        if (
          !ctx.page_diff.url_changed
          && !ctx.page_diff.title_changed
          && ctx.page_diff.added.length === 0
          && ctx.page_diff.removed.length === 0
        ) {
          ctx.page_unchanged = true;
        }
      }
      prevContextByTab.set(tabId, ctx);

      return ctx;
    } catch (err) {
      log.error("captureContext failed:", err);
      return {
        url: "",
        title: "",
        dom_snippet: "",
        accessibility_tree: "",
        visible_text: "",
        visible_elements: [],
        is_blocking: false,
        blocking_type: null,
        page_unchanged: false,
        page_diff: null,
      };
    }
  }

  /** Clear the cached PageContext for a tab. Call when a run completes or
   *  starts so a fresh run's first poll isn't compared against stale state. */
  clearTabCache(tabId: number): void {
    prevContextByTab.delete(tabId);
  }

  /** Capture the visible viewport as a downscaled JPEG. Returns null on failure
   *  so the caller can fall back to a no-image poll without breaking the loop.
   *  Output: base64 string (no data: prefix), MIME, dimensions, byte size. */
  async captureScreenshot(tabId: number): Promise<{
    b64: string;
    mime: string;
    width: number;
    height: number;
    byte_size: number;
  } | null> {
    try {
      const tab = await chrome.tabs.get(tabId);
      const windowId = tab.windowId;
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: "jpeg",
        quality: 70,
      });
      if (!dataUrl) return null;

      // Decode the data URL into an ImageBitmap so we can downscale via OffscreenCanvas.
      const fetched = await fetch(dataUrl);
      const blob = await fetched.blob();
      const bitmap = await createImageBitmap(blob);

      const MAX_DIM = 1280;
      const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = new OffscreenCanvas(width, height);
      const cctx = canvas.getContext("2d");
      if (!cctx) {
        bitmap.close();
        return null;
      }
      cctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();

      const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
      const buf = await outBlob.arrayBuffer();
      const bytes = new Uint8Array(buf);

      // Encode bytes -> base64 without using btoa(String.fromCharCode(...)) which
      // can blow the call stack on large arrays. Chunk through fromCharCode then
      // base64-encode.
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(
          null,
          Array.from(bytes.subarray(i, i + CHUNK)),
        );
      }
      const b64 = btoa(binary);

      return {
        b64,
        mime: "image/jpeg",
        width,
        height,
        byte_size: bytes.length,
      };
    } catch (err) {
      log.error("captureScreenshot failed:", err);
      return null;
    }
  }

  /**
   * Workstream A: god-mode JavaScript primitive. Executes an AI-supplied
   * function body in the page's MAIN world (so it can reach page globals),
   * with captured console.* output and a per-call timeout. Bytes returned
   * by the page must be JSON-serializable — non-serializable values
   * (DOM nodes, functions, circular refs) are replaced with sentinel objects.
   */
  async runScript(
    tabId: number,
    command: AgentCommand,
  ): Promise<{
    success: boolean;
    error?: string;
    script_result?: unknown;
    script_logs?: string[];
    script_duration_ms?: number;
  }> {
    const source = command.script;
    if (!source || typeof source !== "string") {
      return { success: false, error: "run_script: missing 'script' source" };
    }
    const userTimeout = Math.min(
      Math.max(command.script_timeout_ms ?? 5000, 100),
      15_000,
    );
    const args = command.script_args ?? {};

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: RUN_SCRIPT_HARNESS,
        args: [source, args as Record<string, unknown>, userTimeout],
      });
      const out = results?.[0]?.result as HarnessOutput | undefined;
      if (!out) {
        return { success: false, error: "run_script: no result returned" };
      }
      return {
        success: out.ok,
        error: out.error,
        script_result: out.value,
        script_logs: out.logs,
        script_duration_ms: out.durationMs,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("runScript failed:", msg);
      return { success: false, error: `run_script injection failed: ${msg}` };
    }
  }

  async executeCommand(
    tabId: number,
    command: AgentCommand,
  ): Promise<{
    success: boolean;
    error?: string;
    via_method_index?: number;
    script_result?: unknown;
    script_logs?: string[];
    script_duration_ms?: number;
  }> {
    // Workstream A: run_script bypasses the content-script messaging path
    // — chrome.scripting.executeScript is a service-worker-only API.
    if (command.action === "run_script") {
      return await this.runScript(tabId, command);
    }
    const timeoutMs = command.timeout_ms || 15000;

    // Retry up to 3 times when the content script is temporarily unavailable
    // (tab still loading after a navigation).  Hard errors (Command timed out,
    // ELEMENT_NOT_FOUND, etc.) are returned immediately without retrying.
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        // Backoff, then wait for the tab to finish loading before retrying
        await new Promise((r) => setTimeout(r, 600 * attempt));
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.status === "loading") {
            await new Promise<void>((resolve) => {
              const timeout = setTimeout(resolve, 8_000);
              const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
                if (id === tabId && info.status === "complete") {
                  clearTimeout(timeout);
                  chrome.tabs.onUpdated.removeListener(listener);
                  resolve();
                }
              };
              chrome.tabs.onUpdated.addListener(listener);
            });
            await new Promise((r) => setTimeout(r, 400)); // content-script settle
          }
        } catch { /* tab gone */ }
      }

      try {
        const response = await Promise.race([
          chrome.tabs.sendMessage(tabId, {
            type: "EXECUTE_AGENT_COMMAND",
            command,
          } as ExecuteAgentCommandMessage),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Command timed out")), timeoutMs)
          ),
        ]);
        const result = response as AgentCommandResultResponse;
        return {
          success: result.success,
          error: result.error,
          via_method_index: result.via_method_index,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        const isConnectivity =
          lastError.includes("Could not establish connection") ||
          lastError.includes("Receiving end does not exist");
        if (!isConnectivity || attempt === 2) {
          // Non-connectivity error or exhausted retries — give up
          log.error(`executeCommand ${command.action} failed (attempt ${attempt + 1}):`, lastError);
          return { success: false, error: lastError };
        }
        log.log(`executeCommand connectivity retry ${attempt + 1}: ${lastError}`);
      }
    }
    return { success: false, error: lastError };
  }
}

export const commandExecutor = new CommandExecutor();
