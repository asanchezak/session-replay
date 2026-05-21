import type { ActionEvent, ActionType, SelectorSet } from "../shared/types";
import { buildSelectors, buildCssSelector, buildLandmarkPath, isGeneratedId } from "./selectors";
import { sanitizeNode, redactPII, isFrameworkAttr } from "./dom";

// Builds an anchor selector using the actual CLICK coordinates rather than the
// element's bounding-rect top-left.  Critical for shadow DOM hosts where all
// clicks inside the same host would otherwise share identical anchor offsets.
function buildClickPositionAnchor(
  el: HTMLElement,
  clickX: number,
  clickY: number,
): SelectorSet | null {
  // Walk up to find a stable light-DOM ancestor to anchor against.
  let anchorEl: HTMLElement | null = el.parentElement;
  let depth = 0;
  while (anchorEl && anchorEl !== document.documentElement && depth < 8) {
    const id = anchorEl.id;
    if ((id && !isGeneratedId(id)) || anchorEl.getAttribute("data-testid")) break;
    anchorEl = anchorEl.parentElement;
    depth++;
  }
  if (!anchorEl || anchorEl === document.documentElement) return null;

  const anchorCss = buildCssSelector(anchorEl);
  if (!anchorCss) return null;

  const anchorRect = anchorEl.getBoundingClientRect();
  return {
    type: "anchor",
    value: JSON.stringify({
      anchor_selector: anchorCss,
      relation: "inside",
      offset_x: Math.round(clickX - anchorRect.left),
      offset_y: Math.round(clickY - anchorRect.top),
    }),
    score: 0.65,  // Higher than default 0.55 — points to exact click position
  };
}

// Walks event.composedPath() (available synchronously during dispatch) to find
// the innermost element inside shadow DOM that has meaningful accessible attributes.
// Returns null when the click was not inside shadow DOM or no meaningful element found.
function extractShadowDomInfo(event: MouseEvent): {
  ariaLabel?: string;
  text?: string;
  role?: string;
} | null {
  const isElementLike = (node: unknown): node is {
    textContent?: string | null;
    getAttribute?: (name: string) => string | null;
  } => (
    !!node
    && typeof node === "object"
    && (
      node instanceof Element
      || (typeof (node as { getAttribute?: unknown }).getAttribute === "function")
    )
  );

  const normalizeText = (value: string): string =>
    value.trim().replace(/\s+/g, " ");

  try {
    const path = event.composedPath ? event.composedPath() : [];
    // Some apps (LinkedIn interop overlay) expose composedPath nodes that are
    // not plain HTMLElement instances; use element-like duck typing.
    for (const node of path.slice(0, 12)) {
      if (!isElementLike(node)) continue;

      const ariaLabelRaw = node.getAttribute?.("aria-label") || "";
      const roleRaw = node.getAttribute?.("role") || "";
      const ariaLabel = normalizeText(ariaLabelRaw);
      const role = normalizeText(roleRaw).toLowerCase();
      const rawText = normalizeText(String(node.textContent || "")).slice(0, 120);
      const text = rawText.length > 0 ? rawText : undefined;

      // Return on first element with any meaningful attribute/text.
      if (ariaLabel) return { ariaLabel, role: role || undefined, text };
      if (
        role
        && ["button", "link", "menuitem", "option", "tab", "combobox",
          "searchbox", "checkbox", "radio", "switch", "treeitem"].includes(role)
      ) {
        return { role, text };
      }
      if (text) return { text, role };
    }
  } catch { /**/ }
  return null;
}

// Returns true for HTML elements that are meaningfully interactive.
// Used by resolveClickTarget to find the real click target inside delegation roots.
export function isInteractiveTarget(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (["button", "a", "input", "select", "textarea", "summary"].includes(tag)) return true;
  const role = (el.getAttribute("role") || "").toLowerCase();
  if (["button", "link", "checkbox", "radio", "menuitem", "menuitemcheckbox", "menuitemradio",
       "option", "tab", "switch", "treeitem", "combobox", "searchbox"].includes(role)) return true;
  if (el.hasAttribute("data-testid") || el.hasAttribute("onclick")) return true;
  const ti = el.getAttribute("tabindex");
  if (ti !== null && parseInt(ti, 10) >= 0) return true;
  return false;
}

// Walks composedPath looking for an HTMLElement that lives inside a shadow
// root. Returns the innermost interactive shadow-internal element, falling
// back to the innermost shadow-internal HTMLElement of any kind. Returns
// null when no element in the path is inside a shadow root.
function findInsideShadowFromComposedPath(event: MouseEvent): HTMLElement | null {
  const path = event.composedPath ? event.composedPath() : [];
  // First pass: prefer interactive elements inside shadow DOM.
  for (const node of path) {
    if (node instanceof HTMLElement
        && node.getRootNode() instanceof ShadowRoot
        && isInteractiveTarget(node)) {
      return node;
    }
  }
  // Second pass: any element inside shadow DOM (innermost first).
  for (const node of path) {
    if (node instanceof HTMLElement && node.getRootNode() instanceof ShadowRoot) {
      return node;
    }
  }
  return null;
}

// Resolves the actual element the user clicked using elementFromPoint,
// rather than trusting event.target which in React SPAs is the delegation root.
export function resolveClickTarget(event: MouseEvent): HTMLElement {
  const eventTarget = event.target instanceof HTMLElement ? event.target : null;

  // Programmatic clicks (keyboard, .click()) set clientX=clientY=0.
  // elementFromPoint(0,0) would return the wrong top-left element.
  if (event.clientX === 0 && event.clientY === 0) {
    return eventTarget ?? document.body as HTMLElement;
  }

  // Guard: jsdom (test environment) does not implement elementFromPoint.
  if (typeof document.elementFromPoint !== "function") {
    return eventTarget ?? document.body as HTMLElement;
  }

  // First, check composedPath for a shadow-DOM-internal element. document
  // .elementFromPoint() never returns elements INSIDE shadow roots — it
  // returns the shadow host instead — so composedPath is the only way to
  // see what was actually clicked inside an overlay like LinkedIn's
  // interop-shadowdom messaging UI.
  const insideShadow = findInsideShadowFromComposedPath(event);
  if (insideShadow) return insideShadow;

  const inner = document.elementFromPoint(event.clientX, event.clientY);
  if (!inner || inner === document.body || inner === document.documentElement) {
    return eventTarget ?? document.body as HTMLElement;
  }

  // Walk UP from innermost to the first interactive ancestor,
  // but stop at event.target to avoid escaping the delegation boundary.
  let current: Element | null = inner;
  while (current instanceof HTMLElement) {
    if (isInteractiveTarget(current)) return current;
    if (current === eventTarget) return current;
    current = current.parentElement;
  }
  return eventTarget ?? (inner as HTMLElement);
}

export interface CaptureResult {
  event_type: ActionType;
  payload: Record<string, unknown>;
  page_url: string;
  page_title: string;
  timestamp: string;
}

type ElementLike = {
  tagName?: string;
  nodeName?: string;
  id?: string;
  className?: string;
  classList?: { [Symbol.iterator]?: () => IterableIterator<string> };
  textContent?: string | null;
  href?: string;
  type?: string;
  placeholder?: string;
  name?: string;
  autocomplete?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  getBoundingClientRect?: () => DOMRect;
  getRootNode?: () => unknown;
};

function isElementLike(target: unknown): target is ElementLike {
  if (!target || typeof target !== "object") return false;
  const maybe = target as ElementLike;
  return (
    typeof maybe.tagName === "string"
    || typeof maybe.nodeName === "string"
    || typeof maybe.getAttribute === "function"
  );
}

function readAttr(target: ElementLike, name: string): string {
  return String(target.getAttribute?.(name) || "").trim();
}

function readStringProp(target: ElementLike, key: keyof ElementLike): string {
  const value = target[key];
  return typeof value === "string" ? value : "";
}

function readTagName(target: ElementLike): string {
  const tag = readStringProp(target, "tagName") || readStringProp(target, "nodeName");
  return tag.toLowerCase();
}

function readRect(target: ElementLike): { x: number; y: number; width: number; height: number } | undefined {
  try {
    if (typeof target.getBoundingClientRect !== "function") return undefined;
    const rect = target.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  } catch {
    return undefined;
  }
}

function isShadowRootLike(root: unknown): boolean {
  if (!root || typeof root !== "object") return false;
  if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot) return true;
  if (Object.prototype.toString.call(root) === "[object ShadowRoot]") return true;
  const maybe = root as { nodeType?: unknown; host?: unknown };
  return maybe.nodeType === 11 && !!maybe.host;
}

function getElementMetadata(target: unknown): Record<string, unknown> {
  if (!(target instanceof Element) && !isElementLike(target)) return {};

  if (!(target instanceof Element) && isElementLike(target)) {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const activeRect = active ? active.getBoundingClientRect() : null;
    const activeChain = active ? buildSelectors(active) : [];
    const activeCss = active ? buildCssSelector(active) : undefined;
    const tag = readTagName(target) || (active?.tagName.toLowerCase() || "div");
    const rect = readRect(target) || (activeRect
      ? {
          x: Math.round(activeRect.x),
          y: Math.round(activeRect.y),
          width: Math.round(activeRect.width),
          height: Math.round(activeRect.height),
        }
      : undefined);
    const rawText = String(target.textContent || "").trim();
    const text = (rawText || active?.textContent || "").trim().slice(0, 200) || undefined;
    const root = typeof target.getRootNode === "function" ? target.getRootNode() : null;

    return {
      tag,
      id: readStringProp(target, "id") || active?.id || undefined,
      classes: active ? Array.from(active.classList) : [],
      text,
      href: readStringProp(target, "href") || undefined,
      rect,
      aria_role: readAttr(target, "role") || active?.getAttribute("role") || undefined,
      aria_label: readAttr(target, "aria-label") || active?.getAttribute("aria-label") || undefined,
      data_attrs: active ? getDataAttributes(active) : undefined,
      selector: activeCss,
      selector_chain: activeChain,
      landmark_path: active ? buildLandmarkPath(active) || undefined : undefined,
      z_index: active ? parseInt(window.getComputedStyle(active).zIndex) || undefined : undefined,
      type: readStringProp(target, "type") || readAttr(target, "type") || undefined,
      placeholder: readStringProp(target, "placeholder") || readAttr(target, "placeholder") || undefined,
      name: readStringProp(target, "name") || readAttr(target, "name") || undefined,
      in_shadow_dom: isShadowRootLike(root),
      in_iframe: window !== window.parent,
    };
  }

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
    landmark_path: buildLandmarkPath(el) || undefined,
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
  const actualTarget = resolveClickTarget(event);
  const meta = getElementMetadata(actualTarget);
  const page = getPageContext();

  // Detect shadow DOM clicks by inspecting composedPath.
  // composedPath()[0] is the innermost element; if it's inside a ShadowRoot
  // we need (a) click-position anchor and (b) intent from the shadow element.
  const path = event.composedPath ? event.composedPath() : [];
  const isShadowRootLike = (root: unknown): boolean => {
    if (!root || typeof root !== "object") return false;
    if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot) return true;
    if (Object.prototype.toString.call(root) === "[object ShadowRoot]") return true;
    const maybe = root as { nodeType?: unknown; host?: unknown };
    return maybe.nodeType === 11 && !!maybe.host;
  };

  let clickWasInShadowDom = false;
  try {
    clickWasInShadowDom = path.slice(0, 8).some((node) => {
      if (!node || typeof node !== "object") return false;
      const getRootNode = (node as { getRootNode?: () => unknown }).getRootNode;
      if (typeof getRootNode !== "function") return false;
      return isShadowRootLike(getRootNode.call(node));
    });
  } catch { /**/ }

  if (clickWasInShadowDom) {
    // 1. Replace anchor selector with click-position-based coords.
    //    Without this, all clicks inside the same shadow host share identical
    //    anchor offsets (the host's top-left), making them indistinguishable.
    const clickAnchor = buildClickPositionAnchor(actualTarget, event.clientX, event.clientY);
    if (clickAnchor) {
      const chain = meta.selector_chain as SelectorSet[];
      const idx = chain.findIndex((s) => s.type === "anchor");
      if (idx >= 0) chain[idx] = clickAnchor;
      else chain.push(clickAnchor);
      chain.sort((a, b) => (b.score || 0) - (a.score || 0));
    }
  }

  // 2. Pull accessible name/text from composedPath when available. LinkedIn's
  // interop overlay often retargets clicks to a shadow host div, so this keeps
  // intents meaningful instead of "Click on div element".
  const shadowInfo = extractShadowDomInfo(event);
  if (shadowInfo) {
    if (shadowInfo.ariaLabel) meta.aria_label = shadowInfo.ariaLabel;
    if (shadowInfo.text && !meta.text) meta.text = shadowInfo.text;
    if (shadowInfo.role && !meta.aria_role) meta.aria_role = shadowInfo.role;
  }

  const intent = buildIntent("click", meta);

  // Synchronous count of open dialogs at click time.
  const dialogs_open = document.querySelectorAll(
    '[role="dialog"],[role="alertdialog"],[aria-modal="true"]',
  ).length;

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
      dialogs_open,
    },
    page_url: page.url,
    page_title: page.title,
    timestamp: new Date().toISOString(),
  };
}

// `overrideValue` lets the caller pass a value captured at input-event time,
// bypassing the live read from target.value/textContent. Critical when the
// input gets cleared between the user typing and us actually emitting the
// event (e.g. LinkedIn's Send button clears the compose box before our 450ms
// debounce timer fires).
export function captureInput(event: Event, overrideValue?: string): CaptureResult {
  // Pierce shadow DOM retargeting: at document level, event.target is the shadow
  // HOST (outer div), not the actual input.  composedPath()[0] is the real element.
  const composedTarget = (event as { composedPath?: () => EventTarget[] }).composedPath?.()[0];
  const target = ((composedTarget ?? event.target) || {}) as ElementLike;
  const meta = getElementMetadata(target);
  const page = getPageContext();

  const tag = readTagName(target);
  const name = readStringProp(target, "name") || readAttr(target, "name");
  const placeholder = readStringProp(target, "placeholder") || readAttr(target, "placeholder");
  const inputType = (
    readStringProp(target, "type")
    || readAttr(target, "type")
  ).toLowerCase();

  if (tag === "select") {
    const selectValue = String((target as { value?: unknown }).value || "");
    const selectedOptions = (target as { selectedOptions?: ArrayLike<{ value?: string }> }).selectedOptions;
    const multiValues = selectedOptions
      ? Array.from(selectedOptions).map((o) => String(o.value || ""))
      : undefined;
    const intent = buildIntent("select", meta, selectValue, name);
    return {
      event_type: "select",
      payload: {
        target: meta,
        intent,
        selector_chain: meta.selector_chain,
        value: selectValue,
        multiple_values: multiValues,
        field_name: name || undefined,
      },
      page_url: page.url,
      page_title: page.title,
      timestamp: new Date().toISOString(),
    };
  }

  // File inputs expose only "C:\fakepath\..." in .value for security.
  // Read actual filenames from .files instead.
  let rawValue: string;
  if (typeof overrideValue === "string") {
    rawValue = overrideValue;
  } else if (inputType === "file") {
    const files = (target as { files?: ArrayLike<{ name?: string }> }).files;
    rawValue = files && files.length > 0
      ? Array.from(files).map((f) => f.name).join(", ")
      : "";
  } else if ("value" in (target as object)) {
    rawValue = String((target as { value?: unknown }).value || "");
  } else {
    rawValue = String(target.textContent || "");
  }
  const autoComplete = (
    readStringProp(target, "autocomplete")
    || readAttr(target, "autocomplete")
  ).toLowerCase();
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
  const scrollY = Math.round(window.scrollY);
  const scrollX = Math.round(window.scrollX);

  const payload: Record<string, unknown> = {
    scroll_x: scrollX,
    scroll_y: scrollY,
    viewport_height: window.innerHeight,
    viewport_width: window.innerWidth,
    document_height: document.documentElement.scrollHeight,
    // intent and value are consumed by the backend's _do_record_workflow
    // to produce a replayable scroll step without AI assistance.
    intent: `Scroll page to Y:${scrollY}`,
    value: String(scrollY),
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
  const visible = (el: Element): boolean => {
    const html = el as HTMLElement;
    const style = window.getComputedStyle(html);
    const rect = html.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      rect.width >= 20 &&
      rect.height >= 20
    );
  };

  const captchaSelectors = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="turnstile"]',
    '[data-sitekey]',
  ];
  for (const sel of captchaSelectors) {
    const el = document.querySelector(sel);
    if (el && visible(el)) {
      return { is_blocking: true, blocking_type: "captcha" };
    }
  }

  const captchaContainers = document.querySelectorAll<HTMLElement>(
    'div[class*="captcha" i], div[id*="captcha" i]',
  );
  for (const el of captchaContainers) {
    if (visible(el) && /captcha|verify you are human|not a robot/i.test(el.innerText || "")) {
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
