import { captureDomSnippet } from "./dom";

const DEFAULT_ACTION_TIMEOUT = 30000;
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
    let framesChecked = 0;
    let prevRect: DOMRect | undefined;

    function check() {
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

export interface StepToExecute {
  action_type: string;
  selector_chain: SelectorSet[];
  value?: string;
  intent?: string;
  force?: boolean;
}

export interface StepResult {
  success: boolean;
  error?: string;
}

function findElementBySelectors(chain: SelectorSet[]): Element | null {
  const sorted = [...chain].sort((a, b) => (b.score || 0) - (a.score || 0));
  for (const sel of sorted) {
    try {
      let element: Element | null = null;

      switch (sel.type) {
        case "css":
          element = document.querySelector(sel.value);
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

function findElementByText(text: string): Element | null {
  const elements = document.querySelectorAll<HTMLElement>(
    "a, button, span, label, div, h1, h2, h3, h4, h5, h6, p, li, td, th",
  );
  const lowerText = text.toLowerCase().replace(/[\n\t]/g, " ").trim();

  for (const el of elements) {
    if ((el.textContent || "").toLowerCase().replace(/[\n\t]/g, " ").trim() === lowerText) {
      return el;
    }
  }
  for (const el of elements) {
    if ((el.textContent || "").toLowerCase().replace(/[\n\t]/g, " ").trim().includes(lowerText)) {
      return el;
    }
  }
  return null;
}

function findElementByAccessibility(data: string): Element | null {
  let role = "";
  let label = "";

  try {
    const parsed = JSON.parse(data);
    role = parsed[0] || "";
    label = parsed[1] || "";
  } catch {
    const parts = data.split("|");
    role = parts[0] || "";
    label = parts[1] || "";
  }

  if (label) {
    const elements = document.querySelectorAll<HTMLElement>("[aria-label]");
    for (const el of elements) {
      if (el.getAttribute("aria-label") === label) return el;
    }
  }

  if (role) {
    const byRole = document.querySelector<HTMLElement>(`[role="${CSS.escape(role)}"]`);
    if (byRole) return byRole;
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

  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  const events = [
    new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
    }),
    new MouseEvent("mousedown", {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
    }),
    new PointerEvent("pointerup", {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
    }),
    new MouseEvent("mouseup", {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
    }),
    new MouseEvent("click", {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
    }),
  ];

  for (const event of events) {
    const dispatched = element.dispatchEvent(event);
    if (!dispatched) return false;
  }

  return true;
}

function simulateType(element: Element, value?: string): boolean {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    return false;
  }

  element.focus();

  const val = value || "";

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
  element.blur();

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

function simulateNavigate(value?: string): boolean {
  if (!value) return false;

  if (value.startsWith("./") || value.startsWith("../") || value.startsWith("?") || value.startsWith("#")) {
    window.location.href = new URL(value, window.location.href).href;
    return true;
  }

  if (value.startsWith("http") || value.startsWith("/")) {
    window.location.href = value;
    return true;
  }
  return false;
}

export async function executeStep(step: StepToExecute): Promise<StepResult> {
  let element: Element | null = null;

  if (step.action_type !== "navigate" && step.action_type !== "scroll") {
    element = findElementBySelectors(step.selector_chain);
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
  } else if (step.action_type !== "navigate") {
    element = findElementBySelectors(step.selector_chain);
    if (!element) {
      return { success: false, error: "ELEMENT_NOT_FOUND" };
    }
  }

  try {
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
        break;
      }
      case "select": {
        if (!element) return { success: false, error: "ELEMENT_NOT_FOUND" };
        if (!simulateSelect(element, step.value))
          return { success: false, error: "Cannot select on this element" };
        break;
      }
      case "scroll": {
        if (!element) return { success: false, error: "ELEMENT_NOT_FOUND" };
        simulateScroll(element);
        break;
      }
      case "hover": {
        if (!element) return { success: false, error: "ELEMENT_NOT_FOUND" };
        (element as HTMLElement)?.focus();
        break;
      }
      case "navigate":
        simulateNavigate(step.value);
        break;
      default:
        return { success: false, error: `Unknown action type: ${step.action_type}` };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: `EXECUTION_ERROR: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
