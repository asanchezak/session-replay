export interface SelectorSet {
  type: string;
  value: string;
}

export interface StepToExecute {
  action_type: string;
  selector_chain: SelectorSet[];
  value?: string;
}

export interface StepResult {
  success: boolean;
  error?: string;
}

function findElementBySelectors(chain: SelectorSet[]): Element | null {
  for (const sel of chain) {
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
  element.scrollIntoView({ behavior: "instant", block: "center" });
  return true;
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

const FRAMEWORK_ATTR_PREFIXES = ["data-react", "data-v-", "data-svelte-", "data-ng-", "data-debug", "data-server-rendered"];

const PII_PATTERNS = [
  // Standard email addresses
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
  // International email addresses (IDN - unicode domain names)
  /\b[^\s@]+@[^\s@]+\.[^\s]{2,}\b/g,
  // US phone numbers: xxx-xxx-xxxx formats
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  // International phone numbers with + prefix
  /\+\d{1,4}[-.\s]?\d{6,14}\b/g,
  // 16-digit credit cards
  /\b\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}\b/g,
  // 15-digit AmEx credit cards (starts with 34 or 37)
  /\b3[47]\d{2}[-.\s]?\d{6}[-.\s]?\d{5}\b/g,
  // 13-digit Visa credit cards (starts with 4)
  /\b4\d{2}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{1}\b/g,
  // SSN (xxx-xx-xxxx)
  /\b\d{3}-\d{2}-\d{4}\b/g,
];

function isFrameworkAttr(name: string): boolean {
  return FRAMEWORK_ATTR_PREFIXES.some((p) => name.startsWith(p));
}

function sanitizeNode(node: Node, depth: number = 0): string {
  if (depth > 10) return "";
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || "";
    return text.length > 200 ? text.slice(0, 200) + "..." : text;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === "script" || tag === "style" || tag === "iframe") return "";

  const attrs: string[] = [];
  for (const attr of el.attributes) {
    const n = attr.name;
    if (n === "id" || n === "class" || n === "role" || n === "aria-label" ||
        n === "data-testid" || n === "data-cy" || n === "data-qa" || n === "data-test" ||
        n === "name" || n === "href" || n === "src" || n === "type" || n === "placeholder" ||
        n.startsWith("aria-") || n.startsWith("data-test-")) {
      if (n === "value") continue;
      if (n === "href" || n === "src") {
        try {
          const url = new URL(attr.value, window.location.href);
          if (url.origin !== window.location.origin) continue;
        } catch { continue; }
      }
      attrs.push(`${n}="${attr.value.replace(/"/g, "&quot;")}"`);
    }
  }
  let html = `<${tag}` + (attrs.length > 0 ? " " + attrs.join(" ") : "") + ">";
  for (const child of el.childNodes) {
    html += sanitizeNode(child, depth + 1);
  }
  html += `</${tag}>`;
  return html;
}

function redactPII(text: string): string {
  let result = text;
  for (const pattern of PII_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

export function captureDomSnippet(selectorPattern: string): { html: string; url: string; title: string } {
  let target: Element | null = null;
  try {
    target = document.querySelector(selectorPattern);
  } catch {
    // Invalid selector, try body
  }
  const root = target || document.body;
  const html = redactPII(sanitizeNode(root));
  return {
    html: html.slice(0, 4000),
    url: window.location.href,
    title: document.title,
  };
}

export function executeStep(step: StepToExecute): StepResult {
  let element: Element | null = null;

  if (step.action_type !== "navigate") {
    element = findElementBySelectors(step.selector_chain);
    if (!element) {
      return {
        success: false,
        error: `Element not found for step: ${step.action_type}`,
      };
    }
  }

  try {
    switch (step.action_type) {
      case "click":
        if (!simulateClick(element!))
          return { success: false, error: "Click was canceled by the page" };
        break;
      case "type":
        if (!simulateType(element!, step.value))
          return { success: false, error: "Cannot type into this element" };
        break;
      case "select":
        if (!simulateSelect(element!, step.value))
          return { success: false, error: "Cannot select on this element" };
        break;
      case "scroll":
        simulateScroll(element!);
        break;
      case "hover":
        (element as HTMLElement)?.focus();
        break;
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
      error: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
