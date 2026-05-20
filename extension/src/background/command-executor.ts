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

/**
 * Pre-compiled click-fallback harness — runs via executeScript({func:...}) so
 * Chrome injects it via extension privilege (bypassing page CSP entirely).
 * Contains NO new Function() / eval, so it is MV3-safe in both MAIN and
 * ISOLATED worlds.  This is the CSP-safe replacement for the run_script path
 * when script_args.__harness === "js_click".
 *
 * Receives the full script_args object and returns a click-result or throws
 * JS_CLICK_FALLBACK_NO_TARGET:<label>.
 */
function JS_CLICK_HARNESS(
  args: Record<string, unknown>,
): { clicked: boolean; reason: string; tag: string; text: string; score?: number; originTag?: string | null } {
  const label = String((args && args.label) || "").trim();
  const labelLower = label.toLowerCase();
  const selectors: string[] = Array.isArray(args?.selectorCandidates)
    ? (args.selectorCandidates as unknown[]).map((s) => String(s))
    : [];
  const textCandidates: string[] = Array.isArray(args?.textCandidates)
    ? (args.textCandidates as unknown[]).map((t) => String(t).trim()).filter(Boolean)
    : [];
  if (label) textCandidates.unshift(label);

  const normalizeToken = (v: unknown) =>
    String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

  const isVisible = (el: Element | null): boolean => {
    if (!el || !(el instanceof Element)) return false;
    const s = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };

  const isDisabled = (el: Element | null): boolean => {
    if (!el || !(el instanceof Element)) return false;
    if (
      el instanceof HTMLButtonElement || el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
    ) return !!(el as HTMLButtonElement).disabled;
    return el.getAttribute("aria-disabled") === "true";
  };

  const textFor = (el: Element): string =>
    (
      (el.getAttribute("aria-label") || "") + " " +
      (el.getAttribute("title") || "") + " " +
      (el.getAttribute("data-testid") || "") + " " +
      ("value" in el ? String((el as HTMLInputElement).value || "") : "") + " " +
      (el.textContent || "")
    ).replace(/\s+/g, " ").trim();

  const seemsInteractive = (el: Element | null): boolean => {
    if (!el || !(el instanceof Element)) return false;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (el.matches("button,a,[role='button'],input[type='button'],input[type='submit'],input[type='radio'],input[type='checkbox'],summary,label")) return true;
    if (role === "button" || role === "link" || role === "tab" || role === "option") return true;
    if (el.hasAttribute("onclick") || el.hasAttribute("data-action")) return true;
    if (el.hasAttribute("tabindex") && Number(el.getAttribute("tabindex") || "0") >= 0) return true;
    const cls = `${el.className || ""} ${el.getAttribute("data-testid") || ""}`.toLowerCase();
    if (cls.includes("btn") || cls.includes("button") || cls.includes("click")) return true;
    try { if (window.getComputedStyle(el).cursor === "pointer") return true; } catch { /**/ }
    return false;
  };

  const bestActionableTarget = (node: Element | null): Element | null => {
    if (!node || !(node instanceof Element)) return null;
    let cur: Element | null = node;
    for (let d = 0; d < 8 && cur; d++) {
      if (isVisible(cur) && !isDisabled(cur) && seemsInteractive(cur)) return cur;
      cur = cur.parentElement;
    }
    cur = node;
    for (let d = 0; d < 8 && cur; d++) {
      if (isVisible(cur) && !isDisabled(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  };

  const matchesNeedle = (text: string, needle: string): boolean => {
    const hay = String(text || "").toLowerCase();
    const needleL = String(needle || "").toLowerCase().trim();
    if (!needleL || !hay) return false;
    if (hay.includes(needleL) || needleL.includes(hay)) return true;
    const hayN = normalizeToken(hay);
    const needleN = normalizeToken(needleL);
    if (!hayN || !needleN) return false;
    return hayN.includes(needleN) || needleN.includes(hayN);
  };

  const scoreEl = (el: Element): number => {
    if (!isVisible(el) || isDisabled(el)) return -1;
    const t = textFor(el);
    const tLower = t.toLowerCase();
    const tNorm = normalizeToken(tLower);
    const labelNorm = normalizeToken(labelLower);
    if (!textCandidates.some((needle) => matchesNeedle(t, needle))) return -1;
    let s = 0;
    if (labelLower && tLower === labelLower) s += 120;
    if (labelNorm && tNorm && tNorm === labelNorm) s += 120;
    if (labelLower && tLower.includes(labelLower)) s += 70;
    if (labelNorm && tNorm.includes(labelNorm)) s += 65;
    if (textCandidates.some((n) => {
      const nL = String(n || "").toLowerCase().trim();
      const nN = normalizeToken(nL);
      return (nL && tLower.includes(nL)) || (nN && tNorm.includes(nN));
    })) s += 35;
    if (seemsInteractive(el)) s += 12;
    if (bestActionableTarget(el)) s += 8;
    return s;
  };

  const clickNode = (
    el: Element | Node | null,
    reason: string,
  ): { clicked: boolean; reason: string; tag: string; text: string; originTag: string | null } | null => {
    if (!(el instanceof Element)) return null;
    const target = bestActionableTarget(el) || el;
    if (!isVisible(target) || isDisabled(target)) return null;
    try { target.scrollIntoView({ block: "center", inline: "center" }); } catch { /**/ }
    try { (target as HTMLElement).focus?.({ preventScroll: true }); } catch { /**/ }
    const ptrDown = { bubbles: true, cancelable: true, composed: true, pointerType: "mouse", isPrimary: true, button: 0 };
    const msBtn = { bubbles: true, cancelable: true, composed: true, button: 0 };
    try { target.dispatchEvent(new PointerEvent("pointerdown", ptrDown)); } catch { /**/ }
    try { target.dispatchEvent(new MouseEvent("mousedown", msBtn)); } catch { /**/ }
    try { target.dispatchEvent(new PointerEvent("pointerup", { ...ptrDown })); } catch { /**/ }
    try { target.dispatchEvent(new MouseEvent("mouseup", msBtn)); } catch { /**/ }
    try { (target as HTMLElement).click(); } catch { /**/ }
    try { target.dispatchEvent(new MouseEvent("click", msBtn)); } catch { /**/ }
    return {
      clicked: true,
      reason,
      tag: target.tagName,
      text: textFor(target).slice(0, 160),
      originTag: el.tagName,
    };
  };

  // Helper: find the best interactive descendant of a container element.
  const bestInteractiveChild = (container: Element): Element | null => {
    const children = Array.from(container.querySelectorAll(
      "button,a,[role='button'],input[type='button'],input[type='submit'],[role='link'],[role='tab'],[tabindex],[onclick],[aria-label]"
    ));
    for (const child of children) {
      if (isVisible(child) && !isDisabled(child)) return child;
    }
    return null;
  };

  // 1. Try recorded CSS/XPath selectors.
  //    If a selector matches but the element is not interactive (e.g. a generic
  //    container like #interop-outlet), fall through to its interactive children.
  for (const candidate of selectors) {
    if (typeof candidate !== "string" || !candidate) continue;
    try {
      let node: Element | Node | null = null;
      if (candidate.startsWith("/") || candidate.startsWith("(")) {
        node = document.evaluate(candidate, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      } else {
        node = document.querySelector(candidate);
      }
      if (!(node instanceof Element)) continue;
      const clicked = clickNode(node, "selector_css");
      if (clicked) return clicked;
      // Container matched but wasn't interactive — try its interactive children.
      const child = bestInteractiveChild(node);
      if (child) {
        const childClicked = clickNode(child, "selector_child");
        if (childClicked) return childClicked;
      }
    } catch { /**/ }
  }

  // 2. Anchor-point hit-test: anchor selector gives us the recorded click
  //    position relative to a stable ancestor element. Using elementFromPoint
  //    finds the exact element the user originally clicked, even when CSS
  //    selectors are stale or overly generic.
  const anchorPoints = Array.isArray(args?.anchorPoints) ? args.anchorPoints as Array<{anchorSelector?: string; offsetX?: number; offsetY?: number}> : [];
  for (const ap of anchorPoints) {
    if (!ap || typeof ap.anchorSelector !== "string") continue;
    try {
      const anchorEl = document.querySelector(ap.anchorSelector);
      if (!anchorEl) continue;
      const rect = anchorEl.getBoundingClientRect();
      const vx = rect.left + (ap.offsetX ?? 0);
      const vy = rect.top + (ap.offsetY ?? 0);
      // elementFromPoint uses viewport coordinates; anchor offsets are from
      // the anchor element's top-left, so rect.left/top already accounts for scroll.
      let target = document.elementFromPoint(vx, vy) as Element | null;
      if (!target && ap.offsetY) {
        // Try scroll-adjusted (document coordinates) in case offsets were absolute
        const vy2 = (ap.offsetY ?? 0) - window.scrollY;
        target = document.elementFromPoint(ap.offsetX ?? 0, vy2) as Element | null;
      }
      if (!target) continue;
      const clicked = clickNode(target, "anchor_point");
      if (clicked) return clicked;
      // If the hit element is not interactive, look upward and then at children.
      const upClicked = clickNode(target.parentElement, "anchor_point_parent");
      if (upClicked) return upClicked;
      const child = bestInteractiveChild(target);
      if (child) {
        const childClicked = clickNode(child, "anchor_point_child");
        if (childClicked) return childClicked;
      }
    } catch { /**/ }
  }

  // 3. Text / label ranking across interactive elements.
  const nodes = Array.from(document.querySelectorAll(
    "button,a,[role='button'],input[type='button'],input[type='submit'],input[type='radio'],input[type='checkbox'],summary,label,[aria-label],[data-testid],[onclick],[tabindex],span,div,p,li,strong,b"
  ));
  let best: Element | null = null;
  let bestScore = -1;
  for (const el of nodes) {
    const s = scoreEl(el);
    if (s > bestScore) { bestScore = s; best = el; }
  }
  if (best && bestScore >= 18) {
    const clicked = clickNode(best, "text_rank");
    if (clicked) return { ...clicked, score: bestScore };
  }

  throw new Error(`JS_CLICK_FALLBACK_NO_TARGET:${label}`);
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
    const args = command.script_args ?? {};

    // Route to the pre-compiled JS_CLICK_HARNESS when the backend marks this
    // as a js_click fallback.  JS_CLICK_HARNESS uses NO new Function()/eval so
    // it is safe under Chrome MV3 CSP and strict-CSP pages like LinkedIn.
    if (args.__harness === "js_click") {
      const start = Date.now();
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: JS_CLICK_HARNESS,
          args: [args as Record<string, unknown>],
        });
        const out = results?.[0]?.result as ReturnType<typeof JS_CLICK_HARNESS> | undefined;
        if (!out) {
          return { success: false, error: "run_script: no result returned" };
        }
        return {
          success: true,
          script_result: out,
          script_logs: [],
          script_duration_ms: Date.now() - start,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Re-surface JS_CLICK_FALLBACK_NO_TARGET so the backend can classify it.
        if (msg.includes("JS_CLICK_FALLBACK_NO_TARGET")) {
          return { success: false, error: msg, script_duration_ms: Date.now() - start };
        }
        log.error("JS_CLICK_HARNESS failed:", msg);
        return { success: false, error: `run_script injection failed: ${msg}`, script_duration_ms: Date.now() - start };
      }
    }

    const source = command.script;
    if (!source || typeof source !== "string") {
      return { success: false, error: "run_script: missing 'script' source" };
    }
    const userTimeout = Math.min(
      Math.max(command.script_timeout_ms ?? 5000, 100),
      15_000,
    );

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
