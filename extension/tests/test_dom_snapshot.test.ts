import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

if (typeof CSS === "undefined") (globalThis as any).CSS = {};
(CSS as any).escape = (v: string) => v.replace(/[!"#$%&'()*+,./:;<=>?@[\]^`{|}~\\]/g, "\\$&");

globalThis.chrome = {
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  tabs: { query: vi.fn(), sendMessage: vi.fn() },
  storage: { session: { get: vi.fn(), set: vi.fn(), onChanged: { addListener: vi.fn() } } },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
} as any;

function setBody(html: string) {
  document.body.innerHTML = html;
}

describe("sanitizeNode", () => {
  beforeEach(() => { setBody(""); });

  it("removes script tags", async () => {
    const { sanitizeNode } = await import("../src/content/dom");
    setBody("<div><script>alert(1)</script></div>");
    const result = sanitizeNode(document.body);
    expect(result).not.toContain("script");
  });

  it("removes style tags", async () => {
    const { sanitizeNode } = await import("../src/content/dom");
    setBody("<div><style>body{color:red}</style></div>");
    const result = sanitizeNode(document.body);
    expect(result).not.toContain("style");
  });

  it("removes iframe tags", async () => {
    const { sanitizeNode } = await import("../src/content/dom");
    setBody("<div><iframe src='https://evil.com'></iframe></div>");
    const result = sanitizeNode(document.body);
    expect(result).not.toContain("iframe");
  });

  it("preserves semantic attributes", async () => {
    const { sanitizeNode } = await import("../src/content/dom");
    setBody('<button id="btn" class="primary" role="button" aria-label="Submit">Go</button>');
    const result = sanitizeNode(document.body);
    expect(result).toContain('id="btn"');
    expect(result).toContain('class="primary"');
    expect(result).toContain('role="button"');
  });

  it("respects max depth of 10", async () => {
    const { sanitizeNode } = await import("../src/content/dom");
    let inner = "<span>deep</span>";
    for (let i = 0; i < 15; i++) inner = `<div>${inner}</div>`;
    setBody(inner);
    const result = sanitizeNode(document.body);
    expect(result.length).toBeLessThan(5000);
  });

  it("removes value attributes", async () => {
    const { sanitizeNode } = await import("../src/content/dom");
    setBody('<input type="text" value="secret">');
    const result = sanitizeNode(document.body);
    expect(result).not.toContain('value="secret"');
    expect(result).toContain('type="text"');
  });

  it("strips framework data attributes", async () => {
    const { sanitizeNode } = await import("../src/content/dom");
    setBody('<div data-react-root="app" data-testid="keep">hello</div>');
    const result = sanitizeNode(document.body);
    expect(result).not.toContain("data-react-root");
    expect(result).toContain("data-testid");
  });
});

describe("redactPII", () => {
  it("redacts email addresses", async () => {
    const { redactPII } = await import("../src/content/dom");
    expect(redactPII("user@example.com")).toContain("[REDACTED]");
  });

  it("redacts phone numbers", async () => {
    const { redactPII } = await import("../src/content/dom");
    expect(redactPII("555-123-4567")).toContain("[REDACTED]");
  });

  it("redacts credit card numbers", async () => {
    const { redactPII } = await import("../src/content/dom");
    expect(redactPII("4111-1111-1111-1111")).toContain("[REDACTED]");
  });

  it("preserves non-PII text", async () => {
    const { redactPII } = await import("../src/content/dom");
    expect(redactPII("Hello world")).toBe("Hello world");
  });
});

describe("captureDomSnippet", () => {
  beforeEach(() => { setBody(""); });

  it("captures body content", async () => {
    const { captureDomSnippet } = await import("../src/content/dom");
    setBody("<div>hello</div>");
    const result = captureDomSnippet();
    expect(result.html).toContain("hello");
  });

  it("returns empty html when body is null", async () => {
    const { captureDomSnippet } = await import("../src/content/dom");
    const origBody = document.body;
    document.body.remove();
    const result = captureDomSnippet();
    expect(result.html).toBe("");
    document.documentElement.appendChild(origBody);
  });

  it("captures using specific selector", async () => {
    const { captureDomSnippet } = await import("../src/content/dom");
    setBody('<div id="target"><span>only this</span></div><div>not this</div>');
    const result = captureDomSnippet("#target");
    expect(result.html).toContain("only this");
    expect(result.html).not.toContain("not this");
  });

  it("truncates to 4000 chars", async () => {
    const { captureDomSnippet } = await import("../src/content/dom");
    setBody("<div>" + "x".repeat(5000) + "</div>");
    const result = captureDomSnippet();
    expect(result.html.length).toBeLessThanOrEqual(4100);
  });
});
