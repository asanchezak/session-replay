import { describe, it, expect } from "vitest";

// Mirror of the isFatalError logic in service-worker.ts so it can be tested
// without pulling in the full Chrome extension environment.
const FATAL_ERROR_PREFIXES = ["SCRIPT_PARSE_ERROR"];
function isFatalError(err: string | null | undefined): boolean {
  return !!err && FATAL_ERROR_PREFIXES.some((p) => err.startsWith(p));
}

describe("isFatalError", () => {
  it("returns true for SCRIPT_PARSE_ERROR (CSP violation)", () => {
    expect(
      isFatalError(
        "SCRIPT_PARSE_ERROR: Evaluating a string as JavaScript violates Content Security Policy",
      ),
    ).toBe(true);
  });

  it("returns true for SCRIPT_PARSE_ERROR (syntax error)", () => {
    expect(isFatalError("SCRIPT_PARSE_ERROR: unexpected token '}'")).toBe(true);
  });

  it("returns false for SCRIPT_TIMEOUT", () => {
    expect(isFatalError("SCRIPT_TIMEOUT: took too long")).toBe(false);
  });

  it("returns false for SCRIPT_THREW", () => {
    expect(isFatalError("SCRIPT_THREW: ReferenceError: x is not defined")).toBe(false);
  });

  it("returns false for JS_CLICK_FALLBACK_NO_TARGET", () => {
    expect(isFatalError("JS_CLICK_FALLBACK_NO_TARGET:Iniciar")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isFatalError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isFatalError(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isFatalError("")).toBe(false);
  });
});
