import { captureDomSnippet } from "./dom";

// Keep well below the command-executor's 15 s hard timeout so the content
// script can return ELEMENT_BLOCKED rather than letting the executor time out.
const DEFAULT_ACTION_TIMEOUT = 10_000;
const POLL_INTERVAL = 100;

export type ErrorCode =
  | "ELEMENT_NOT_FOUND"
  | "ELEMENT_NOT_VISIBLE"
  | "ELEMENT_NOT_ENABLED"
  | "ELEMENT_NOT_EDITABLE"
  | "ELEMENT_BLOCKED"
  | "ELEMENT_UNSTABLE"
  | "NAVIGATION_FAILURE"
  | "PERMISSION_DENIED"
  | "TAB_CLOSED"
  | "NETWORK_ERROR"
  | "EXECUTION_ERROR";

export function checkVisibility(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none") return false;
  if (style.visibility === "hidden") return false;
  if (el.hasAttribute("hidden")) return false;
  return true;
}

export function checkStability(el: Element): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + 2_000; // give up and assume stable after 2 s
    let framesChecked = 0;
    let prevRect: DOMRect | undefined;

    function check() {
      if (Date.now() >= deadline) { resolve(true); return; } // animation-stuck guard
      if (!(el instanceof HTMLElement)) { resolve(false); return; }
      const rect = el.getBoundingClientRect();
      if (prevRect &&
          rect.x === prevRect.x && rect.y === prevRect.y &&
          rect.width === prevRect.width && rect.height === prevRect.height) {
        framesChecked++;
        if (framesChecked >= 2) { resolve(true); return; }
      } else {
        framesChecked = 0;
      }
      prevRect = rect;
      requestAnimationFrame(check);
    }
    check();
  });
}

export function checkEnabled(el: Element): boolean {
  if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    if (el.disabled) return false;
  }
  let parent = el.parentElement;
  while (parent) {
    if (parent instanceof HTMLFieldSetElement && parent.disabled) return false;
    parent = parent.parentElement;
  }
  return true;
}

export function checkEditable(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.readOnly) return false;
  }
  if (el.hasAttribute("contenteditable")) return true;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ||
         el instanceof HTMLSelectElement;
}

export function checkNotOverlayed(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return true;
  try {
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const topEl = document.elementFromPoint(centerX, centerY);
    return !!((topEl === el) || el.contains(topEl) || (topEl && topEl.contains(el)));
  } catch {
    return true;
  }
}

export async function waitForElement(
  el: Element | null,
  options: { timeout?: number; force?: boolean; reduceMotion?: boolean } = {},
): Promise<{ passed: boolean; reason?: string }> {
  if (!el) return { passed: false, reason: "ELEMENT_NOT_FOUND" };

  if (options.force) return { passed: true };

  const timeout = options.timeout ?? DEFAULT_ACTION_TIMEOUT;
  const start = Date.now();

  if (!checkVisibility(el)) return { passed: false, reason: "ELEMENT_NOT_VISIBLE" };
  if (!checkEnabled(el)) return { passed: false, reason: "ELEMENT_NOT_ENABLED" };

  if (!options.reduceMotion) {
    try {
      const stable = await checkStability(el);
      if (!stable) return { passed: false, reason: "ELEMENT_UNSTABLE" };
    } catch {
      // If rAF is not available (test env), skip stability check
    }
  }

  // Scroll element into viewport so elementFromPoint works for off-screen elements
  // (e.g. sidebar items below the fold). Use "nearest" to minimise jump.
  try {
    (el as HTMLElement).scrollIntoView({ behavior: "instant", block: "nearest" });
    await new Promise((r) => setTimeout(r, 80));
  } catch { /* no-op in envs without scrollIntoView */ }

  if (checkNotOverlayed(el)) return { passed: true };

  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    if (checkNotOverlayed(el)) return { passed: true };
  }

  return { passed: false, reason: "ELEMENT_BLOCKED" };
}

export interface SelectorSet {
  type: string;
  value: string;
  score?: number;
}

export interface AnchorSelectorValue {
  anchor_selector: string;
  relation: string;
  offset_x?: number;
  offset_y?: number;
}

export interface StepMethod {
  action_type: string;
  selector_chain: SelectorSet[];
  value?: string;
}

export interface StepToExecute {
  action_type: string;
  selector_chain: SelectorSet[];
  value?: string;
  intent?: string;
  force?: boolean;
  methods?: StepMethod[];
  delay_before_ms?: number;
  success_condition?: Record<string, unknown> | null;
}

export interface StepResult {
  success: boolean;
  error?: string;
  actual_url?: string;
  via_method_index?: number;
}

function _normalizeForCheck(value: string): string {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Shadow-DOM-aware query: tries root.querySelector first, then recurses into
// every shadow root in the subtree. LinkedIn-style overlays mount their
// chat UI inside a closed-mode-equivalent open shadow root, so plain
// document.querySelector cannot find their buttons.
function _deepQuerySelector(selector: string, root: ParentNode = document): Element | null {
  try {
    const direct = root.querySelector(selector);
    if (direct) return direct;
  } catch { /* invalid selector */ }
  const all = root.querySelectorAll("*");
  for (const node of all) {
    const sr = (node as HTMLElement).shadowRoot;
    if (sr) {
      const found = _deepQuerySelector(selector, sr);
      if (found) return found;
    }
  }
  return null;
}

function _deepQuerySelectorAll(selector: string, root: ParentNode = document): Element[] {
  const out: Element[] = [];
  try {
    out.push(...Array.from(root.querySelectorAll(selector)));
  } catch { /* invalid selector */ }
  const all = root.querySelectorAll("*");
  for (const node of all) {
    const sr = (node as HTMLElement).shadowRoot;
    if (sr) out.push(..._deepQuerySelectorAll(selector, sr));
  }
  return out;
}

function _verifySuccessCondition(
  step: StepToExecute,
  element: Element | null,
): { ok: boolean; reason?: string } {
  const condition = step.success_condition;
  if (!condition || typeof condition !== "object") return { ok: true };
  const ctype = String(condition.type || "").toLowerCase().trim();
  if (!ctype) return { ok: true };

  if (ctype === "visible_text_contains") {
    const expected = _normalizeForCheck(String(condition.value || ""));
    if (!expected) return { ok: true };
    const pageText = _normalizeForCheck(document.body?.innerText || "");
    if (pageText.includes(expected)) return { ok: true };
    return { ok: false, reason: "SUCCESS_CONDITION_FAILED:visible_text_contains" };
  }

  if (ctype === "url_contains") {
    const expected = String(condition.value || "");
    if (!expected) return { ok: true };
    if ((window.location.href || "").includes(expected)) return { ok: true };
    return { ok: false, reason: "SUCCESS_CONDITION_FAILED:url_contains" };
  }

  if (ctype === "input_value_contains") {
    const expected = _normalizeForCheck(String(condition.value || ""));
    if (!expected) return { ok: true };
    const candidate = element || findElementBySelectors(step.selector_chain || []);
    if (!candidate) return { ok: false, reason: "SUCCESS_CONDITION_FAILED:input_value_contains_no_target" };
    let observed = "";
    if (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) {
      observed = candidate.value || "";
    } else if (candidate instanceof HTMLElement && candidate.isContentEditable) {
      observed = candidate.textContent || "";
    } else {
      observed = (candidate as HTMLElement).textContent || "";
    }
    if (_normalizeForCheck(observed).includes(expected)) return { ok: true };
    return { ok: false, reason: "SUCCESS_CONDITION_FAILED:input_value_contains_mismatch" };
  }

  if (ctype === "selector_exists") {
    const selector = String(condition.selector || "");
    if (selector) {
      try {
        const found = selector.startsWith("/") || selector.startsWith("(")
          ? document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
          : document.querySelector(selector);
        if (found) return { ok: true };
      } catch {
        return { ok: false, reason: "SUCCESS_CONDITION_FAILED:selector_exists_invalid_selector" };
      }
      return { ok: false, reason: "SUCCESS_CONDITION_FAILED:selector_exists_not_found" };
    }
    const found = findElementBySelectors(step.selector_chain || []);
    if (found) return { ok: true };
    return { ok: false, reason: "SUCCESS_CONDITION_FAILED:selector_exists_not_found" };
  }

  return { ok: true };
}

function normalizeText(value: string): string {
  return (value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function interactiveCandidates(): HTMLElement[] {
  const selector = "button, a, [role='button'], [role='link'], input[type='button'], input[type='submit'], [aria-label]";
  // Deep search so shadow-DOM-internal candidates (LinkedIn chat overlay) are
  // included alongside light-DOM ones.
  return _deepQuerySelectorAll(selector) as HTMLElement[];
}

function findElementBySelectors(chain: SelectorSet[]): Element | null {
  const sorted = [...chain].sort((a, b) => (b.score || 0) - (a.score || 0));
  for (const sel of sorted) {
    try {
      let element: Element | null = null;

      switch (sel.type) {
        case "shadow_css":
          element = findElementByShadowCss(sel.value);
          break;
        case "css":
          // Try light DOM first; fall back to deep search (shadow piercing).
          element = document.querySelector(sel.value) || _deepQuerySelector(sel.value);
          break;
        case "text":
          element = findElementByText(sel.value);
          break;
        case "accessibility":
          element = findElementByAccessibility(sel.value);
          break;
        case "xpath":
          element = findElementByXPath(sel.value);
          break;
        case "anchor":
          element = findElementByAnchor(sel.value);
          break;
      }

      if (element) return element;
    } catch {
      continue;
    }
  }
  return null;
}

// Walks shadow_css path: host_chain identifies nested shadow hosts; target
// is queried inside the innermost shadow root.
function findElementByShadowCss(raw: string): Element | null {
  let parsed: { host_chain?: string[]; target?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const hostChain = Array.isArray(parsed.host_chain) ? parsed.host_chain : [];
  const target = String(parsed.target || "");
  if (!target) return null;

  let root: ParentNode | null = document;
  for (const hostSel of hostChain) {
    if (!root) return null;
    // Search the current root (may be shadowRoot) for the host, and also
    // pierce nested shadow roots in case the chain skips levels.
    let host: Element | null = null;
    try { host = root.querySelector(hostSel); } catch { /* invalid */ }
    if (!host) host = _deepQuerySelector(hostSel, root);
    if (!host) return null;
    const shadowRoot: ShadowRoot | null = (host as HTMLElement).shadowRoot;
    if (!shadowRoot) {
      // Host's shadow root is closed or replaced — try regular descendants.
      root = host;
    } else {
      root = shadowRoot;
    }
  }
  if (!root) return null;
  try {
    const direct = root.querySelector(target);
    if (direct) return direct;
  } catch { /* invalid selector */ }
  return _deepQuerySelector(target, root);
}

function findElementByText(text: string): Element | null {
  const needle = normalizeText(text);

  // Prefer interactive elements (a, button) — clicking them triggers navigation
  // and form submission handlers correctly, unlike clicking a parent container.
  const { innerWidth: vw, innerHeight: vh } = window;
  const inViewport = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 &&
      r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh;
  };
  const matches = (el: HTMLElement): boolean =>
    normalizeText(el.textContent || "") === needle;
  const includes = (el: HTMLElement): boolean =>
    normalizeText(el.textContent || "").includes(needle);

  const interactive = interactiveCandidates();
  const all = _deepQuerySelectorAll(
    "a, button, span, label, div, h1, h2, h3, h4, h5, h6, p, li, td, th",
  ) as HTMLElement[];

  // Priority: interactive in-viewport → all in-viewport → interactive off-screen → all off-screen
  // Within each tier: exact match before includes match.
  for (const subset of [interactive, all]) {
    const inView = subset.filter(inViewport);
    const offScreen = subset.filter(el => !inViewport(el));
    for (const pool of [inView, offScreen]) {
      const exactHit = pool.find(matches);
      if (exactHit) return exactHit;
      const includesHit = pool.find(includes);
      if (includesHit) return includesHit;
    }
  }
  return null;
}

function findElementByAccessibility(data: string): Element | null {
  let role = "";
  let label = "";

  try {
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      role = String(parsed[0] || "");
      label = String(parsed[1] || "");
    } else if (parsed && typeof parsed === "object") {
      role = String((parsed as any).role || "");
      label = String((parsed as any).label || (parsed as any).name || "");
    }
  } catch {
    const bracketPattern = data.match(/^([a-zA-Z]+)\s*\[\s*text\s*=\s*['"](.+?)['"]\s*\]$/);
    if (bracketPattern) {
      role = bracketPattern[1] || "";
      label = bracketPattern[2] || "";
    } else if (data.includes("|")) {
      const parts = data.split("|");
      role = parts[0] || "";
      label = parts[1] || "";
    } else {
      const roleWord = data.match(/^(button|link|textbox|combobox|menuitem|tab)\s+(.+)$/i);
      if (roleWord) {
        role = roleWord[1] || "";
        label = roleWord[2] || "";
      } else {
        label = data;
      }
    }
  }

  const normalizedLabel = normalizeText(label);
  if (normalizedLabel) {
    const elements = interactiveCandidates();
    const exactA11y = elements.find((el) => normalizeText(el.getAttribute("aria-label") || "") === normalizedLabel);
    if (exactA11y) return exactA11y;

    const exactText = elements.find((el) => normalizeText(el.textContent || "") === normalizedLabel);
    if (exactText) return exactText;

    const includesA11y = elements.find((el) => normalizeText(el.getAttribute("aria-label") || "").includes(normalizedLabel));
    if (includesA11y) return includesA11y;

    const includesText = elements.find((el) => normalizeText(el.textContent || "").includes(normalizedLabel));
    if (includesText) return includesText;

    // Final fallback to generic text search for non-interactive structures.
    const byText = findElementByText(label);
    if (byText) return byText;
  }

  if (role) {
    const normalizedRole = role.trim().toLowerCase();
    const roleMatches = _deepQuerySelectorAll(`[role="${CSS.escape(normalizedRole)}"]`) as HTMLElement[];
    if (roleMatches.length > 0) {
      if (normalizedLabel) {
        const roleLabelExact = roleMatches.find((el) => normalizeText(el.textContent || "") === normalizedLabel);
        if (roleLabelExact) return roleLabelExact;
        const roleLabelIncludes = roleMatches.find((el) => normalizeText(el.textContent || "").includes(normalizedLabel));
        if (roleLabelIncludes) return roleLabelIncludes;
      }
      return roleMatches[0];
    }
  }

  return null;
}

function findElementByXPath(xpath: string): Element | null {
  const DANGEROUS_XPATH = /count\(|string-length\(|substring\(|name\(|translate\(|normalize-space\(/i;
  if (DANGEROUS_XPATH.test(xpath)) {
    return null;
  }
  const result = document.evaluate(
    xpath,
    document,
    null,
    XPathResult.FIRST_ORDERED_NODE_TYPE,
    null,
  );
  return result.singleNodeValue as Element | null;
}

function findElementByAnchor(value: string): Element | null {
  try {
    const parsed: AnchorSelectorValue = JSON.parse(value);
    const anchorEl = document.querySelector(parsed.anchor_selector);
    if (!anchorEl) return null;

    const anchorRect = anchorEl.getBoundingClientRect();
    const offsetX = parsed.offset_x || 0;
    const offsetY = parsed.offset_y || 0;

    const targetX = anchorRect.left + offsetX;
    const targetY = anchorRect.top + offsetY;

    let candidate = document.elementFromPoint(targetX + 1, targetY + 1);
    if (candidate && candidate !== document.body && candidate !== document.documentElement) {
      return candidate;
    }
    // Fallback: search inside the anchor element for the relation direction
    if (parsed.relation === "inside") {
      return anchorEl.querySelector("*:first-child");
    }
    return null;
  } catch {
    return null;
  }
}

function simulateClick(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;

  // Note: dispatched events have isTrusted: false, which blocks site features
  // like requestFullscreen. For future: consider using chrome.debugger API
  // (E-M-12) to produce trusted events.

  // Ensure element is in the viewport so clientX/Y coords are valid.
  try { element.scrollIntoView({ behavior: "instant", block: "nearest" }); } catch { /* no-op */ }

  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  const events: Event[] = [];
  if (typeof PointerEvent !== "undefined") {
    events.push(
      new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
      }),
    );
  }
  events.push(
    new MouseEvent("mousedown", {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
    }),
  );
  if (typeof PointerEvent !== "undefined") {
    events.push(
      new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
      }),
    );
  }
  events.push(
    new MouseEvent("mouseup", {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
    }),
    new MouseEvent("click", {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
    }),
  );

  for (const event of events) {
    const dispatched = element.dispatchEvent(event);
    if (!dispatched) return false;
  }

  return true;
}

function simulateType(element: Element, value?: string): boolean {
  const isEditable = element instanceof HTMLElement && element.isContentEditable;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || isEditable)) {
    return false;
  }

  (element as HTMLElement).focus();
  const val = value || "";

  if (isEditable) {
    // contenteditable: select-all then insertText so framework listeners fire correctly
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    sel?.removeAllRanges();
    sel?.addRange(range);
    // execCommand is deprecated but remains the most reliable way to trigger
    // React/Vue synthetic input events on contenteditable in Chrome.
    const inserted = document.execCommand("insertText", false, val);
    if (!inserted) {
      // Fallback for browsers where execCommand is fully removed
      (element as HTMLElement).textContent = val;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: val }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  if (element instanceof HTMLInputElement) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value"
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(element, val);
    } else {
      element.value = val;
    }
  } else if (element instanceof HTMLTextAreaElement) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, "value"
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(element, val);
    } else {
      element.value = val;
    }
  }

  element.dispatchEvent(new InputEvent("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  // Intentionally no blur() — it closes Odoo many2one dropdowns before options render.

  return true;
}

function simulateSelect(element: Element, value?: string): boolean {
  if (!(element instanceof HTMLSelectElement)) return false;

  if (element.multiple && value) {
    const values = value.split(",").map(v => v.trim());
    for (const option of element.options) {
      option.selected = values.includes(option.value);
    }
  } else {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype, "value"
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(element, value || "");
    } else {
      element.value = value || "";
    }
  }

  element.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function simulateScroll(element: Element): boolean {
  try {
    (element as HTMLElement).scrollIntoView({ behavior: "instant", block: "center" });
    return true;
  } catch {
    // scrollIntoView may not be available in all environments (JSDOM)
    return true;
  }
}

function simulatePageScroll(): boolean {
  try {
    window.scrollBy({ top: window.innerHeight || 800, left: 0, behavior: "instant" });
    return true;
  } catch {
    return true;
  }
}

function simulateNavigate(value?: string): { success: boolean; actual_url?: string } {
  if (!value) return { success: false };

  try {
    if (value.startsWith("./") || value.startsWith("../") || value.startsWith("?") || value.startsWith("#")) {
      window.location.href = new URL(value, window.location.href).href;
      return { success: true, actual_url: window.location.href };
    }

    if (value.startsWith("http") || value.startsWith("/")) {
      window.location.href = value;
      return { success: true, actual_url: window.location.href };
    }
  } catch (err) {
    // JSDOM throws for full-document navigation; treat the assignment as
    // logically accepted so replay tests can verify command routing.
    if (err instanceof Error && err.message.includes("Not implemented: navigation")) {
      return { success: true };
    }
    throw err;
  }
  return { success: false };
}

const ELEMENT_FAILURE_CODES = new Set<string>([
  "ELEMENT_NOT_FOUND",
  "ELEMENT_NOT_VISIBLE",
  "ELEMENT_NOT_ENABLED",
  "ELEMENT_NOT_EDITABLE",
  "ELEMENT_BLOCKED",
  "ELEMENT_UNSTABLE",
]);

function _isElementFailure(result: StepResult): boolean {
  if (result.success) return false;
  const err = result.error || "";
  if (ELEMENT_FAILURE_CODES.has(err)) return true;
  // waitForElement reasons can be prefixed with code (e.g. "ELEMENT_BLOCKED: …")
  for (const code of ELEMENT_FAILURE_CODES) {
    if (err.startsWith(code)) return true;
  }
  return false;
}

export async function executeStep(step: StepToExecute): Promise<StepResult> {
  const primary = await _executeStepInner(step);
  if (primary.success || !_isElementFailure(primary)) return primary;

  const methods = Array.isArray(step.methods) ? step.methods : [];
  for (let i = 0; i < methods.length; i++) {
    const m = methods[i];
    if (!m || !Array.isArray(m.selector_chain) || m.selector_chain.length === 0) continue;
    const attempt: StepToExecute = {
      action_type: m.action_type || step.action_type,
      selector_chain: m.selector_chain,
      value: m.value !== undefined ? m.value : step.value,
      intent: step.intent,
      force: step.force,
      // No methods: prevents recursion. One level of fallback only.
    };
    const result = await _executeStepInner(attempt);
    if (result.success) {
      return { ...result, via_method_index: i };
    }
    if (!_isElementFailure(result)) return result;
  }

  return primary;
}


async function _executeStepInner(step: StepToExecute): Promise<StepResult> {
  // Honour the backend-requested pre-step delay (e.g. 2 s on complex SPAs).
  if (step.delay_before_ms && step.delay_before_ms > 0) {
    await new Promise(r => setTimeout(r, step.delay_before_ms));
  }

  let element: Element | null = null;
  const hasSelectorChain = Array.isArray(step.selector_chain) && step.selector_chain.length > 0;

  if (step.action_type !== "navigate" && step.action_type !== "scroll") {
    element = findElementBySelectors(step.selector_chain);

    // For TYPE steps the target input may not yet be in the DOM (SPA lazy render).
    // Retry up to 2 times with short waits before giving up.
    if (!element && step.action_type === "type") {
      for (const waitMs of [700, 1300]) {
        await new Promise(r => setTimeout(r, waitMs));
        element = findElementBySelectors(step.selector_chain);
        if (element) break;
      }
    }

    if (!element) {
      return {
        success: false,
        error: "ELEMENT_NOT_FOUND",
      };
    }

    const waitResult = await waitForElement(element, { force: step.force });
    if (!waitResult.passed) {
      return {
        success: false,
        error: waitResult.reason || "ELEMENT_NOT_FOUND",
      };
    }
  } else if (step.action_type === "scroll" && hasSelectorChain) {
    element = findElementBySelectors(step.selector_chain);
    if (!element) {
      return { success: false, error: "ELEMENT_NOT_FOUND" };
    }
  }

  try {
    let actualUrl: string | undefined;
    switch (step.action_type) {
      case "click": {
        if (!element) return { success: false, error: "ELEMENT_NOT_FOUND" };
        if (!simulateClick(element))
          return { success: false, error: "Click was canceled by the page" };
        break;
      }
      case "type": {
        if (!element) return { success: false, error: "ELEMENT_NOT_FOUND" };
        if (!simulateType(element, step.value))
          return { success: false, error: "Cannot type into this element" };

        // Many2one auto-select: if the input is inside a many2one/autocomplete widget,
        // wait up to 1.5s for dropdown options to appear and click the first real one.
        // This collapses the fragile type → wait → click-option pattern into one step.
        const m2oParent = (element as HTMLElement).closest(
          ".o_field_many2one, .o_autocomplete, [role='combobox']",
        );
        if (m2oParent) {
          const deadline = Date.now() + 1_500;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 80));
            const opt = document.querySelector<HTMLElement>(
              ".o_dropdown_menu .o_menu_item:not(.o_no_records):not([aria-disabled='true']), " +
              ".dropdown-menu .dropdown-item:not(.disabled):not(.o_no_records)",
            );
            if (opt) { opt.click(); break; }
          }
        }
        break;
      }
      case "select": {
        if (!element) return { success: false, error: "ELEMENT_NOT_FOUND" };
        if (!simulateSelect(element, step.value))
          return { success: false, error: "Cannot select on this element" };
        break;
      }
      case "scroll": {
        if (!element) {
          simulatePageScroll();
          break;
        }
        simulateScroll(element);
        break;
      }
      case "hover": {
        if (!element) return { success: false, error: "ELEMENT_NOT_FOUND" };
        (element as HTMLElement)?.focus();
        break;
      }
      case "navigate": {
        const navResult = simulateNavigate(step.value);
        if (!navResult.success) return { success: false, error: "Navigate failed" };
        actualUrl = navResult.actual_url;
        break;
      }
      default:
        return { success: false, error: `Unknown action type: ${step.action_type}` };
    }

    const condition = _verifySuccessCondition(step, element);
    if (!condition.ok) {
      return { success: false, error: condition.reason || "SUCCESS_CONDITION_FAILED" };
    }
    return actualUrl ? { success: true, actual_url: actualUrl } : { success: true };
  } catch (err) {
    return {
      success: false,
      error: `EXECUTION_ERROR: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
