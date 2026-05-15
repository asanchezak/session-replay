const ERROR_RETRY_ALLOWLIST = new Set([
  "ELEMENT_NOT_FOUND", "ELEMENT_NOT_VISIBLE", "ELEMENT_UNSTABLE",
  "ELEMENT_BLOCKED", "NETWORK_ERROR",
]);

const ERROR_NO_RETRY = new Set([
  "NAVIGATION_FAILURE", "PERMISSION_DENIED", "TAB_CLOSED",
]);

export interface RetryConfig {
  maxRetries: number;
  intervalMs: number;
  onFailure: "retry" | "skip" | "abort";
}

interface RetryState {
  attempt: number;
  consecutiveFailures: number;
}

const runRetryStates = new Map<string, RetryState>();

export function getDefaultRetryConfig(): RetryConfig {
  return { maxRetries: 3, intervalMs: 1000, onFailure: "retry" };
}

export function shouldRetry(errorCode: string | undefined): boolean {
  if (!errorCode) return false;
  if (ERROR_NO_RETRY.has(errorCode)) return false;
  return ERROR_RETRY_ALLOWLIST.has(errorCode);
}

export function getBackoffDelay(attempt: number, baseMs: number): number {
  const delay = baseMs * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 500 - 250;
  return Math.max(delay + jitter, 100);
}

export function initRunState(runId: string): void {
  runRetryStates.set(runId, { attempt: 0, consecutiveFailures: 0 });
}

export function getRunState(runId: string): RetryState {
  const state = runRetryStates.get(runId);
  if (!state) {
    const newState: RetryState = { attempt: 0, consecutiveFailures: 0 };
    runRetryStates.set(runId, newState);
    return newState;
  }
  return state;
}

export function recordRetryAttempt(runId: string): void {
  const state = getRunState(runId);
  state.attempt++;
  state.consecutiveFailures++;
}

export function recordRetrySuccess(runId: string): void {
  const state = getRunState(runId);
  state.consecutiveFailures = 0;
}

export function clearRunState(runId: string): void {
  runRetryStates.delete(runId);
}

export function isCircuitBroken(runId: string, maxConsecutive: number = 5): boolean {
  const state = getRunState(runId);
  return state.consecutiveFailures >= maxConsecutive;
}

export function isBudgetExhausted(runId: string, maxTotalRetries: number = 20): boolean {
  const state = getRunState(runId);
  return state.attempt >= maxTotalRetries;
}

export async function executeWithRetry<T>(
  runId: string,
  fn: () => Promise<T>,
  shouldRetryFn: (error: unknown) => boolean,
  config: RetryConfig = getDefaultRetryConfig(),
): Promise<T> {
  let lastError: unknown;

  for (let i = 0; i <= config.maxRetries; i++) {
    if (i > 0) {
      const delay = getBackoffDelay(i, config.intervalMs);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const result = await fn();
      recordRetrySuccess(runId);
      return result;
    } catch (err) {
      lastError = err;
      if (!shouldRetryFn(err)) throw err;
      if (isCircuitBroken(runId)) throw new Error("CIRCUIT_OPEN");
      if (isBudgetExhausted(runId)) throw new Error("RETRY_BUDGET_EXHAUSTED");
      recordRetryAttempt(runId);
    }
  }

  throw lastError;
}
