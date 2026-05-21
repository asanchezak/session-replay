import { createLogger } from "../shared/logger";
import type { AgentCommand, PageContext, PageDiff } from "../shared/types";
import type {
  CapturePageContextMessage,
  ExecuteAgentCommandMessage,
  PageContextResponse,
  AgentCommandResultResponse,
} from "../shared/messaging";

const log = createLogger("command-executor");

/**
 * Per-tab chrome.debugger attach/detach manager. Holds a CDP session so we
 * can issue **trusted** Input.dispatchMouseEvent and Input.insertText calls
 * — synthetic events fired from a content script carry `isTrusted: false`,
 * which LinkedIn's React handler on the Messaging dock and similar UI
 * silently discards. Trusted CDP events are indistinguishable from real
 * user input.
 *
 * The browser shows a yellow "DevTools attached" infobar while attached —
 * known UX cost, accepted by the product. Attach is lazy (on first use)
 * and detach is automatic on tab close.
 */
class DebuggerSession {
  private static attached = new Map<number, boolean>();
  private static onDetachRegistered = false;

  private static ensureDetachListener(): void {
    if (this.onDetachRegistered) return;
    this.onDetachRegistered = true;
    try {
      chrome.debugger.onDetach.addListener((source) => {
        if (typeof source.tabId === "number") {
          this.attached.delete(source.tabId);
        }
      });
    } catch { /* chrome.debugger unavailable */ }
  }

  static async attach(tabId: number): Promise<boolean> {
    this.ensureDetachListener();
    if (this.attached.get(tabId)) return true;
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      this.attached.set(tabId, true);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Another tool may have a debugger attached (DevTools, Playwright).
      // Cannot multiplex — treat as unavailable so caller falls back.
      if (msg.includes("Another debugger") || msg.includes("already attached")) {
        log.warn("DebuggerSession: another debugger already attached to tab", tabId);
      } else {
        log.warn("DebuggerSession.attach failed:", msg);
      }
      return false;
    }
  }

  static async detach(tabId: number): Promise<void> {
    if (!this.attached.get(tabId)) return;
    try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
    this.attached.delete(tabId);
  }

  /**
   * Issue a trusted left-click at viewport coords (x, y) on tabId.
   * Sends mouseMoved (so :hover fires) → mousePressed → mouseReleased.
   * Returns true on success; false if attach or any dispatch failed.
   */
  static async dispatchMouseClick(tabId: number, x: number, y: number): Promise<boolean> {
    if (!(await this.attach(tabId))) return false;
    const rx = Math.round(x);
    const ry = Math.round(y);
    try {
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: rx, y: ry, button: "none", buttons: 0,
      });
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mousePressed", x: rx, y: ry, button: "left", buttons: 1, clickCount: 1,
      });
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: rx, y: ry, button: "left", buttons: 0, clickCount: 1,
      });
      return true;
    } catch (err) {
      log.error("dispatchMouseClick failed:", err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /**
   * Insert text at the currently-focused element via CDP. Trusted —
   * React/contenteditable handlers see it as real user input. Returns true
   * on success.
   */
  static async insertText(tabId: number, text: string): Promise<boolean> {
    if (!(await this.attach(tabId))) return false;
    try {
      await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text });
      return true;
    } catch (err) {
      log.error("insertText failed:", err instanceof Error ? err.message : String(err));
      return false;
    }
  }
}

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
async function JS_CLICK_HARNESS(
  args: Record<string, unknown>,
): Promise<{ clicked: boolean; reason: string; tag: string; text: string; score?: number; originTag?: string | null; error?: string }> {
  const label = String((args && args.label) || "").trim();
  const labelLower = label.toLowerCase();
  const selectors: string[] = Array.isArray(args?.selectorCandidates)
    ? (args.selectorCandidates as unknown[]).map((s) => String(s))
    : [];
  const shadowSelectors: Array<{ hostChain?: unknown; target?: unknown }> = Array.isArray(args?.shadowSelectors)
    ? (args.shadowSelectors as Array<{ hostChain?: unknown; target?: unknown }>)
    : [];
  const textCandidates: string[] = Array.isArray(args?.textCandidates)
    ? (args.textCandidates as unknown[]).map((t) => String(t).trim()).filter(Boolean)
    : [];
  if (label) textCandidates.unshift(label);

  const normalizeToken = (v: unknown) =>
    String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

  // Shadow-DOM-piercing query helpers: querySelector / querySelectorAll do
  // NOT cross shadow boundaries, so LinkedIn-style overlays (the messaging
  // UI lives inside an open shadow root) become invisible to a plain harness.
  const deepQuerySelector = (selector: string, root: ParentNode = document): Element | null => {
    try {
      const direct = root.querySelector(selector);
      if (direct) return direct;
    } catch { return null; }
    const all = root.querySelectorAll("*");
    for (const node of all) {
      const sr = (node as HTMLElement).shadowRoot;
      if (sr) {
        const found = deepQuerySelector(selector, sr);
        if (found) return found;
      }
    }
    return null;
  };
  const deepQuerySelectorAll = (selector: string, root: ParentNode = document): Element[] => {
    const out: Element[] = [];
    try { out.push(...Array.from(root.querySelectorAll(selector))); } catch { return out; }
    const all = root.querySelectorAll("*");
    for (const node of all) {
      const sr = (node as HTMLElement).shadowRoot;
      if (sr) out.push(...deepQuerySelectorAll(selector, sr));
    }
    return out;
  };
  const resolveShadowSelector = (entry: { hostChain?: unknown; target?: unknown }): Element | null => {
    if (!entry || typeof entry.target !== "string") return null;
    const hostChain = Array.isArray(entry.hostChain) ? entry.hostChain.map(String) : [];
    let root: ParentNode = document;
    for (const hostSel of hostChain) {
      let host: Element | null = null;
      try { host = root.querySelector(hostSel); } catch { /**/ }
      if (!host) host = deepQuerySelector(hostSel, root);
      if (!host) return null;
      const sr = (host as HTMLElement).shadowRoot;
      root = sr || host;
    }
    let found: Element | null = null;
    try { found = root.querySelector(entry.target); } catch { /**/ }
    return found || deepQuerySelector(entry.target, root);
  };

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
    const tag = el.tagName;
    if (tag === "BUTTON") s += 30;
    if (tag === "BUTTON" && (el as HTMLButtonElement).type === "submit") s += 25;
    const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
    if (labelLower && labelLower.length >= 3 && cls.includes(labelLower)) s += 40;
    if (tag === "A") {
      const href = (el as HTMLAnchorElement).href || "";
      if (href && !href.startsWith("javascript:") && !href.includes("#")) s -= 15;
    }
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
    // .click() already dispatches a 'click' event — don't ALSO dispatch one
    // manually, or toggle buttons (LinkedIn's Messaging dock) see open→close.
    try { (target as HTMLElement).click(); } catch {
      try { target.dispatchEvent(new MouseEvent("click", msBtn)); } catch { /**/ }
    }
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

  // Single-attempt resolver. Returns a click-result or null. The outer loop
  // calls this repeatedly with sleeps to survive async DOM updates (e.g.
  // LinkedIn fetches the conversation list a beat after the overlay opens).
  const tryAllResolvers = (): ReturnType<typeof clickNode> | { clicked: true; reason: string; tag: string; text: string; score?: number; originTag: string | null } | null => {
  // 0. Shadow_css selectors: walk the recorded host chain through
  //    shadowRoot.querySelector. Highest-priority because they pierce
  //    shadow DOM deterministically.
  for (const entry of shadowSelectors) {
    try {
      const node = resolveShadowSelector(entry);
      if (!(node instanceof Element)) continue;
      const clicked = clickNode(node, "selector_shadow_css");
      if (clicked) return clicked;
      const child = bestInteractiveChild(node);
      if (child) {
        const childClicked = clickNode(child, "selector_shadow_child");
        if (childClicked) return childClicked;
      }
    } catch { /**/ }
  }

  // 1. Try recorded CSS/XPath selectors.
  //    If a selector matches but the element is not interactive (e.g. a generic
  //    container like #interop-outlet), fall through to its interactive children.
  //    CSS path falls back to a shadow-piercing deep query so LinkedIn-style
  //    inner-shadow inputs are still findable when light-DOM querySelector misses.
  for (const candidate of selectors) {
    if (typeof candidate !== "string" || !candidate) continue;
    try {
      let node: Element | Node | null = null;
      if (candidate.startsWith("/") || candidate.startsWith("(")) {
        node = document.evaluate(candidate, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      } else {
        node = document.querySelector(candidate);
        if (!node) node = deepQuerySelector(candidate);
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
  //    Deep query so shadow-DOM-internal candidates (LinkedIn chat overlay) count.
  //    Include h1-h6 — LinkedIn renders names in <h3> inside conversation cards.
  const nodes = deepQuerySelectorAll(
    "button,a,[role='button'],input,textarea,select,summary,label,[aria-label],[data-testid],[onclick],[tabindex],span,div,p,li,strong,b,h1,h2,h3,h4,h5,h6"
  );
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

  return null;  // tryAllResolvers found nothing this pass
  };  // end of tryAllResolvers

  // Poll for up to 2s. Long enough for one async DOM tick (LinkedIn's
  // messaging overlay paint after click), short enough that the agent's
  // outer retry loop still gets multiple chances. Total budget across agent
  // retries is roughly 6-10s.
  const start = Date.now();
  const deadline = start + 2000;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  while (true) {
    const result = tryAllResolvers();
    if (result) {
      // Settle: give LinkedIn's overlay open / list fetch a beat to start
      // before the next step queries the DOM. Without this the next step
      // (e.g. click Franz card) races the overlay's async render.
      await sleep(400);
      return result;
    }
    if (Date.now() >= deadline) break;
    await sleep(200);
  }

  // Return a structured failure rather than throwing: chrome.scripting
  // .executeScript({func}) does NOT reject when the injected function throws;
  // it returns results with result=undefined and a separate `error` field —
  // which the caller couldn't surface, so failures looked like "no result".
  return {
    clicked: false,
    reason: "no_target",
    tag: "",
    text: "",
    error: `JS_CLICK_FALLBACK_NO_TARGET:${label}`,
  };
}

/**
 * Locates the same target JS_CLICK_HARNESS would click and returns its
 * viewport center coords (plus tag/text for diagnostics). Used by the
 * trusted-click path: locate via injected script, then dispatch
 * Input.dispatchMouseEvent at the returned coords via chrome.debugger.
 *
 * Returns null when no target is found within the retry window so the
 * caller can fall back to the synthetic-click harness or surface
 * JS_CLICK_FALLBACK_NO_TARGET.
 */
async function JS_LOCATE_HARNESS(
  args: Record<string, unknown>,
): Promise<
  | { x: number; y: number; width: number; height: number; tag: string; text: string; reason: string }
  | { found: false; debug: { shadowTried: number; ssTried: number; csTried: number; nodeCount: number; bestScore: number; sampleMatches: Array<{ tag: string; text: string; score: number }>; textCandidatesSample?: string[]; needleMatchCount?: number; needleSamples?: string[]; pageUrl?: string; bodyTextSample?: string } }
  | null
> {
  const label = String((args && args.label) || "").trim();
  const labelLower = label.toLowerCase();
  const selectors: string[] = Array.isArray(args?.selectorCandidates)
    ? (args.selectorCandidates as unknown[]).map((s) => String(s))
    : [];
  const shadowSelectors: Array<{ hostChain?: unknown; target?: unknown }> = Array.isArray(args?.shadowSelectors)
    ? (args.shadowSelectors as Array<{ hostChain?: unknown; target?: unknown }>)
    : [];
  const textCandidates: string[] = Array.isArray(args?.textCandidates)
    ? (args.textCandidates as unknown[]).map((t) => String(t).trim()).filter(Boolean)
    : [];
  if (label) textCandidates.unshift(label);

  const normalizeToken = (v: unknown) =>
    String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

  const deepQuerySelector = (selector: string, root: ParentNode = document): Element | null => {
    try { const d = root.querySelector(selector); if (d) return d; } catch { return null; }
    for (const node of root.querySelectorAll("*")) {
      const sr = (node as HTMLElement).shadowRoot;
      if (sr) { const f = deepQuerySelector(selector, sr); if (f) return f; }
    }
    return null;
  };
  const deepQuerySelectorAll = (selector: string, root: ParentNode = document): Element[] => {
    const out: Element[] = [];
    try { out.push(...Array.from(root.querySelectorAll(selector))); } catch { return out; }
    for (const node of root.querySelectorAll("*")) {
      const sr = (node as HTMLElement).shadowRoot;
      if (sr) out.push(...deepQuerySelectorAll(selector, sr));
    }
    return out;
  };
  const resolveShadowSelector = (entry: { hostChain?: unknown; target?: unknown }): Element | null => {
    if (!entry || typeof entry.target !== "string") return null;
    const hostChain = Array.isArray(entry.hostChain) ? entry.hostChain.map(String) : [];
    let root: ParentNode = document;
    for (const hostSel of hostChain) {
      let host: Element | null = null;
      try { host = root.querySelector(hostSel); } catch { /**/ }
      if (!host) host = deepQuerySelector(hostSel, root);
      if (!host) return null;
      root = (host as HTMLElement).shadowRoot || host;
    }
    let f: Element | null = null;
    try { f = root.querySelector(entry.target); } catch { /**/ }
    return f || deepQuerySelector(entry.target, root);
  };

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
    if (el.matches("button,a,[role='button'],input,textarea,select,summary,label")) return true;
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
    // Action-button bias: prefer buttons (especially submit) over links.
    // For short labels like "Send", many <a> tags match by text but only
    // the actual <button type="submit"> is what the workflow recorded.
    const tag = el.tagName;
    if (tag === "BUTTON") s += 30;
    if (tag === "BUTTON" && (el as HTMLButtonElement).type === "submit") s += 25;
    // Class-name affinity: e.g. msg-form__send-button for LinkedIn chat Send
    const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
    if (labelLower && labelLower.length >= 3 && cls.includes(labelLower)) s += 40;
    // Demote links that look like nav rather than actions (URL ending in a route)
    if (tag === "A") {
      const href = (el as HTMLAnchorElement).href || "";
      if (href && !href.startsWith("javascript:") && !href.includes("#")) s -= 15;
    }
    return s;
  };

  const measureTarget = (el: Element, reason: string) => {
    const target = bestActionableTarget(el) || el;
    try { target.scrollIntoView({ block: "center", inline: "center" }); } catch { /**/ }
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      tag: target.tagName,
      text: textFor(target).slice(0, 160),
      reason,
    };
  };

  const tryAllResolvers = () => {
    for (const entry of shadowSelectors) {
      try {
        const node = resolveShadowSelector(entry);
        if (!(node instanceof Element)) continue;
        if (!isVisible(node) || isDisabled(node)) continue;
        const m = measureTarget(node, "selector_shadow_css");
        if (m) return m;
      } catch { /**/ }
    }
    for (const candidate of selectors) {
      if (typeof candidate !== "string" || !candidate) continue;
      try {
        let node: Element | Node | null = null;
        if (candidate.startsWith("/") || candidate.startsWith("(")) {
          node = document.evaluate(candidate, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        } else {
          node = document.querySelector(candidate);
          if (!node) node = deepQuerySelector(candidate);
        }
        if (!(node instanceof Element)) continue;
        if (!isVisible(node) || isDisabled(node)) continue;
        const m = measureTarget(node, "selector_css");
        if (m) return m;
      } catch { /**/ }
    }
    // Score by the actionable ancestor of each text-bearing leaf, not the
    // leaf itself. A SPAN with text "Send" inside <button class="msg-form
    // __send-button"> should be scored as the BUTTON (which gets the
    // tag/class bonuses); otherwise a leaf SPAN ties with a leaf SPAN
    // elsewhere on the page that happens to also say "Send" and the wrong
    // one wins because it appears earlier in the DOM.
    const nodes = deepQuerySelectorAll(
      "button,a,[role='button'],input,textarea,select,summary,label,[aria-label],[data-testid],[onclick],[tabindex],span,div,p,li,strong,b,h1,h2,h3,h4,h5,h6"
    );
    const actionables = new Set<Element>();
    for (const el of nodes) {
      const target = bestActionableTarget(el) || el;
      actionables.add(target);
    }
    let best: Element | null = null;
    let bestScore = -1;
    for (const target of actionables) {
      const s = scoreEl(target);
      if (s > bestScore) { bestScore = s; best = target; }
    }
    if (best && bestScore >= 18) {
      const m = measureTarget(best, "text_rank");
      if (m) return m;
    }
    return null;
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + 6000;
  while (true) {
    const result = tryAllResolvers();
    if (result) return result;
    if (Date.now() >= deadline) break;
    await sleep(200);
  }

  // Diagnostic: dump what we saw in the final attempt so the caller can
  // figure out why locate is failing.
  const nodes = deepQuerySelectorAll(
    "button,a,[role='button'],input,textarea,select,summary,label,[aria-label],[data-testid],[onclick],[tabindex],span,div,p,li,strong,b,h1,h2,h3,h4,h5,h6"
  );
  const scoredMatches: Array<{ tag: string; text: string; score: number }> = [];
  for (const el of nodes) {
    const s = scoreEl(el);
    if (s > 0) {
      scoredMatches.push({ tag: el.tagName.toLowerCase(), text: textFor(el).slice(0, 80), score: s });
    }
  }
  scoredMatches.sort((a, b) => b.score - a.score);

  // Count how many of the 2164 nodes have ANY text that matches ANY needle
  // (regardless of score). Helps figure out if matchesNeedle is broken.
  let needleMatchCount = 0;
  const needleSamples: string[] = [];
  for (const el of nodes) {
    const t = textFor(el);
    if (textCandidates.some((needle) => matchesNeedle(t, needle))) {
      needleMatchCount++;
      if (needleSamples.length < 3) needleSamples.push(`${el.tagName.toLowerCase()}: ${t.slice(0, 60)}`);
    }
  }

  return {
    found: false,
    debug: {
      shadowTried: shadowSelectors.length,
      ssTried: selectors.length,
      csTried: selectors.filter((c) => c && !c.startsWith("/")).length,
      nodeCount: nodes.length,
      bestScore: scoredMatches[0]?.score || 0,
      sampleMatches: scoredMatches.slice(0, 3),
      textCandidatesSample: textCandidates.slice(0, 3).map((s) => s.replace(/\s+/g, " ").slice(0, 50)),
      needleMatchCount,
      needleSamples,
      pageUrl: window.location.href.slice(0, 120),
      bodyTextSample: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 200),
    },
  };
}

/**
 * Pre-compiled type-fallback harness for strict CSP pages.
 * Mirrors backend `__harness: "js_type"` behavior without eval/new Function.
 */
function JS_TYPE_HARNESS(
  args: Record<string, unknown>,
): {
  typed: boolean;
  via: string;
  tag: string;
  score?: number;
  placeholder?: string | null;
  ariaLabel?: string | null;
  selector?: string;
} {
  const value = String((args && args.value) || "");
  const placeholderHint = String((args && args.placeholderHint) || "").toLowerCase().trim();
  const ariaHint = String((args && args.ariaHint) || "").toLowerCase().trim();
  const fieldHint = String((args && args.fieldHint) || "").toLowerCase().trim();
  const cssCandidates: string[] = Array.isArray(args?.cssCandidates)
    ? (args.cssCandidates as unknown[]).map((s) => String(s))
    : [];
  const shadowSelectors: Array<{ hostChain?: unknown; target?: unknown }> = Array.isArray(args?.shadowSelectors)
    ? (args.shadowSelectors as Array<{ hostChain?: unknown; target?: unknown }>)
    : [];

  const normalize = (v: unknown): string =>
    String(v || "").toLowerCase().trim();

  // Shadow-DOM-piercing helpers (mirror JS_CLICK_HARNESS).
  const deepQuerySelector = (selector: string, root: ParentNode = document): Element | null => {
    try { const d = root.querySelector(selector); if (d) return d; } catch { return null; }
    const all = root.querySelectorAll("*");
    for (const node of all) {
      const sr = (node as HTMLElement).shadowRoot;
      if (sr) { const f = deepQuerySelector(selector, sr); if (f) return f; }
    }
    return null;
  };
  const deepQuerySelectorAll = (selector: string, root: ParentNode = document): Element[] => {
    const out: Element[] = [];
    try { out.push(...Array.from(root.querySelectorAll(selector))); } catch { return out; }
    const all = root.querySelectorAll("*");
    for (const node of all) {
      const sr = (node as HTMLElement).shadowRoot;
      if (sr) out.push(...deepQuerySelectorAll(selector, sr));
    }
    return out;
  };
  const resolveShadowSelector = (entry: { hostChain?: unknown; target?: unknown }): Element | null => {
    if (!entry || typeof entry.target !== "string") return null;
    const hostChain = Array.isArray(entry.hostChain) ? entry.hostChain.map(String) : [];
    let root: ParentNode = document;
    for (const hostSel of hostChain) {
      let host: Element | null = null;
      try { host = root.querySelector(hostSel); } catch { /**/ }
      if (!host) host = deepQuerySelector(hostSel, root);
      if (!host) return null;
      root = (host as HTMLElement).shadowRoot || host;
    }
    let f: Element | null = null;
    try { f = root.querySelector(entry.target); } catch { /**/ }
    return f || deepQuerySelector(entry.target, root);
  };

  const isVisible = (el: Element | null): boolean => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0
      && rect.height > 0
      && style.display !== "none"
      && style.visibility !== "hidden"
      && style.opacity !== "0"
    );
  };

  const isTypable = (el: Element | null): boolean =>
    !!(
      el instanceof HTMLInputElement
      || el instanceof HTMLTextAreaElement
      || (el instanceof HTMLElement && el.isContentEditable)
    );

  const dispatchInputEvents = (el: Element): void => {
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const doType = (el: Element): void => {
    if (!(el instanceof HTMLElement)) return;
    el.focus();
    if (el.isContentEditable) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
      let inserted = false;
      try {
        inserted = !!document.execCommand("insertText", false, value);
      } catch {
        inserted = false;
      }
      if (!inserted) el.textContent = value;
      dispatchInputEvents(el);
      return;
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto = el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(el, value);
      } else {
        el.value = value;
      }
      dispatchInputEvents(el);
      return;
    }
    throw new Error("JS_TYPE_FALLBACK_NO_TARGET");
  };

  // 0) Shadow_css selectors first — deterministic shadow-DOM piercing.
  for (const entry of shadowSelectors) {
    try {
      const node = resolveShadowSelector(entry);
      if (isVisible(node) && isTypable(node)) {
        doType(node as Element);
        return {
          typed: true,
          via: "shadow_css",
          tag: (node as Element).tagName,
          placeholder: (node as Element).getAttribute("placeholder"),
          ariaLabel: (node as Element).getAttribute("aria-label"),
        };
      }
    } catch { /**/ }
  }

  // 1) Try recorded CSS selectors (light DOM, then deep-query as fallback).
  for (const css of cssCandidates) {
    if (!css) continue;
    try {
      let node = document.querySelector(css);
      if (!node) node = deepQuerySelector(css);
      if (isVisible(node) && isTypable(node)) {
        doType(node as Element);
        return {
          typed: true,
          via: "css",
          selector: css,
          tag: (node as Element).tagName,
          placeholder: (node as Element).getAttribute("placeholder"),
          ariaLabel: (node as Element).getAttribute("aria-label"),
        };
      }
    } catch { /**/ }
  }

  // 2) Rank visible typable fields (deep query — shadow DOM included).
  const candidates = deepQuerySelectorAll(
    "input[type='text'],input[type='search'],input[type='email'],input[type='url'],input:not([type]),textarea,[role='textbox'],[role='searchbox'],[contenteditable='true']",
  ).filter((el) => isVisible(el) && isTypable(el));

  const score = (el: Element): number => {
    let s = 0;
    const ph = normalize(el.getAttribute("placeholder"));
    const aria = normalize(el.getAttribute("aria-label"));
    const name = normalize(el.getAttribute("name"));
    if (placeholderHint && (ph.includes(placeholderHint) || placeholderHint.includes(ph))) s += 100;
    if (ariaHint && (aria.includes(ariaHint) || ariaHint.includes(aria))) s += 90;
    if (fieldHint && (name.includes(fieldHint) || ph.includes(fieldHint) || aria.includes(fieldHint))) s += 60;
    if (el === document.activeElement) s += 40;
    return s;
  };

  let best: Element | null = null;
  let bestScore = -1;
  for (const el of candidates) {
    const s = score(el);
    if (s > bestScore) {
      bestScore = s;
      best = el;
    }
  }

  // 3) Fallback to focused field or first visible candidate.
  if (!best || bestScore <= 0) {
    const active = document.activeElement;
    if (active instanceof Element && isVisible(active) && isTypable(active)) {
      best = active;
    } else if (candidates.length > 0) {
      best = candidates[0];
    }
  }

  if (!best) {
    throw new Error("JS_TYPE_FALLBACK_NO_TARGET");
  }

  doType(best);
  return {
    typed: true,
    via: "js_type",
    score: bestScore,
    tag: best.tagName,
    placeholder: best.getAttribute("placeholder"),
    ariaLabel: best.getAttribute("aria-label"),
  };
}

/**
 * Evaluate a post-action success_condition without eval/new Function.
 * Runs in page MAIN world so it can inspect live DOM/URL under strict CSP.
 */
function VERIFY_SUCCESS_CONDITION_HARNESS(
  args: Record<string, unknown>,
): { ok: boolean; reason?: string; observed?: string } {
  const condition = (args?.condition || {}) as Record<string, unknown>;
  const condType = String(condition.type || "").toLowerCase().trim();
  const selectorChain = Array.isArray(args?.selectorChain)
    ? (args.selectorChain as Array<Record<string, unknown>>)
    : [];

  const norm = (v: unknown): string =>
    String(v || "").replace(/\s+/g, " ").trim().toLowerCase();

  const findFromSelector = (selector: string | null): Element | null => {
    if (!selector) return null;
    try {
      if (selector.startsWith("/") || selector.startsWith("(")) {
        return document.evaluate(
          selector,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        ).singleNodeValue as Element | null;
      }
      return document.querySelector(selector);
    } catch {
      return null;
    }
  };

  const findFromChain = (): Element | null => {
    for (const raw of selectorChain) {
      const sel = (raw || {}) as Record<string, unknown>;
      const t = String(sel.type || "").toLowerCase();
      const v = String(sel.value || "");
      if (!v) continue;
      if (t === "css" || t === "xpath") {
        const found = findFromSelector(v);
        if (found) return found;
      }
    }
    return null;
  };

  if (!condType) return { ok: true };

  if (condType === "visible_text_contains") {
    const expected = norm(condition.value);
    if (!expected) return { ok: true };
    const bodyText = norm(document.body?.innerText || "");
    if (bodyText.includes(expected)) return { ok: true };
    return { ok: false, reason: "visible_text_contains", observed: (document.body?.innerText || "").slice(0, 200) };
  }

  if (condType === "url_contains") {
    const expected = String(condition.value || "");
    if (!expected) return { ok: true };
    const href = window.location.href || "";
    if (href.includes(expected)) return { ok: true };
    return { ok: false, reason: "url_contains", observed: href };
  }

  if (condType === "selector_exists") {
    const explicit = String(condition.selector || "");
    const el = findFromSelector(explicit) || findFromChain();
    if (el) return { ok: true };
    return { ok: false, reason: "selector_exists" };
  }

  if (condType === "input_value_contains") {
    const expectedRaw = String(condition.value || "");
    const expected = norm(expectedRaw);
    if (!expected) return { ok: true };
    const explicit = String(condition.selector || "");
    const target = findFromSelector(explicit) || findFromChain() || (document.activeElement as Element | null);
    if (!target) return { ok: false, reason: "input_value_contains:no_target" };

    let observed = "";
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      observed = target.value || "";
    } else if (target instanceof HTMLElement && target.isContentEditable) {
      observed = target.textContent || "";
    } else if (target instanceof HTMLElement) {
      observed = target.textContent || "";
    }
    if (norm(observed).includes(expected)) return { ok: true };
    return { ok: false, reason: "input_value_contains:mismatch", observed: observed.slice(0, 200) };
  }

  // Unknown condition type should not hard-fail execution loops.
  return { ok: true };
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
  async verifySuccessCondition(
    tabId: number,
    command: AgentCommand,
  ): Promise<{ success: boolean; error?: string }> {
    const condition = command.success_condition;
    if (!condition || typeof condition !== "object") {
      return { success: true };
    }
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: VERIFY_SUCCESS_CONDITION_HARNESS,
        args: [{
          condition,
          selectorChain: command.selector_chain || [],
          action: command.action,
          value: command.value,
        }],
      });
      const out = results?.[0]?.result as { ok: boolean; reason?: string; observed?: string } | undefined;
      if (!out || out.ok) {
        return { success: true };
      }
      return {
        success: false,
        error: `SUCCESS_CONDITION_FAILED:${out.reason || "unknown"}${out.observed ? ` observed=${out.observed}` : ""}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `SUCCESS_CONDITION_ERROR:${msg}` };
    }
  }

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

    // Route to pre-compiled fallback harnesses when the backend marks this
    // as js_click / js_type. These use NO new Function()/eval so they are
    // safe under Chrome MV3 CSP and strict-CSP pages like LinkedIn.
    if (args.__harness === "js_click") {
      const start = Date.now();
      const label = String((args.label as string) || "");

      // Preferred path: locate the target in the page, then dispatch a
      // TRUSTED click via chrome.debugger.Input.dispatchMouseEvent. This is
      // what makes LinkedIn (and other sites that gate UI on
      // event.isTrusted) actually accept the click. Falls back to synthetic
      // JS_CLICK_HARNESS if debugger attach fails or locate finds nothing.
      try {
        log.log(`[trusted-click] locating target for label="${label}"`);
        const locateResults = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: JS_LOCATE_HARNESS,
          args: [args as Record<string, unknown>],
        });
        const located = locateResults?.[0]?.result as Awaited<ReturnType<typeof JS_LOCATE_HARNESS>> | undefined;
        const hasCoords = located && typeof (located as { x?: number }).x === "number";
        if (hasCoords) {
          const l = located as { x: number; y: number; tag: string; reason: string };
          log.log(`[trusted-click] locate result: (${l.x},${l.y}) ${l.tag} via ${l.reason}`);
        } else if (located && "debug" in located) {
          log.log(`[trusted-click] locate FAILED:`, JSON.stringify(located.debug).slice(0, 400));
        } else {
          log.log(`[trusted-click] locate result: null`);
        }
        if (hasCoords) {
          const located2 = located as { x: number; y: number; width: number; height: number; tag: string; text: string; reason: string };
          const trusted = await DebuggerSession.dispatchMouseClick(tabId, located2.x, located2.y);
          log.log(`[trusted-click] dispatchMouseClick returned ${trusted}`);
          if (trusted) {
            // Settle: LinkedIn's overlay-open animation + async conversation
            // list fetch takes 1-2 seconds before Franz's card appears in
            // the DOM. 1500ms ≈ p95 for the messaging dock; LOCATE's own
            // 6s retry catches any slower paint.
            await new Promise((r) => setTimeout(r, 1500));
            return {
              success: true,
              script_result: { clicked: true, via: "debugger", ...located2 },
              script_logs: [],
              script_duration_ms: Date.now() - start,
            };
          }
        }
      } catch (err) {
        log.warn("Trusted-click path failed, falling back to synthetic:", err instanceof Error ? err.message : String(err));
      }

      // Synthetic fallback (original behavior).
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: JS_CLICK_HARNESS,
          args: [args as Record<string, unknown>],
        });
        const injection = results?.[0];
        const injectionError = (injection as { error?: { message?: string } } | undefined)?.error?.message;
        const out = injection?.result as Awaited<ReturnType<typeof JS_CLICK_HARNESS>> | undefined;
        if (!out) {
          const errMsg = injectionError || `JS_CLICK_FALLBACK_NO_TARGET:${label}`;
          return { success: false, error: errMsg, script_duration_ms: Date.now() - start };
        }
        if (out.clicked === false) {
          return {
            success: false,
            error: out.error || `JS_CLICK_FALLBACK_NO_TARGET:${label}`,
            script_result: out,
            script_duration_ms: Date.now() - start,
          };
        }
        return {
          success: true,
          script_result: out,
          script_logs: [],
          script_duration_ms: Date.now() - start,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("JS_CLICK_FALLBACK_NO_TARGET")) {
          return { success: false, error: msg, script_duration_ms: Date.now() - start };
        }
        log.error("JS_CLICK_HARNESS failed:", msg);
        return { success: false, error: `run_script injection failed: ${msg}`, script_duration_ms: Date.now() - start };
      }
    }
    if (args.__harness === "js_type") {
      const start = Date.now();
      const value = String((args.value as string) || "");

      // Preferred path: trusted focus (click) + Input.insertText via CDP.
      // This is what makes React-controlled contenteditables (LinkedIn
      // message composer) accept the typed value — synthetic setter calls
      // get reverted by React because the input event is not isTrusted.
      try {
        const locateResults = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: JS_LOCATE_HARNESS,
          args: [args as Record<string, unknown>],
        });
        const located = locateResults?.[0]?.result as Awaited<ReturnType<typeof JS_LOCATE_HARNESS>> | undefined;
        const hasCoords = located && typeof (located as { x?: number }).x === "number";
        if (hasCoords) {
          const located2 = located as { x: number; y: number; width: number; height: number; tag: string; text: string; reason: string };
          const focused = await DebuggerSession.dispatchMouseClick(tabId, located2.x, located2.y);
          if (focused) {
            // Tiny pause for focus to land + caret to position.
            await new Promise((r) => setTimeout(r, 120));
            const inserted = await DebuggerSession.insertText(tabId, value);
            if (inserted) {
              await new Promise((r) => setTimeout(r, 200));
              return {
                success: true,
                script_result: { typed: true, via: "debugger", ...located2 },
                script_logs: [],
                script_duration_ms: Date.now() - start,
              };
            }
          }
        }
      } catch (err) {
        log.warn("Trusted-type path failed, falling back to synthetic:", err instanceof Error ? err.message : String(err));
      }

      // Synthetic fallback (original behavior).
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: JS_TYPE_HARNESS,
          args: [args as Record<string, unknown>],
        });
        const out = results?.[0]?.result as ReturnType<typeof JS_TYPE_HARNESS> | undefined;
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
        if (msg.includes("JS_TYPE_FALLBACK_NO_TARGET")) {
          return { success: false, error: msg, script_duration_ms: Date.now() - start };
        }
        log.error("JS_TYPE_HARNESS failed:", msg);
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
      const out = await this.runScript(tabId, command);
      if (out.success && command.success_condition) {
        const verified = await this.verifySuccessCondition(tabId, command);
        if (!verified.success) {
          return { ...out, success: false, error: verified.error };
        }
      }
      return out;
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
        if (result.success && command.success_condition) {
          const verified = await this.verifySuccessCondition(tabId, command);
          if (!verified.success) {
            return { success: false, error: verified.error };
          }
        }
        return {
          success: result.success,
          error: result.error,
          via_method_index: result.via_method_index,
          script_result: result.script_result,
          script_logs: result.script_logs,
          script_duration_ms: result.script_duration_ms,
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
