import type { ActionEvent, ActionType } from "../shared/types";

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
    selector: buildSelector(el),
    z_index: parseInt(computedStyle.zIndex) || undefined,
  };
}

export function getDataAttributes(el: HTMLElement): Record<string, string> | undefined {
  const attrs: Record<string, string> = {};
  for (const attr of el.attributes) {
    if (attr.name.startsWith("data-")) {
      attrs[attr.name] = attr.value;
    }
  }
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

export function buildSelector(el: HTMLElement): string {
  if (el.id) return `#${el.id}`;

  const parts: string[] = [];
  let current: HTMLElement | null = el;

  while (current && current !== document.body) {
    let segment = current.tagName.toLowerCase();
    if (current.id) {
      segment = `#${current.id}`;
      parts.unshift(segment);
      break;
    }
    if (current.className && typeof current.className === "string") {
      const classes = current.className.trim().split(/\s+/).slice(0, 2);
      if (classes.length > 0 && classes[0]) {
        segment += `.${classes.join(".")}`;
      }
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (s) => s.tagName === current!.tagName,
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        segment += `:nth-of-type(${index})`;
      }
    }
    parts.unshift(segment);
    current = current.parentElement;
  }

  return parts.join(" > ");
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

  return {
    event_type: "click",
    payload: {
      target: meta,
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
  const target = event.target as HTMLInputElement;
  const meta = getElementMetadata(target);
  const page = getPageContext();
  const value = target.value || target.textContent || "";

  return {
    event_type: "type",
    payload: {
      target: meta,
      input_type: target.type || undefined,
      value_length: value.length,
      field_name: target.name || undefined,
      placeholder: target.placeholder || undefined,
    },
    page_url: page.url,
    page_title: page.title,
    timestamp: new Date().toISOString(),
  };
}

export function captureScroll(): CaptureResult {
  const page = getPageContext();

  return {
    event_type: "scroll",
    payload: {
      scroll_x: Math.round(window.scrollX),
      scroll_y: Math.round(window.scrollY),
      viewport_height: window.innerHeight,
      viewport_width: window.innerWidth,
      document_height: document.documentElement.scrollHeight,
    },
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
