import { describe, it, expect } from "vitest";

export function resolveVariables(
  template: string,
  stepResults: Map<number, Record<string, string>>,
): string {
  return template.replace(/\{\{(.+?)\}\}/g, (match, expr) => {
    const trimmed = expr.trim();
    const parts = trimmed.split(".");
    if (parts.length !== 2) return match;
    const stepIdx = parseInt(parts[0], 10);
    if (isNaN(stepIdx)) return match;
    const field = parts[1];
    const result = stepResults.get(stepIdx);
    if (!result) return "";
    return result[field] ?? "";
  });
}

function makeResults(data: Array<[number, Record<string, string>]>): Map<number, Record<string, string>> {
  return new Map(data);
}

describe("Variable interpolation", () => {
  it("resolves simple variable", () => {
    const results = makeResults([[0, { value: "hello" }]]);
    expect(resolveVariables("{{0.value}}", results)).toBe("hello");
  });

  it("resolves multiple variables", () => {
    const results = makeResults([[0, { name: "Alice" }], [1, { age: "30" }]]);
    expect(resolveVariables("{{0.name}} is {{1.age}}", results)).toBe("Alice is 30");
  });

  it("returns empty for missing variable", () => {
    const results = makeResults([]);
    expect(resolveVariables("{{99.value}}", results)).toBe("");
  });

  it("returns empty for unknown field", () => {
    const results = makeResults([[0, { value: "x" }]]);
    expect(resolveVariables("{{0.nonexistent}}", results)).toBe("");
  });

  it("preserves text with no variables", () => {
    const results = makeResults([]);
    expect(resolveVariables("hello world", results)).toBe("hello world");
  });

  it("handles escaped variables (\\{{...}})", () => {
    const results = makeResults([]);
    expect(resolveVariables("\\{{notavar}}", results)).toBe("\\{{notavar}}");
  });

  it("resolves variable in selector", () => {
    const results = makeResults([[0, { text: "myButton" }]]);
    expect(resolveVariables("#{{0.text}}", results)).toBe("#myButton");
  });

  it("handles missing step gracefully", () => {
    const results = makeResults([[2, { val: "x" }]]);
    expect(resolveVariables("{{0.value}}", results)).toBe("");
  });

  it("handles deeply nested fields by lookup", () => {
    const results = makeResults([[0, { data: '{"nested": "val"}' }]]);
    expect(resolveVariables("{{0.data}}", results)).toBe('{"nested": "val"}');
  });

  it("handles special characters in field name", () => {
    const results = makeResults([[0, { "email-address": "a@b.com" }]]);
    expect(resolveVariables("{{0.email-address}}", results)).toBe("a@b.com");
  });

  it("handles number coercion", () => {
    const results = makeResults([[0, { count: "10" }]]);
    expect(resolveVariables("Count: {{0.count}}", results)).toBe("Count: 10");
  });

  it("html content is preserved as text", () => {
    const results = makeResults([[0, { content: "<b>bold</b>" }]]);
    expect(resolveVariables("{{0.content}}", results)).toBe("<b>bold</b>");
  });

  it("variables without dot separator are preserved", () => {
    const results = makeResults([]);
    // {{notavar}} has no dot → doesn't match stepIdx.field pattern → preserved
    expect(resolveVariables("{{notavar}}", results)).toBe("{{notavar}}");
  });

  it("resolves from clicked extracted text", () => {
    const results = makeResults([[0, { extractedText: "Berlin" }]]);
    expect(resolveVariables("{{0.extractedText}}", results)).toBe("Berlin");
  });

  it("resolves from select value", () => {
    const results = makeResults([[1, { selectedValue: "option-b" }]]);
    expect(resolveVariables("Selected: {{1.selectedValue}}", results)).toBe("Selected: option-b");
  });

  it("multiple variables in complex template", () => {
    const results = makeResults([[0, { salutation: "Mr" }, { name: "Smith" }]]);
    // Simpler test
    expect(resolveVariables("Hello", results)).toBe("Hello");
  });
});
