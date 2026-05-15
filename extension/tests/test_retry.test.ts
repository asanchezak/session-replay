import { describe, it, expect, beforeEach, vi } from "vitest";

describe("Retry utilities", () => {
  beforeEach(async () => {
    const { clearRunState } = await import("../src/background/retry");
    clearRunState("test-run");
  });

  it("shouldRetry returns true for transient errors", async () => {
    const { shouldRetry } = await import("../src/background/retry");
    expect(shouldRetry("ELEMENT_NOT_FOUND")).toBe(true);
    expect(shouldRetry("NETWORK_ERROR")).toBe(true);
  });

  it("shouldRetry returns false for permanent errors", async () => {
    const { shouldRetry } = await import("../src/background/retry");
    expect(shouldRetry("NAVIGATION_FAILURE")).toBe(false);
    expect(shouldRetry("PERMISSION_DENIED")).toBe(false);
    expect(shouldRetry("TAB_CLOSED")).toBe(false);
  });

  it("shouldRetry returns false for undefined error", async () => {
    const { shouldRetry } = await import("../src/background/retry");
    expect(shouldRetry(undefined)).toBe(false);
  });

  it("getBackoffDelay increases with attempt number", async () => {
    const { getBackoffDelay } = await import("../src/background/retry");
    const d1 = getBackoffDelay(1, 1000);
    const d2 = getBackoffDelay(2, 1000);
    const d3 = getBackoffDelay(3, 1000);
    expect(d2 > d1).toBe(true);
    expect(d3 > d2).toBe(true);
  });

  it("getBackoffDelay never goes below 100ms", async () => {
    const { getBackoffDelay } = await import("../src/background/retry");
    const delay = getBackoffDelay(1, 10);
    expect(delay).toBeGreaterThanOrEqual(100);
  });

  it("initRunState creates clean state", async () => {
    const { initRunState, getRunState } = await import("../src/background/retry");
    initRunState("test-1");
    const state = getRunState("test-1");
    expect(state.attempt).toBe(0);
    expect(state.consecutiveFailures).toBe(0);
  });

  it("recordRetryAttempt increments counters", async () => {
    const { initRunState, getRunState, recordRetryAttempt } = await import("../src/background/retry");
    initRunState("test-2");
    recordRetryAttempt("test-2");
    recordRetryAttempt("test-2");
    const state = getRunState("test-2");
    expect(state.attempt).toBe(2);
    expect(state.consecutiveFailures).toBe(2);
  });

  it("recordRetrySuccess resets consecutive failures", async () => {
    const { initRunState, recordRetryAttempt, recordRetrySuccess, getRunState } = await import("../src/background/retry");
    initRunState("test-3");
    recordRetryAttempt("test-3");
    recordRetrySuccess("test-3");
    const state = getRunState("test-3");
    expect(state.consecutiveFailures).toBe(0);
    expect(state.attempt).toBe(1);
  });

  it("isCircuitBroken returns true after 5 consecutive failures", async () => {
    const { initRunState, recordRetryAttempt, isCircuitBroken } = await import("../src/background/retry");
    initRunState("test-4");
    for (let i = 0; i < 5; i++) recordRetryAttempt("test-4");
    expect(isCircuitBroken("test-4")).toBe(true);
  });

  it("isCircuitBroken returns false after success resets", async () => {
    const { initRunState, recordRetryAttempt, recordRetrySuccess, isCircuitBroken } = await import("../src/background/retry");
    initRunState("test-5");
    for (let i = 0; i < 5; i++) recordRetryAttempt("test-5");
    recordRetrySuccess("test-5");
    expect(isCircuitBroken("test-5")).toBe(false);
  });

  it("isBudgetExhausted returns true after 20 attempts", async () => {
    const { initRunState, recordRetryAttempt, isBudgetExhausted } = await import("../src/background/retry");
    initRunState("test-6");
    for (let i = 0; i < 20; i++) recordRetryAttempt("test-6");
    expect(isBudgetExhausted("test-6")).toBe(true);
  });

  it("executeWithRetry succeeds on first attempt", async () => {
    const { executeWithRetry, initRunState } = await import("../src/background/retry");
    initRunState("test-7");
    const fn = vi.fn().mockResolvedValue("success");
    const result = await executeWithRetry("test-7", fn, () => true);
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("executeWithRetry retries on failure", async () => {
    const { executeWithRetry, initRunState } = await import("../src/background/retry");
    initRunState("test-8");
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("ELEMENT_NOT_FOUND"))
      .mockRejectedValueOnce(new Error("ELEMENT_NOT_FOUND"))
      .mockResolvedValueOnce("success");
    const result = await executeWithRetry("test-8", fn, () => true);
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("executeWithRetry throws after exhausting retries", async () => {
    const { executeWithRetry, initRunState } = await import("../src/background/retry");
    initRunState("test-9");
    const fn = vi.fn().mockRejectedValue(new Error("ELEMENT_NOT_FOUND"));
    await expect(executeWithRetry("test-9", fn, () => true, { maxRetries: 1, intervalMs: 10, onFailure: "retry" })).rejects.toThrow("ELEMENT_NOT_FOUND");
  });

  it("executeWithRetry does not retry if shouldRetryFn returns false", async () => {
    const { executeWithRetry, initRunState } = await import("../src/background/retry");
    initRunState("test-10");
    const fn = vi.fn().mockRejectedValue(new Error("NAVIGATION_FAILURE"));
    await expect(executeWithRetry("test-10", fn, () => false)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
