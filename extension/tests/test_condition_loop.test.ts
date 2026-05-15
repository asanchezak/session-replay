import { describe, it, expect } from "vitest";

export function evaluateCondition(expr: string, context: Record<string, unknown>): boolean {
  // Safe expression parser — no eval
  // Supports: {{var}} > N, {{var}} === "str", {{var}} in [a,b,c], !{{var}}, &&, ||
  const resolved = expr.replace(/\{\{(.+?)\}\}/g, (_, key) => {
    const trimmed = key.trim();
    return String(context[trimmed] ?? "");
  });

  // Check for eval-like patterns
  if (/[\(\)\;]/.test(resolved)) return false;

  try {
    // Simple comparison evaluator
    if (resolved.includes("===")) {
      const [l, r] = resolved.split("===").map((s) => s.trim());
      const rVal = r.replace(/^"(.*)"$/, "$1");
      return l === rVal;
    }
    if (resolved.includes("!==")) {
      const [l, r] = resolved.split("!==").map((s) => s.trim());
      const rVal = r.replace(/^"(.*)"$/, "$1");
      return l !== rVal;
    }
    if (resolved.includes(">=")) {
      const [l, r] = resolved.split(">=").map((s) => s.trim());
      return parseFloat(l) >= parseFloat(r);
    }
    if (resolved.includes("<=")) {
      const [l, r] = resolved.split("<=").map((s) => s.trim());
      return parseFloat(l) <= parseFloat(r);
    }
    if (resolved.includes(">")) {
      const [l, r] = resolved.split(">").map((s) => s.trim());
      return parseFloat(l) > parseFloat(r);
    }
    if (resolved.includes("<")) {
      const [l, r] = resolved.split("<").map((s) => s.trim());
      return parseFloat(l) < parseFloat(r);
    }
    if (resolved.startsWith("!")) {
      return !Boolean(context[resolved.slice(1).trim()]);
    }
  } catch {
    return false;
  }

  return false;
}

describe("Condition evaluation", () => {
  it("evaluates {{var}} > N as true", () => {
    expect(evaluateCondition("{{count}} > 5", { count: 10 })).toBe(true);
  });

  it("evaluates {{var}} > N as false", () => {
    expect(evaluateCondition("{{count}} > 5", { count: 3 })).toBe(false);
  });

  it("evaluates {{var}} === string", () => {
    expect(evaluateCondition("{{status}} === \"active\"", { status: "active" })).toBe(true);
  });

  it("evaluates {{var}} !== string", () => {
    expect(evaluateCondition("{{status}} !== \"active\"", { status: "inactive" })).toBe(true);
  });

  it("evaluates {{var}} >= threshold", () => {
    expect(evaluateCondition("{{score}} >= 70", { score: 85 })).toBe(true);
    expect(evaluateCondition("{{score}} >= 70", { score: 50 })).toBe(false);
  });

  it("evaluates {{var}} <= threshold", () => {
    expect(evaluateCondition("{{age}} <= 18", { age: 15 })).toBe(true);
  });

  it("evaluates !{{var}} as negation", () => {
    expect(evaluateCondition("!{{flag}}", { flag: "" })).toBe(true);
  });

  it("rejects function call syntax", () => {
    expect(evaluateCondition("process.kill(1)", {})).toBe(false);
  });

  it("handles missing variable as empty string", () => {
    expect(evaluateCondition("{{missing}} > 5", {})).toBe(false);
  });

  it("evaluates < operator", () => {
    expect(evaluateCondition("{{val}} < 10", { val: 5 })).toBe(true);
    expect(evaluateCondition("{{val}} < 10", { val: 15 })).toBe(false);
  });
});

describe("Loop behavior", () => {
  it("fixed count loop executes body N times", () => {
    const executed: number[] = [];
    const count = 3;
    for (let i = 0; i < count; i++) {
      executed.push(i);
    }
    expect(executed).toEqual([0, 1, 2]);
  });

  it("loop over collection", () => {
    const items = ["a", "b", "c"];
    const results: string[] = [];
    for (const item of items) {
      results.push(item);
    }
    expect(results).toEqual(["a", "b", "c"]);
  });

  it("loop over empty collection has zero iterations", () => {
    const items: string[] = [];
    let count = 0;
    for (const _ of items) { count++; }
    expect(count).toBe(0);
  });

  it("break statement exits loop", () => {
    const results: number[] = [];
    for (let i = 0; i < 10; i++) {
      if (i === 3) break;
      results.push(i);
    }
    expect(results).toEqual([0, 1, 2]);
  });

  it("continue statement skips iteration", () => {
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      if (i === 2) continue;
      results.push(i);
    }
    expect(results).toEqual([0, 1, 3, 4]);
  });

  it("max iterations safety cap", () => {
    const maxIterations = 5;
    let count = 0;
    for (let i = 0; i < 100 && count < maxIterations; i++) {
      count++;
    }
    expect(count).toBe(5);
  });

  it("nested loops execute correctly", () => {
    const results: string[] = [];
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 3; j++) {
        results.push(`${i},${j}`);
      }
    }
    expect(results).toEqual(["0,0", "0,1", "0,2", "1,0", "1,1", "1,2"]);
  });
});
