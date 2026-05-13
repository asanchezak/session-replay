import type { ActionEvent, ActionType } from "../shared/types";
import { buildSelectors, buildCssSelector } from "./selectors";

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
