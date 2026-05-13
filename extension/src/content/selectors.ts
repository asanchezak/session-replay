import type { SelectorSet } from "../shared/types";

const STABLE_ATTRS = ["data-testid", "data-qa", "data-cy", "data-test", "name", "aria-label"];

const FRAMEWORK_ATTR_PREFIXES = ["data-react", "data-v-", "data-svelte-", "data-ng-", "data-debug", "data-server-rendered"];

function isFrameworkAttr(name: string): boolean {
  return FRAMEWORK_ATTR_PREFIXES.some((p) => name.startsWith(p));
}

function getStableAttribute(el: HTMLElement): [string, string] | null {
  if (el.id) return ["id", el.id];
  for (const attr of STABLE_ATTRS) {
    const val = el.getAttribute(attr);
    if (val) return [attr, val];
  }
  const role = el.getAttribute("role");
  if (role) return ["role", role];
  return null;
}

function escapeCssValue(val: string): string {
  return CSS.escape(val);
}

function countSameTagSiblings(el: HTMLElement): number {
  const parentEl = el.parentElement;
  if (!parentEl) return 0;
  const tag = el.tagName.toLowerCase();
  const children = Array.from(parentEl.children) as HTMLElement[];
  return children.filter((s) => s.tagName.toLowerCase() === tag).length;
}

function siblingIndex(el: HTMLElement): number {
  const parentEl = el.parentElement;
  if (!parentEl) return 1;
  const tag = el.tagName.toLowerCase();
  const siblings = Array.from(parentEl.children) as HTMLElement[];
  const filtered = siblings.filter((s) => s.tagName.toLowerCase() === tag);
  return filtered.indexOf(el) + 1;
}

export function buildCssSelector(el: HTMLElement): string {
  if (el.id) return `#${CSS.escape(el.id)}`;

  const stable = getStableAttribute(el);
  if (stable) {
    const [attr, val] = stable;
    return `${el.tagName.toLowerCase()}[${attr}="${escapeCssValue(val)}"]`;
  }

  const parts: string[] = [];
  let current: HTMLElement | null = el;
  while (current && current !== document.body && current !== document.documentElement) {
    let segment = current.tagName.toLowerCase();
    const sibs = countSameTagSiblings(current);
    if (sibs > 1) {
      segment += `:nth-of-type(${siblingIndex(current)})`;
    }
    parts.unshift(segment);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

export function buildTextSelector(el: HTMLElement): string | null {
  const TEXT_TAGS = new Set([
    "a", "button", "h1", "h2", "h3", "h4", "h5", "h6",
    "label", "span", "li", "td", "th", "p", "div",
  ]);
  if (!TEXT_TAGS.has(el.tagName.toLowerCase())) return null;

  const text = el.textContent || "";
  const trimmed = text.trim();
  if (!trimmed || trimmed.length === 0) return null;
  if (trimmed.length > 200) return null;

  return trimmed.replace(/\s+/g, " ");
}

export function buildAccessibilitySelector(el: HTMLElement): string | null {
  const role = el.getAttribute("role");
  const label = el.getAttribute("aria-label");
  if (!role && !label) return null;
  return JSON.stringify([role || "", label || ""]);
}

export function buildXPathSelector(el: HTMLElement): string {
  const parts: string[] = [];
  let current: HTMLElement | null = el;

  while (current && current !== document.documentElement) {
    const tag = current.tagName.toLowerCase();
    const pEl: HTMLElement | null = current.parentElement;
    if (pEl) {
      const children = Array.from(pEl.children) as HTMLElement[];
      const sameTagSiblings = children.filter((s) => s.tagName.toLowerCase() === tag);
      if (sameTagSiblings.length > 1) {
        const index = sameTagSiblings.indexOf(current) + 1;
        parts.unshift(`${tag}[${index}]`);
      } else {
        parts.unshift(tag);
      }
    } else {
      parts.unshift(tag);
    }
    current = pEl;
  }
  parts.unshift("html");
  return "/" + parts.join("/");
}

export function buildSelectors(el: HTMLElement): SelectorSet[] {
  const chain: SelectorSet[] = [];

  const css = buildCssSelector(el);
  if (css) chain.push({ type: "css", value: css });

  const text = buildTextSelector(el);
  if (text) chain.push({ type: "text", value: text });

  const a11y = buildAccessibilitySelector(el);
  if (a11y) chain.push({ type: "accessibility", value: a11y });

  const xpath = buildXPathSelector(el);
  chain.push({ type: "xpath", value: xpath });

  return chain;
}
