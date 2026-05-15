import type { ActionEvent, ActionType } from "../shared/types";
import { buildSelectors, buildCssSelector } from "./selectors";
import { sanitizeNode, redactPII, isFrameworkAttr } from "./dom";

export interface CaptureResult {
  event_type: ActionType;
  payload: Record<string, unknown>;
  page_url: string;
  page_title: string;
  timestamp: string;
}

function getElementMetadata(target: EventTarget | null): Record<string, unknown> {
  if (!(target instanceof Element)) return {};

  const el = target as HTMLElement;
  const rect = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const computedStyle = window.getComputedStyle(el);
  const chain = buildSelectors(el);
  const root = el.getRootNode();

  return {
    tag,
    id: el.id || undefined,
    classes: Array.from(el.classList),
    text: (el.textContent || "").trim().slice(0, 200) || undefined,
    href: (el as HTMLAnchorElement).href || undefined,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    aria_role: el.getAttribute("role") || undefined,
    aria_label: el.getAttribute("aria-label") || undefined,
    data_attrs: getDataAttributes(el),
    selector: buildCssSelector(el),
    selector_chain: chain,
    z_index: parseInt(computedStyle.zIndex) || undefined,
    type: (el as HTMLInputElement).type || undefined,
    placeholder: (el as HTMLInputElement).placeholder || undefined,
    name: (el as HTMLInputElement).name || undefined,
    in_shadow_dom: root instanceof ShadowRoot,
    in_iframe: window !== window.parent,
  };
}

function buildIntent(
  actionType: string,
  meta: Record<string, unknown>,
  value?: string,
  fieldName?: string,
): string {
  const text = (meta.text as string) || "";
  const label = (meta.aria_label as string) || "";
  const placeholder = (meta.placeholder as string) || "";
  const name = (meta.name as string) || fieldName || "";
  const tag = (meta.tag as string) || "";
  const inputType = (meta.type as string) || "";
  const href = (meta.href as string) || "";
  const displayText = text || label || placeholder || value || "";
  const labelHint = label ? ` (labeled "${label}")` : "";
  const placeholderHint = placeholder ? ` (placeholder "${placeholder}")` : "";
  const nameHint = name ? ` (field "${name}")` : "";

  switch (actionType) {
    case "click":
      if (tag === "a" && href) {
        return `Click the link "${displayText}" to navigate to ${href}`;
      }
      if (tag === "button" || tag === "input" && inputType === "submit" || tag === "input" && inputType === "button") {
        return `Click the ${tag} "${displayText}"${labelHint}`;
      }
      if (displayText) {
        return `Click on "${displayText}"${labelHint}`;
      }
      return `Click on ${tag} element${labelHint}${nameHint}`;

    case "type": {
      const val = value || "";
      if (val && name) {
        return `Type "${val.slice(0, 80)}" into ${name} field${placeholderHint}`;
      }
      if (val && placeholder) {
        return `Type "${val.slice(0, 80)}" into "${placeholder}"${labelHint}`;
      }
      if (val) {
        return `Type "${val.slice(0, 80)}" into ${tag}${labelHint}${placeholderHint}`;
      }
      return `Type into ${tag}${labelHint}${nameHint}${placeholderHint}`;
    }

    case "select": {
      const val = value || "";
      if (val && name) {
        return `Select "${val}" from ${name} dropdown${labelHint}`;
      }
      if (val) {
        return `Select "${val}" from ${tag}${labelHint}`;
      }
      return `Select an option from ${tag}${labelHint}${nameHint}`;
    }

    case "scroll":
      return `Scroll down the page`;

    case "hover":
      if (displayText) {
        return `Hover over "${displayText}"${labelHint}`;
      }
      return `Hover over ${tag} element${labelHint}`;

    case "navigate":
      return `Navigate to ${value || href || "the target URL"}`;

    default:
      return `${actionType} on ${tag}${labelHint}${nameHint}`;
  }
}

export function getDataAttributes(el: HTMLElement): Record<string, string> | undefined {
  const attrs: Record<string, string> = {};
  for (const attr of el.attributes) {
    if (attr.name.startsWith("data-")) {
      const isFramework = ["data-react", "data-v-", "data-svelte-", "data-ng-", "data-debug", "data-server-rendered"]
        .some((p) => attr.name.startsWith(p));
      if (!isFramework) {
        attrs[attr.name] = attr.value;
      }
    }
  }
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

function getPageContext(): { url: string; title: string } {
  return {
    url: window.location.href,
    title: document.title,
  };
}

export function captureClick(event: MouseEvent): CaptureResult {
  const meta = getElementMetadata(event.target);
  const page = getPageContext();
  const intent = buildIntent("click", meta);

  return {
    event_type: "click",
    payload: {
      target: meta,
      intent,
      selector_chain: meta.selector_chain,
      client_x: event.clientX,
      client_y: event.clientY,
      button: event.button,
      modifiers: getModifiers(event),
    },
    page_url: page.url,
    page_title: page.title,
    timestamp: new Date().toISOString(),
  };
}

export function captureInput(event: Event): CaptureResult {
  const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const meta = getElementMetadata(target);
  const page = getPageContext();

  if (target instanceof HTMLSelectElement) {
    const intent = buildIntent("select", meta, target.value, target.name);
    return {
      event_type: "select",
      payload: {
        target: meta,
        intent,
        selector_chain: meta.selector_chain,
        value: target.value,
        multiple_values: target.multiple
          ? Array.from(target.selectedOptions).map((o) => o.value)
          : undefined,
        field_name: target.name || undefined,
      },
      page_url: page.url,
      page_title: page.title,
      timestamp: new Date().toISOString(),
    };
  }

  const rawValue = target.value || target.textContent || "";
  const name = (target as HTMLInputElement).name || "";
  const placeholder = (target as HTMLInputElement).placeholder || "";
  const inputType = (target as HTMLInputElement).type || "";
  const autoComplete = (target as HTMLInputElement).autocomplete || "";
  const sensitiveAutocomplete = ["current-password", "new-password", "cc-number", "cc-csc"];
  const isSensitive = inputType === "password" || sensitiveAutocomplete.includes(autoComplete);

  let value: string;
  let valueLength: number;
  if (isSensitive) {
    const label = autoComplete || inputType;
    value = `[REDACTED:${label}]`;
    valueLength = 0;
  } else {
    value = rawValue;
    valueLength = rawValue.length;
  }

  const intent = buildIntent("type", meta, value, name);

  return {
    event_type: "type",
    payload: {
      target: meta,
      intent,
      selector_chain: meta.selector_chain,
      value: value,
      input_type: inputType || undefined,
      value_length: valueLength,
      field_name: name || undefined,
      placeholder: placeholder || undefined,
    },
    page_url: page.url,
    page_title: page.title,
    timestamp: new Date().toISOString(),
  };
}

export function captureScroll(event?: Event): CaptureResult {
  const page = getPageContext();
  const payload: Record<string, unknown> = {
    scroll_x: Math.round(window.scrollX),
    scroll_y: Math.round(window.scrollY),
    viewport_height: window.innerHeight,
    viewport_width: window.innerWidth,
    document_height: document.documentElement.scrollHeight,
  };

  const target = event?.target as HTMLElement | null;
  if (target && "scrollTop" in target) {
    payload.scroll_target_tag = target.tagName.toLowerCase();
    payload.scroll_target_id = target.id || undefined;
    payload.scroll_target_classes = Array.from(target.classList);
    payload.element_scroll_top = Math.round(target.scrollTop);
    payload.element_scroll_left = Math.round(target.scrollLeft);
  }

  return {
    event_type: "scroll",
    payload,
    page_url: page.url,
    page_title: page.title,
    timestamp: new Date().toISOString(),
  };
}

function getModifiers(event: MouseEvent | KeyboardEvent): string[] {
  const mods: string[] = [];
  if (event.ctrlKey) mods.push("ctrl");
  if (event.shiftKey) mods.push("shift");
  if (event.altKey) mods.push("alt");
  if (event.metaKey) mods.push("meta");
  return mods;
}

export interface PageContextResult {
  url: string;
  title: string;
  dom_snippet: string;
  accessibility_tree: string;
  visible_text: string;
  visible_elements: Array<Record<string, unknown>>;
  is_blocking: boolean;
  blocking_type: string | null;
}

// Phase 2: derive accessible role + name using the standard ARIA cascade so
// the LLM sees a real a11y picture instead of raw tags. Falls back to the
// implicit role of common interactive elements when no explicit role is set.
const IMPLICIT_ROLES: Record<string, string> = {
  a: "link", button: "button", input: "textbox", select: "combobox",
  textarea: "textbox", h1: "heading", h2: "heading", h3: "heading",
  h4: "heading", h5: "heading", h6: "heading", img: "image", nav: "navigation",
  main: "main", aside: "complementary", header: "banner", footer: "contentinfo",
  ul: "list", ol: "list", li: "listitem", form: "form",
};

function computeAccessibleName(el: HTMLElement): string {
  // ARIA name cascade (simplified): aria-labelledby > aria-label > native label
  // > visible text > title attribute > placeholder
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const referenced = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(" ");
    if (referenced) return referenced.slice(0, 120);
  }
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.slice(0, 120);

  // <label for="..."> association for form controls
  if (el.id && ["input", "select", "textarea"].includes(el.tagName.toLowerCase())) {
    const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (labelEl?.textContent) return labelEl.textContent.trim().slice(0, 120);
  }

  const text = (el.textContent || "").trim();
  if (text) return text.slice(0, 120);

  const title = el.getAttribute("title");
  if (title) return title.slice(0, 120);

  const placeholder = (el as HTMLInputElement).placeholder;
  if (placeholder) return placeholder.slice(0, 120);

  return "";
}

function computeAccessibleRole(el: HTMLElement): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const type = (el as HTMLInputElement).type;
    if (type === "submit" || type === "button" || type === "reset") return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    return "textbox";
  }
  return IMPLICIT_ROLES[tag] || tag;
}

function captureAccessibilityTree(): string {
  const interactive = document.querySelectorAll<HTMLElement>(
    "a, button, input, select, textarea, [role], [aria-label], [tabindex], h1, h2, h3, nav, main, [data-testid]"
  );
  const parts: string[] = [];
  for (const el of interactive) {
    if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
    const role = computeAccessibleRole(el);
    const name = computeAccessibleName(el);
    const testId = el.getAttribute("data-testid");
    const disabled = (el as HTMLInputElement).disabled ? " disabled" : "";
    const required = (el as HTMLInputElement).required ? " required" : "";
    const ariaState = ["expanded", "selected", "checked", "pressed"]
      .map((s) => {
        const v = el.getAttribute(`aria-${s}`);
        return v && v !== "false" ? ` ${s}` : "";
      })
      .join("");
    parts.push(
      `[${role}] "${name}"${testId ? ` testid=${testId}` : ""}${disabled}${required}${ariaState}`,
    );
  }
  return parts.join("\n").slice(0, 4000);
}

function captureVisibleText(): string {
  const body = document.body;
  if (!body) return "";
  const text = body.innerText || "";
  return text.slice(0, 2048);
}

function captureVisibleElements(): Array<Record<string, unknown>> {
  const interactive = document.querySelectorAll<HTMLElement>(
    "a, button, input, select, textarea, [role], [aria-label], [onclick]"
  );
  const elements: Array<Record<string, unknown>> = [];
  for (const el of interactive) {
    if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
    if (elements.length >= 30) break;
    const tag = el.tagName.toLowerCase();
    const rect = el.getBoundingClientRect();
    const cssSelector = buildCssSelector(el);
    elements.push({
      tag,
      id: el.id || undefined,
      classes: Array.from(el.classList),
      text: (el.textContent || "").trim().slice(0, 120),
      role: el.getAttribute("role") || undefined,
      aria_label: el.getAttribute("aria-label") || undefined,
      selector: cssSelector,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });
  }
  return elements;
}

function detectBlocking(): { is_blocking: boolean; blocking_type: string | null } {
  const captchaSelectors = [
    'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]',
    'iframe[src*="turnstile"]', 'div[class*="captcha"]',
    'div[id*="captcha"]', '[data-sitekey]',
  ];
  for (const sel of captchaSelectors) {
    if (document.querySelector(sel)) {
      return { is_blocking: true, blocking_type: "captcha" };
    }
  }

  const pwFields = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
  const visiblePw = Array.from(pwFields).filter((f) => {
    const style = window.getComputedStyle(f);
    return style.display !== "none" && style.visibility !== "hidden";
  });
  if (visiblePw.length > 0) {
    return { is_blocking: true, blocking_type: "login_form" };
  }

  const modals = document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="alertdialog"], .modal, .overlay'
  );
  for (const m of modals) {
    const s = window.getComputedStyle(m);
    if (s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0" && m.offsetWidth > 0) {
      return { is_blocking: true, blocking_type: "unexpected_modal" };
    }
  }

  return { is_blocking: false, blocking_type: null };
}

export function capturePageContext(): PageContextResult {
  const url = window.location.href;
  const title = document.title;

  const bodyEl = document.body;
  let dom_snippet = "";
  if (bodyEl) {
    dom_snippet = redactPII(sanitizeNode(bodyEl)).slice(0, 8192);
  }

  const accessibility_tree = captureAccessibilityTree();
  const visible_text = redactPII(captureVisibleText());
  const visible_elements = captureVisibleElements();
  const blocking = detectBlocking();

  return {
    url,
    title,
    dom_snippet,
    accessibility_tree,
    visible_text,
    visible_elements,
    is_blocking: blocking.is_blocking,
    blocking_type: blocking.blocking_type,
  };
}
