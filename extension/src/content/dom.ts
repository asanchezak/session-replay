export const FRAMEWORK_ATTR_PREFIXES = [
  "data-react", "data-v-", "data-svelte-", "data-ng-", "data-debug", "data-server-rendered",
];

export const PII_PATTERNS = [
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
  /\b[^\s@]+@[^\s@]+\.[^\s]{2,}\b/g,
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  /\+\d{1,4}[-.\s]?\d{6,14}\b/g,
  /\b\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}\b/g,
  /\b3[47]\d{2}[-.\s]?\d{6}[-.\s]?\d{5}\b/g,
  /\b4\d{2}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{1}\b/g,
  /\b\d{3}-\d{2}-\d{4}\b/g,
];

export function isFrameworkAttr(name: string): boolean {
  return FRAMEWORK_ATTR_PREFIXES.some((p) => name.startsWith(p));
}

export function sanitizeNode(node: Node, depth: number = 0): string {
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

export function redactPII(text: string): string {
  let result = text;
  for (const pattern of PII_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

export function captureDomSnippet(selectorPattern?: string): { html: string; url: string; title: string } {
  let target: Element | null = null;
  if (selectorPattern) {
    try {
      target = document.querySelector(selectorPattern);
    } catch {
      // Invalid selector, try body
    }
  }
  const root = target || document.body;
  if (!root) return { html: "", url: window.location.href, title: document.title };
  const html = redactPII(sanitizeNode(root));
  return {
    html: html.slice(0, 4000),
    url: window.location.href,
    title: document.title,
  };
}

export function captureFullDomSnapshot(): { html: string; url: string; title: string; node_count: number } {
  const result = captureDomSnippet();
  const count = document.querySelectorAll("*").length;
  return { ...result, node_count: count };
}

export async function captureDomWithDelay(delayMs: number = 0): Promise<{ html: string; url: string; title: string }> {
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  return captureDomSnippet();
}
