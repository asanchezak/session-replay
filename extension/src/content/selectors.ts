import type { SelectorSet } from "../shared/types";

export const STABLE_ATTRS = ["data-testid", "data-qa", "data-cy", "data-test", "name", "aria-label"];

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

export function computeSelectorScore(type: string, el: HTMLElement): number {
  switch (type) {
    case "css": {
      const stable = getStableAttribute(el);
      if (stable) {
        const [attr] = stable;
        if (["data-testid", "data-qa", "data-cy", "data-test"].includes(attr)) return 0.95;
        if (attr === "aria-label") return 0.85;
        if (attr === "id") return 0.80;
        if (attr === "name") return 0.75;
        if (attr === "role") return 0.65;
      }
      const sibs = countSameTagSiblings(el);
      if (sibs > 1) return 0.30;
      return 0.50;
    }
    case "text":
      return 0.70;
    case "accessibility": {
      const role = el.getAttribute("role");
      const label = el.getAttribute("aria-label");
      if (role && label) return 0.85;
      if (role) return 0.65;
      return 0.50;
    }
    case "xpath":
      return 0.20;
    default:
      return 0.10;
  }
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

export interface PatternInfo {
  parentSelector: string;
  siblingTag: string;
  siblingCount: number;
  childIndex: number;
  structureHash: string;
}

export function detectPattern(el: Element): PatternInfo | null {
  if (!(el instanceof HTMLElement)) return null;
  const parent = el.parentElement;
  if (!parent) return null;

  const tag = el.tagName.toLowerCase();
  const siblings = Array.from(parent.children).filter(
    (c) => c.tagName.toLowerCase() === tag,
  );

  if (siblings.length < 3) return null;

  const index = siblings.indexOf(el);
  if (index === -1) return null;

  const parentSelector = parent.id
    ? `#${parent.id}`
    : parent.className
      ? `.${parent.className.split(" ")[0]}`
      : parent.tagName.toLowerCase();

  return {
    parentSelector: `${parentSelector} > ${tag}`,
    siblingTag: tag,
    siblingCount: siblings.length,
    childIndex: index,
    structureHash: `${tag}-${siblings.length}-${tag}`,
  };
}

const ANCHOR_RELATIONS = ["below", "above", "left", "right", "inside"] as const;
type AnchorRelation = typeof ANCHOR_RELATIONS[number];

export function buildAnchorSelector(el: HTMLElement): SelectorSet | null {
  const parent = el.parentElement;
  if (!parent) return null;

  const anchorEl = findNearestStableAncestor(el);
  if (!anchorEl) return null;

  const anchorSelector = buildCssSelector(anchorEl);
  if (!anchorSelector) return null;

  const elRect = el.getBoundingClientRect();
  const anchorRect = anchorEl.getBoundingClientRect();

  let relation: AnchorRelation = "inside";
  const dy = elRect.top - anchorRect.bottom;
  const dx = elRect.left - anchorRect.right;

  if (dy > 0) relation = "below";
  else if (Math.abs(dy) < anchorRect.height && dx > 0) relation = "right";
  else if (Math.abs(dy) < anchorRect.height && dx < -elRect.width) relation = "left";
  else if (-dy > elRect.height) relation = "above";

  const value = JSON.stringify({
    anchor_selector: anchorSelector,
    relation,
    offset_x: Math.round(elRect.left - anchorRect.left),
    offset_y: Math.round(elRect.top - anchorRect.top),
  });

  return { type: "anchor", value, score: 0.55 };
}

function findNearestStableAncestor(el: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = el.parentElement;
  let depth = 0;
  while (current && current !== document.body && current !== document.documentElement && depth < 5) {
    if (current.id || current.getAttribute("data-testid") || current.getAttribute("role")) {
      return current;
    }
    current = current.parentElement;
    depth++;
  }
  return null;
}

export function buildSelectors(el: HTMLElement): SelectorSet[] {
  const chain: SelectorSet[] = [];

  const a11y = buildAccessibilitySelector(el);
  if (a11y) chain.push({ type: "accessibility", value: a11y, score: computeSelectorScore("accessibility", el) });

  const css = buildCssSelector(el);
  if (css) chain.push({ type: "css", value: css, score: computeSelectorScore("css", el) });

  const text = buildTextSelector(el);
  if (text) chain.push({ type: "text", value: text, score: computeSelectorScore("text", el) });

  const xpath = buildXPathSelector(el);
  chain.push({ type: "xpath", value: xpath, score: computeSelectorScore("xpath", el) });

  const anchor = buildAnchorSelector(el);
  if (anchor) chain.push(anchor);

  chain.sort((a, b) => (b.score || 0) - (a.score || 0));
  return chain;
}
