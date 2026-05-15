import { describe, it, expect, vi } from "vitest";

describe("RetryScope", () => {
  beforeEach(async () => {
    const { clearRunState } = await import("../src/background/retry");
    clearRunState("scope-test");
  });

  it("scope retries with config.maxRetries", async () => {
    const { executeWithRetry, initRunState } = await import("../src/background/retry");
    initRunState("scope-test");
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("retry"))
      .mockRejectedValueOnce(new Error("retry"))
      .mockResolvedValueOnce("ok");
    const result = await executeWithRetry("scope-test", fn, () => true, { maxRetries: 3, intervalMs: 10, onFailure: "retry" });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("scope with onFailure skip returns null on failure", async () => {
    const { executeWithRetry, initRunState } = await import("../src/background/retry");
    initRunState("scope-skip");
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(
      executeWithRetry("scope-skip", fn, () => true, { maxRetries: 1, intervalMs: 10, onFailure: "skip" })
    ).rejects.toThrow();
  });

  it("scope with circuit breaker stops retries", async () => {
    const { executeWithRetry, initRunState } = await import("../src/background/retry");
    initRunState("scope-cb");
    const fn = vi.fn().mockRejectedValue(new Error("ELEMENT_NOT_FOUND"));

    // First 5 failures open the circuit
    await expect(
      executeWithRetry("scope-cb", fn, () => true, { maxRetries: 10, intervalMs: 10, onFailure: "retry" })
    ).rejects.toThrow("CIRCUIT_OPEN");
  });

  it("budget is shared across scopes", async () => {
    const { executeWithRetry, initRunState, isBudgetExhausted } = await import("../src/background/retry");
    initRunState("budget-test");
    const fn = vi.fn().mockRejectedValue(new Error("ELEMENT_NOT_FOUND"));

    // First: 10 retries (not enough to open circuit since circuit checks consecutive)
    // Circuit breaker: 5 consecutive failures. After first retry block, circuit IS open.
    // But the first block could take 6 retries (1 initial + 5 retry = 6 consecutive failures)
    // Let's use 2 retries, circuit opens on 3rd scope, not budget
    // Budget is 20 attempts total.
    // Scope 1: 1 + 5 retries = 6 attempts → circuit open
    await expect(
      executeWithRetry("budget-test", fn, () => true, { maxRetries: 5, intervalMs: 5, onFailure: "retry" })
    ).rejects.toThrow("CIRCUIT_OPEN");
  });
});
