/**
 * Vitest setup for the frontend.
 *
 * - Registers `@testing-library/jest-dom` matchers.
 * - Provides a default `fetch` mock so component tests don't accidentally
 *   hit a real network.
 * - Cleans up after each test (RTL's auto-cleanup is off here).
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

beforeEach(() => {
  // Default: empty array from /v1/workflows, /v1/runs etc.
  // Individual tests can override with vi.spyOn(global, "fetch").
  (global as any).fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => [],
    text: async () => "[]",
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
