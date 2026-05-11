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
  const lowerText = text.toLowerCase().trim();

  for (const el of elements) {
    if ((el.textContent || "").toLowerCase().trim() === lowerText) {
      return el;
    }
  }
  for (const el of elements) {
    if ((el.textContent || "").toLowerCase().trim().includes(lowerText)) {
      return el;
    }
  }
  return null;
}

function findElementByAccessibility(roleLabel: string): Element | null {
  const [role, label] = roleLabel.split("|");

  if (label) {
    const byLabel = document.querySelector<HTMLElement>(
      `[aria-label="${label}"]`,
    );
    if (byLabel) return byLabel;

    const byRole = document.querySelector<HTMLElement>(
      `[role="${role}"]`,
    );
    if (byRole) return byRole;
  }

  return document.querySelector<HTMLElement>(`[role="${role}"]`);
}

function findElementByXPath(xpath: string): Element | null {
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
  element.value = value || "";
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  element.blur();

  return true;
}

function simulateSelect(element: Element, value?: string): boolean {
  if (!(element instanceof HTMLSelectElement)) return false;

  element.value = value || "";
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function simulateScroll(element: Element): boolean {
  element.scrollIntoView({ behavior: "instant", block: "center" });
  return true;
}

function simulateNavigate(value?: string): boolean {
  if (value && value.startsWith("http")) {
    window.location.href = value;
    return true;
  }
  if (value && value.startsWith("/")) {
    window.location.href = value;
    return true;
  }
  return false;
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
        simulateClick(element!);
        break;
      case "type":
        simulateType(element!, step.value);
        break;
      case "select":
        simulateSelect(element!, step.value);
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
